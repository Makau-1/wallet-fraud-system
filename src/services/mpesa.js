// M-Pesa deposits by STK push (version 3).
//
// The user enters an amount and their phone number; M-Pesa shows a prompt
// on the phone; when they enter their M-Pesa PIN, Safaricom calls back and
// the wallet is credited.
//
// Two modes (MPESA_MODE):
//   simulator  (default) no Safaricom account needed. The website shows the
//              phone prompt itself, and accepting or cancelling it sends a
//              callback in exactly the shape Daraja sends.
//   sandbox    the real Safaricom Daraja sandbox. Needs MPESA_CONSUMER_KEY,
//              MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY and a
//              public HTTPS address (PUBLIC_URL) for the callback, so it
//              works once the system is deployed.
//
// Daraja does not sign callbacks, so the callback URL carries a secret
// token (MPESA_CALLBACK_TOKEN), and a callback is accepted only for a
// request that is still pending and only for the amount that was asked
// for. A callback is processed once; repeats are ignored.
//
// Endpoints used (Daraja sandbox):
//   GET  /oauth/v1/generate?grant_type=client_credentials   (Basic auth)
//   POST /mpesa/stkpush/v1/processrequest
//   POST /mpesa/stkpushquery/v1/query

const crypto = require('crypto');
const db = require('../config/db');
const events = require('./events');
const { ServiceError, withTransaction, credit } = require('./ledger');

const DARAJA = process.env.MPESA_BASE_URL || 'https://sandbox.safaricom.co.ke';
const MAX_AMOUNT = 150000;
let token = { value: null, expires: 0 };

function mode() {
    return process.env.MPESA_MODE === 'sandbox' ? 'sandbox' : 'simulator';
}

// Without MPESA_CALLBACK_TOKEN the callback address gets a random token
// that changes on every restart, so no guessable default can be used to
// forge a payment. The sandbox refuses to start without a real one.
const RANDOM_TOKEN = crypto.randomBytes(24).toString('hex');

function callbackToken() {
    return process.env.MPESA_CALLBACK_TOKEN || RANDOM_TOKEN;
}

function timestamp(date = new Date()) {
    // Daraja expects East Africa Time, YYYYMMDDHHmmss.
    const eat = new Date(date.getTime() + 3 * 3600 * 1000);
    return eat.toISOString().replace(/[-T:]/g, '').slice(0, 14);
}

async function accessToken() {
    if (token.value && Date.now() < token.expires) return token.value;
    const basic = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
    const response = await fetch(`${DARAJA}/oauth/v1/generate?grant_type=client_credentials`, {
        headers: { Authorization: `Basic ${basic}` }, signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new ServiceError(502, 'Could not connect to M-Pesa. Try again later.');
    const data = await response.json();
    token = { value: data.access_token, expires: Date.now() + (Number(data.expires_in || 3599) - 60) * 1000 };
    return token.value;
}

async function stkPush({ phone, amount, reference }) {
    const shortcode = process.env.MPESA_SHORTCODE;
    const ts = timestamp();
    const password = Buffer.from(`${shortcode}${process.env.MPESA_PASSKEY}${ts}`).toString('base64');
    const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
    if ((process.env.MPESA_CALLBACK_TOKEN || '').length < 32) {
        throw new ServiceError(503, 'M-Pesa sandbox needs MPESA_CALLBACK_TOKEN set to a random string of at least 32 characters');
    }
    if (!publicUrl.startsWith('https://')) {
        throw new ServiceError(503, 'M-Pesa sandbox needs PUBLIC_URL set to the site\'s https address');
    }
    const response = await fetch(`${DARAJA}/mpesa/stkpush/v1/processrequest`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            BusinessShortCode: shortcode,
            Password: password,
            Timestamp: ts,
            TransactionType: 'CustomerPayBillOnline',
            Amount: amount,
            PartyA: phone,
            PartyB: shortcode,
            PhoneNumber: phone,
            CallBackURL: `${publicUrl}/api/mpesa/callback/${callbackToken()}`,
            AccountReference: reference.slice(0, 12),
            TransactionDesc: 'Wallet deposit',
        }),
        signal: AbortSignal.timeout(15000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || String(data.ResponseCode) !== '0') {
        throw new ServiceError(502, data.errorMessage || data.ResponseDescription || 'M-Pesa did not accept the request');
    }
    return data;
}

async function start(userId, { amount, phone }) {
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT) {
        throw new ServiceError(400, `M-Pesa deposits are whole shillings from 1 to ${MAX_AMOUNT.toLocaleString('en-US')}`);
    }
    const [users] = await db.execute(
        'SELECT u.id, u.phone, w.id AS wallet_id FROM users u JOIN wallets w ON w.user_id = u.id WHERE u.id = ?', [userId]);
    const user = users[0];
    const payments = require('./payments');
    const number = phone ? payments.phoneKey(phone) : user.phone;
    if (!number) throw new ServiceError(400, 'Enter the M-Pesa number to charge, such as 0712345678');

    const [pending] = await db.execute(
        "SELECT COUNT(*) AS n FROM mpesa_requests WHERE user_id = ? AND status = 'pending' AND created_at >= DATE_SUB(NOW(), INTERVAL 2 MINUTE)",
        [userId]);
    if (Number(pending[0].n) > 0) throw new ServiceError(409, 'Finish or cancel the M-Pesa prompt already on your phone first');

    const [created] = await db.execute(
        'INSERT INTO mpesa_requests (user_id, wallet_id, phone, amount, mode) VALUES (?, ?, ?, ?, ?)',
        [userId, user.wallet_id, number, amount, mode()]);
    const requestId = created.insertId;
    let ids;
    if (mode() === 'sandbox') {
        try {
            const data = await stkPush({ phone: number, amount, reference: `SW${requestId}` });
            ids = { merchant: data.MerchantRequestID, checkout: data.CheckoutRequestID, message: data.CustomerMessage };
        } catch (error) {
            await db.execute("UPDATE mpesa_requests SET status = 'failed', result_desc = ? WHERE id = ?", [error.message.slice(0, 250), requestId]);
            throw error;
        }
    } else {
        const stamp = timestamp();
        ids = {
            merchant: `${crypto.randomInt(10000, 99999)}-${crypto.randomInt(1000000, 9999999)}-1`,
            checkout: `ws_CO_${stamp.slice(2)}${crypto.randomInt(100000000, 999999999)}`,
            message: 'Success. Request accepted for processing',
        };
    }
    await db.execute('UPDATE mpesa_requests SET merchant_request_id = ?, checkout_request_id = ? WHERE id = ?',
        [ids.merchant, ids.checkout, requestId]);
    return { id: requestId, checkoutRequestId: ids.checkout, mode: mode(), phone: number, amount, customerMessage: ids.message };
}

// Handles a callback body shaped like Daraja's:
//   { Body: { stkCallback: { MerchantRequestID, CheckoutRequestID, ResultCode,
//     ResultDesc, CallbackMetadata: { Item: [{ Name, Value }] } } } }
async function processCallback(body) {
    const cb = body && body.Body && body.Body.stkCallback;
    if (!cb || !cb.CheckoutRequestID) return { accepted: false, reason: 'Not an STK callback' };
    const items = (cb.CallbackMetadata && Array.isArray(cb.CallbackMetadata.Item)) ? cb.CallbackMetadata.Item : [];
    const value = name => (items.find(i => i.Name === name) || {}).Value;

    const notice = [];
    const outcome = await withTransaction(async (connection) => {
        const [rows] = await connection.execute(
            'SELECT * FROM mpesa_requests WHERE checkout_request_id = ? FOR UPDATE', [cb.CheckoutRequestID]);
        if (!rows.length) return { accepted: false, reason: 'Unknown request' };
        const request = rows[0];
        if (request.status !== 'pending') return { accepted: true, duplicate: true };
        const code = Number(cb.ResultCode);
        if (code === 0) {
            const paid = Number(value('Amount'));
            if (Math.round(paid * 100) !== Math.round(Number(request.amount) * 100)) {
                await connection.execute("UPDATE mpesa_requests SET status = 'failed', result_code = ?, result_desc = ? WHERE id = ?",
                    [code, `Amount mismatch: asked ${request.amount}, callback ${paid}`, request.id]);
                return { accepted: false, reason: 'Amount mismatch' };
            }
            const receipt = String(value('MpesaReceiptNumber') || '').slice(0, 32);
            const moved = await credit(connection, request.wallet_id, Number(request.amount), {
                type: 'mpesa_deposit', receipt, phone: request.phone, mpesa_request_id: request.id,
            });
            await connection.execute(
                "UPDATE mpesa_requests SET status = 'success', result_code = 0, result_desc = ?, receipt = ?, transaction_id = ? WHERE id = ?",
                [String(cb.ResultDesc || '').slice(0, 255), receipt, moved.transactionId, request.id]);
            notice.push({ userId: request.user_id, kind: 'mpesa_deposit', title: `KES ${Number(request.amount).toFixed(2)} deposited from M-Pesa`, body: `Receipt ${receipt}` });
            return { accepted: true, credited: true, transactionId: moved.transactionId };
        }
        await connection.execute("UPDATE mpesa_requests SET status = 'failed', result_code = ?, result_desc = ? WHERE id = ?",
            [code, String(cb.ResultDesc || '').slice(0, 255), request.id]);
        notice.push({ userId: request.user_id, kind: 'mpesa_failed', title: 'M-Pesa deposit not completed', body: cb.ResultDesc || null });
        return { accepted: true, credited: false };
    });
    notice.forEach(n => events.notify(n.userId, n));
    return outcome;
}

// The simulator's phone: accept (pay), cancel, or let it time out.
async function simulate(userId, requestId, action) {
    if (mode() !== 'simulator') throw new ServiceError(409, 'The simulator is off because M-Pesa is in sandbox mode');
    const [rows] = await db.execute('SELECT * FROM mpesa_requests WHERE id = ? AND user_id = ?', [requestId, userId]);
    if (!rows.length) throw new ServiceError(404, 'Request not found');
    const request = rows[0];
    const results = {
        pay: [0, 'The service request is processed successfully.'],
        cancel: [1032, 'Request cancelled by user'],
        timeout: [1037, 'DS timeout user cannot be reached'],
    };
    if (!results[action]) throw new ServiceError(400, 'Action must be pay, cancel or timeout');
    const [code, desc] = results[action];
    const stkCallback = {
        MerchantRequestID: request.merchant_request_id,
        CheckoutRequestID: request.checkout_request_id,
        ResultCode: code,
        ResultDesc: desc,
    };
    if (code === 0) {
        stkCallback.CallbackMetadata = {
            Item: [
                { Name: 'Amount', Value: Number(request.amount) },
                { Name: 'MpesaReceiptNumber', Value: `S${crypto.randomBytes(5).toString('hex').toUpperCase().slice(0, 9)}` },
                { Name: 'TransactionDate', Value: Number(timestamp()) },
                { Name: 'PhoneNumber', Value: Number(request.phone) },
            ],
        };
    }
    return processCallback({ Body: { stkCallback } });
}

async function status(userId, requestId) {
    const [rows] = await db.execute(
        'SELECT id, amount, phone, mode, status, result_code, result_desc, receipt, transaction_id, created_at FROM mpesa_requests WHERE id = ? AND user_id = ?',
        [requestId, userId]);
    if (!rows.length) throw new ServiceError(404, 'Request not found');
    return rows[0];
}

// Requests nobody answered within two minutes are marked as timed out.
async function expireStale() {
    const [rows] = await db.query(
        "SELECT checkout_request_id FROM mpesa_requests WHERE status = 'pending' AND mode = 'simulator' AND created_at < DATE_SUB(NOW(), INTERVAL 2 MINUTE) LIMIT 50");
    for (const row of rows) {
        await processCallback({ Body: { stkCallback: { CheckoutRequestID: row.checkout_request_id, ResultCode: 1037, ResultDesc: 'DS timeout user cannot be reached' } } });
    }
    return rows.length;
}

function tokenMatches(given) {
    const a = Buffer.from(String(given || ''));
    const b = Buffer.from(callbackToken());
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { mode, start, processCallback, simulate, status, expireStale, tokenMatches, timestamp, MAX_AMOUNT };
