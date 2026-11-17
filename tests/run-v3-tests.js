// SecureWallet version 3 test runner: the double-entry journal, the audit
// log, idempotency, live notifications, devices, two-factor sign-in, the
// scam check and cooling-off, disputes, reports, two-person approval,
// M-Pesa, USSD, chamas, the fraud API with webhooks, model operations,
// the retry queue, the network graph, the attack lab, data export, the
// usability survey and metrics. Test cases TC-41 to TC-65.
//
// Start the website with, in .env:
//     RISK_MODE=enforce
//     ATTACK_LAB=1
//     USSD_SIMULATOR=1
// (ADMIN_2FA must not be "required" while testing) and the scoring service
// running, then from the project root:
//     node tests/run-v3-tests.js
//
// Test accounts end in @test.securewallet; remove them with
//     node tests/run-tests.js --cleanup

require('dotenv').config();
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const db = require('../src/config/db');
const totp = require('../src/services/totp');

const BASE = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const RUN_ID = Date.now().toString(36);
const PASSWORD = 'TestPass123';
const PIN = '4826';
const results = [];
let status = {};

function client() {
    let cookie = '';
    const call = async (method, url, body, headers = {}) => {
        const response = await fetch(BASE + url, {
            method,
            headers: {
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                ...(cookie ? { Cookie: cookie } : {}),
                ...headers,
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
        if (setCookies.length) {
            const jar = new Map(cookie ? cookie.split('; ').map(c => [c.split('=')[0], c]) : []);
            setCookies.forEach(c => { const pair = c.split(';')[0]; jar.set(pair.split('=')[0], pair); });
            cookie = [...jar.values()].join('; ');
        }
        const text = await response.text();
        let data = {};
        try { data = JSON.parse(text); } catch (e) { data = { text }; }
        return { status: response.status, data, headers: response.headers };
    };
    call.cookie = () => cookie;
    call.dropSession = () => { cookie = cookie.split('; ').filter(c => !c.startsWith('connect.sid=')).join('; '); };
    return call;
}

const email = name => `${name}.${RUN_ID}@test.securewallet`;

async function user(name, { deposit = 0, pin = false, phone = null } = {}) {
    const call = client();
    const address = email(name.toLowerCase());
    await call('POST', '/api/auth/register', { name: `${name} Test`, email: address, password: PASSWORD });
    await call('POST', '/api/auth/login', { email: address, password: PASSWORD });
    if (deposit) await call('POST', '/api/wallet/deposit', { amount: deposit });
    if (pin) await call('POST', '/api/auth/pin', { password: PASSWORD, pin: PIN });
    if (phone) await call('PUT', '/api/me/phone', { phone, password: PASSWORD });
    const [[row]] = await db.execute('SELECT u.id, w.id AS wallet_id FROM users u JOIN wallets w ON w.user_id = u.id WHERE u.email = ?', [address]);
    return { call, email: address, id: row.id, walletId: row.wallet_id };
}

async function admin(name) {
    const a = await user(name);
    await db.execute("UPDATE users SET role = 'admin' WHERE id = ?", [a.id]);
    a.call.dropSession();
    await a.call('POST', '/api/auth/login', { email: a.email, password: PASSWORD });
    return a;
}

async function balanceOf(walletId) {
    const [[row]] = await db.execute('SELECT balance FROM wallets WHERE id = ?', [walletId]);
    return Number(row.balance);
}

async function txOf(id) {
    const [rows] = await db.execute(
        `SELECT t.status, t.fraud_score, t.scoring_status, t.metadata, fa.id AS alert_id
         FROM transactions t LEFT JOIN fraud_alerts fa ON fa.transaction_id = t.id WHERE t.id = ?`, [id || 0]);
    const row = rows[0] || {};
    row.meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
    return row;
}

function randomPhone() {
    return `07${String(crypto.randomInt(10000000, 99999999))}`;
}

async function record(id, requirement, description, expected, fn, needs) {
    if (needs && !needs.ok) {
        results.push({ id, requirement, description, expected, actual: needs.why, status: 'Not run' });
        console.log(`SKIP  ${id}  ${description}\n      ${needs.why}`);
        return;
    }
    let actual = '';
    let pass = false;
    try {
        const outcome = await fn();
        pass = outcome.pass;
        actual = outcome.actual;
    } catch (error) {
        actual = `Error: ${error.message}`;
    }
    results.push({ id, requirement, description, expected, actual, status: pass ? 'Pass' : 'Fail' });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${description}\n      ${actual}`);
}

// Reads server-sent events until one of the given type arrives.
function waitForEvent(call, type, trigger, timeoutMs = 8000) {
    return new Promise((resolve) => {
        const controller = new AbortController();
        const timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
        fetch(BASE + '/api/events', { headers: { Cookie: call.cookie() }, signal: controller.signal })
            .then(async (response) => {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let triggered = false;
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    if (!triggered && buffer.includes('event: ready')) {
                        triggered = true;
                        trigger();
                    }
                    const match = buffer.split('\n\n').find(block => block.startsWith(`event: ${type}`));
                    if (match) {
                        clearTimeout(timer);
                        controller.abort();
                        resolve(JSON.parse(match.split('\n').find(l => l.startsWith('data: ')).slice(6)));
                        return;
                    }
                }
            })
            .catch(() => {});
    });
}

async function suite() {
    status = (await client()('GET', '/api/status')).data;
    const scoring = { ok: status.scoring === 'operational', why: 'Not run: the scoring service is not reachable' };
    const enforce = { ok: scoring.ok && status.riskMode === 'enforce', why: 'Not run: needs RISK_MODE=enforce' };
    const lab = { ok: enforce.ok && status.attackLab, why: 'Not run: needs RISK_MODE=enforce and ATTACK_LAB=1' };
    const ussdOn = { ok: status.ussdSimulator, why: 'Not run: needs USSD_SIMULATOR=1' };
    const simulator = { ok: status.mpesaMode === 'simulator', why: 'Not run: M-Pesa is not in simulator mode' };

    const boss = await admin('v3boss');
    const second = await admin('v3second');

    await record('TC-41', 'FR-24', 'Every money movement is a balanced, append-only journal entry',
        'Deposit, transfer and withdrawal each post entries whose lines add up to zero; wallet balance equals its journal account; the database refuses to change a journal line',
        async () => {
            const a = await user('ledgera', { deposit: 5000 });
            const b = await user('ledgerb');
            const t = await a.call('POST', '/api/wallet/transfer', { recipientEmail: b.email, amount: 300 });
            const w = await a.call('POST', '/api/wallet/withdraw', { amount: 200 });
            const [entries] = await db.execute(
                `SELECT e.id, SUM(l.amount) AS total FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
                 WHERE e.transaction_id IN (?, ?) GROUP BY e.id`, [t.data.transactionId || 0, w.data.transactionId || 0]);
            const balanced = entries.length === 2 && entries.every(e => Number(e.total) === 0);
            const [[sum]] = await db.execute('SELECT SUM(amount) AS total FROM journal_lines WHERE account = ?', [`wallet:${a.walletId}`]);
            const matches = Number(sum.total) === await balanceOf(a.walletId);
            let refused = false;
            try {
                await db.execute('UPDATE journal_lines SET amount = amount WHERE account = ? LIMIT 1', [`wallet:${a.walletId}`]);
            } catch (error) {
                refused = /append-only/.test(error.message);
            }
            return { pass: t.status === 200 && w.status === 200 && balanced && matches && refused,
                actual: `${entries.length} entries, balanced: ${balanced}; wallet ${await balanceOf(a.walletId)} vs journal ${sum.total}; update refused: ${refused}` };
        });

    await record('TC-42', 'NFR-07', 'Hash-chained audit log',
        'An administrator decision is written to the audit log; the chain verifies; the database refuses to delete a record',
        async () => {
            const a = await user('audita', { deposit: 6000, pin: true });
            const b = await user('auditb');
            const drain = await a.call('POST', '/api/wallet/transfer', { recipientEmail: b.email, amount: 6000, purpose: 'family_friends', pin: PIN });
            const tx = await txOf(drain.data.transactionId);
            let decided = { status: 0 };
            if (tx.alert_id) decided = await boss.call('PATCH', `/api/admin/fraud-alerts/${tx.alert_id}/status`, { status: 'cleared' });
            const [rows] = await db.execute("SELECT id, hash, prev_hash FROM audit_log WHERE action IN ('alert.decide', 'alert.approve') AND target_id = ?", [String(tx.alert_id || 0)]);
            const verify = await boss.call('POST', '/api/admin/audit/verify', {});
            let refused = false;
            try { await db.execute('DELETE FROM audit_log ORDER BY id LIMIT 1'); } catch (error) { refused = /append-only/.test(error.message); }
            return { pass: Boolean(tx.alert_id) && decided.status === 200 && rows.length === 1 && verify.data.ok === true && refused,
                actual: `Alert ${tx.alert_id || 'none'} decided HTTP ${decided.status}; audit records ${rows.length}; chain verified: ${verify.data.ok} (${verify.data.audit ? verify.data.audit.checked : 0} records); delete refused: ${refused}` };
        }, scoring);

    await record('TC-43', 'NFR-08', 'Idempotency keys stop a retried payment applying twice',
        'The same key twice moves the money once and replays the first response; the key with a different request is refused',
        async () => {
            const a = await user('idema', { deposit: 1000 });
            const b = await user('idemb');
            const key = `test-${crypto.randomBytes(8).toString('hex')}`;
            const body = { recipientEmail: b.email, amount: 150 };
            const first = await a.call('POST', '/api/wallet/transfer', body, { 'Idempotency-Key': key });
            const again = await a.call('POST', '/api/wallet/transfer', body, { 'Idempotency-Key': key });
            const different = await a.call('POST', '/api/wallet/transfer', { ...body, amount: 151 }, { 'Idempotency-Key': key });
            const balance = await balanceOf(a.walletId);
            return { pass: first.status === 200 && again.status === 200 && again.headers.get('idempotent-replayed') === 'true'
                && again.data.transactionId === first.data.transactionId && different.status === 422 && balance === 850,
                actual: `First HTTP ${first.status} #${first.data.transactionId}; repeat HTTP ${again.status} #${again.data.transactionId}, replayed: ${again.headers.get('idempotent-replayed')}; different body HTTP ${different.status}; balance ${balance}` };
        });

    await record('TC-44', 'FR-25', 'Live notification when money arrives',
        'The recipient\'s open page receives a notification event as soon as a transfer completes, and it is stored',
        async () => {
            const a = await user('livea', { deposit: 800 });
            const b = await user('liveb');
            const event = await waitForEvent(b.call, 'notification', () => a.call('POST', '/api/wallet/transfer', { recipientEmail: b.email, amount: 120 }));
            const list = await b.call('GET', '/api/notifications');
            return { pass: Boolean(event) && /120/.test(event.title) && list.data.unread >= 1,
                actual: `Event: ${event ? `"${event.title}"` : 'none within 8 s'}; stored, unread ${list.data.unread}` };
        });

    await record('TC-45', 'FR-26', 'Sign-in from a new device',
        'The user is notified; payments from that device carry a new-device risk signal',
        async () => {
            const a = await user('devicea', { deposit: 3000, pin: true });
            const b = await user('deviceb');
            const other = client();
            await other('POST', '/api/auth/login', { email: a.email, password: PASSWORD });
            const me = await other('GET', '/api/auth/me');
            const [notes] = await db.execute("SELECT title FROM notifications WHERE user_id = ? AND kind = 'new_device'", [a.id]);
            const pay = await other('POST', '/api/wallet/transfer', { recipientEmail: b.email, amount: 100, pin: PIN });
            const tx = await txOf(pay.data.transactionId);
            const signal = ((tx.meta.risk || {}).signals || []).some(s => s.key === 'new_device');
            const devices = await other('GET', '/api/me/devices');
            return { pass: me.data.user.newDevice === true && notes.length === 1 && signal && devices.data.devices.length === 2,
                actual: `Flagged as new device: ${me.data.user.newDevice}; notification "${notes[0] ? notes[0].title : 'none'}"; payment HTTP ${pay.status} with new-device signal: ${signal}; devices listed ${devices.data.devices.length}` };
        });

    await record('TC-46', 'NFR-09', 'Two-factor sign-in',
        'After setting up an authenticator, sign-in needs a code: a wrong code is refused, the right one signs in, and a used code cannot be replayed',
        async () => {
            const a = await user('mfa');
            const setup = await a.call('POST', '/api/auth/2fa/setup', {});
            const enable = await a.call('POST', '/api/auth/2fa/enable', { code: totp.codeAt(setup.data.secret, totp.currentStep()), password: PASSWORD });
            const fresh = client();
            const start = await fresh('POST', '/api/auth/login', { email: a.email, password: PASSWORD });
            const wrong = await fresh('POST', '/api/auth/mfa', { code: '000000' });
            // Wait for the next time step so the right code has not been used.
            const step = totp.currentStep();
            await new Promise(r => setTimeout(r, ((step + 1) * 30 * 1000) - Date.now() + 200));
            const code = totp.codeAt(setup.data.secret, totp.currentStep());
            const right = await fresh('POST', '/api/auth/mfa', { code });
            const replayClient = client();
            await replayClient('POST', '/api/auth/login', { email: a.email, password: PASSWORD });
            const replay = await replayClient('POST', '/api/auth/mfa', { code });
            return { pass: Boolean(setup.data.qr) && enable.status === 200 && start.status === 202 && start.data.mfaRequired === true
                && wrong.status === 401 && right.status === 200 && replay.status === 401,
                actual: `Set-up QR: ${Boolean(setup.data.qr)}; enable HTTP ${enable.status}; password step HTTP ${start.status}; wrong code HTTP ${wrong.status}; right code HTTP ${right.status}; replayed code HTTP ${replay.status}` };
        });

    await record('TC-47', 'FR-27', 'Scam check and cooling-off',
        'A first transfer of KES 1,000 or more asks what it is for; an ordinary purpose sends it; a scam-pattern purpose holds it for a cooling-off period, during which the sender can cancel and get the money back',
        async () => {
            const a = await user('scama', { deposit: 10000, pin: true });
            const b = await user('scamb');
            const c = await user('scamc');
            const asked = await a.call('POST', '/api/wallet/transfer', { recipientEmail: b.email, amount: 2000 });
            const safe = await a.call('POST', '/api/wallet/transfer', { recipientEmail: b.email, amount: 2000, purpose: 'family_friends', pin: PIN });
            const risky = await a.call('POST', '/api/wallet/transfer', { recipientEmail: c.email, amount: 2500, purpose: 'investment', pin: PIN });
            const held = await txOf(risky.data.transactionId);
            const recipientBefore = await balanceOf(c.walletId);
            const cancel = await a.call('POST', `/api/wallet/transactions/${risky.data.transactionId}/cancel`, {});
            const after = await txOf(risky.data.transactionId);
            return { pass: asked.status === 428 && asked.data.challenge === 'purpose' && asked.data.purposes.length === 8
                && safe.status === 200 && risky.status === 200 && Boolean(risky.data.coolingOff) && held.status === 'pending'
                && recipientBefore === 0 && cancel.status === 200 && after.status === 'failed' && await balanceOf(a.walletId) === 8000,
                actual: `No purpose HTTP ${asked.status} (${asked.data.challenge}); ordinary purpose HTTP ${safe.status}; "investment" HTTP ${risky.status}, cooling off until ${risky.data.coolingOff ? risky.data.coolingOff.until : 'n/a'}, status ${held.status}, recipient ${recipientBefore}; cancel HTTP ${cancel.status}, status ${after.status}; sender balance ${await balanceOf(a.walletId)}` };
        }, enforce);

    await record('TC-48', 'FR-27', 'Cooling-off payment is sent when the period ends',
        'Once the cooling-off time has passed, the payment is released to the recipient and the journal balances',
        async () => {
            const a = await user('coola', { deposit: 5000, pin: true });
            const b = await user('coolb');
            const sent = await a.call('POST', '/api/wallet/transfer', { recipientEmail: b.email, amount: 1500, purpose: 'sent_by_mistake', pin: PIN });
            const tx = await txOf(sent.data.transactionId);
            tx.meta.cooling_until = new Date(Date.now() - 1000).toISOString();
            await db.execute('UPDATE transactions SET metadata = ? WHERE id = ?', [JSON.stringify(tx.meta), sent.data.transactionId]);
            const released = await require('../src/services/payments').releaseDueCoolingOff();
            const after = await txOf(sent.data.transactionId);
            const [[held]] = await db.execute('SELECT COALESCE(SUM(amount), 0) AS total FROM journal_lines WHERE account = ?', [`held:${sent.data.transactionId}`]);
            return { pass: Boolean(sent.data.coolingOff) && released >= 1 && after.status === 'completed' && await balanceOf(b.walletId) === 1500 && Number(held.total) === 0,
                actual: `Cooling off: ${Boolean(sent.data.coolingOff)}; released ${released}; status ${after.status}; recipient ${await balanceOf(b.walletId)}; held account ${held.total}` };
        }, enforce);

    await record('TC-49', 'FR-28', '"This wasn\'t me" dispute, clawback and restore',
        'Disputing a payment freezes the account; upholding recovers what the recipient still holds and freezes the recipient; restoring lets the user pay again',
        async () => {
            const a = await user('disputea', { deposit: 4000, pin: true });
            const b = await user('disputeb', { deposit: 100 });
            const sent = await a.call('POST', '/api/wallet/transfer', { recipientEmail: b.email, amount: 900 });
            const opened = await a.call('POST', `/api/wallet/transactions/${sent.data.transactionId}/dispute`, { reason: 'I did not make this' });
            const blocked = await a.call('POST', '/api/wallet/withdraw', { amount: 10 });
            const [[dispute]] = await db.execute('SELECT id FROM disputes WHERE transaction_id = ?', [sent.data.transactionId]);
            const decided = await boss.call('POST', `/api/admin/disputes/${dispute.id}/decide`, { decision: 'upheld' });
            const [[recipient]] = await db.execute('SELECT frozen_at FROM users WHERE id = ?', [b.id]);
            const restored = await boss.call('POST', `/api/admin/users/${a.id}/restore`, {});
            const works = await a.call('POST', '/api/wallet/withdraw', { amount: 10 });
            return { pass: opened.status === 201 && blocked.status === 423 && decided.status === 200 && decided.data.recovered === 900
                && await balanceOf(a.walletId) === 3990 && Boolean(recipient.frozen_at) && restored.status === 200 && works.status === 200,
                actual: `Dispute HTTP ${opened.status}; withdrawal while frozen HTTP ${blocked.status}; upheld HTTP ${decided.status}, recovered ${decided.data.recovered}; recipient frozen: ${Boolean(recipient.frozen_at)}; restore HTTP ${restored.status}; withdrawal after HTTP ${works.status}; balance ${await balanceOf(a.walletId)}` };
        });

    await record('TC-50', 'NFR-10', 'Two-person approval for large held payments',
        'Deciding a held payment of KES 10,000 or more needs two different administrators; the money moves only on the second approval',
        async () => {
            const source = await user('bigsrc', { deposit: 60000 });
            const middle = await user('bigmid');
            const target = await user('bigtgt', { deposit: 100 });
            await source.call('POST', '/api/wallet/transfer', { recipientEmail: middle.email, amount: 20000, purpose: 'family_friends' });
            const sent = await middle.call('POST', '/api/wallet/transfer', { recipientEmail: target.email, amount: 20000, purpose: 'family_friends' });
            const tx = await txOf(sent.data.transactionId);
            const first = await boss.call('PATCH', `/api/admin/fraud-alerts/${tx.alert_id}/status`, { status: 'confirmed_fraud' });
            const same = await boss.call('PATCH', `/api/admin/fraud-alerts/${tx.alert_id}/status`, { status: 'confirmed_fraud' });
            const stillHeld = (await txOf(sent.data.transactionId)).status === 'pending';
            const approve = await second.call('PATCH', `/api/admin/fraud-alerts/${tx.alert_id}/status`, { status: 'confirmed_fraud' });
            const after = await txOf(sent.data.transactionId);
            return { pass: sent.data.held === true && first.status === 202 && same.status === 409 && stillHeld && approve.status === 200
                && approve.data.settlement === 'reversed' && after.status === 'failed' && await balanceOf(middle.walletId) === 20000,
                actual: `Held: ${sent.data.held}; first admin HTTP ${first.status}; same admin again HTTP ${same.status}; still held: ${stillHeld}; second admin HTTP ${approve.status} (${approve.data.settlement}); sender back to ${await balanceOf(middle.walletId)}` };
        }, enforce);

    await record('TC-51', 'FR-29', 'Reporting an account warns other payers',
        'Only someone who has dealt with an account can report it; others then see a warning on the payee check; a second report by the same person is refused',
        async () => {
            const a = await user('reporter', { deposit: 1000 });
            const b = await user('reportee');
            const c = await user('stranger');
            const d = await user('nextpayer');
            await a.call('POST', '/api/wallet/transfer', { recipientEmail: b.email, amount: 200 });
            const ok = await a.call('POST', '/api/reports', { email: b.email, reason: 'scam' });
            const again = await a.call('POST', '/api/reports', { email: b.email, reason: 'scam' });
            const notAllowed = await c.call('POST', '/api/reports', { email: b.email, reason: 'scam' });
            const lookup = await d.call('GET', `/api/wallet/recipient?email=${encodeURIComponent(b.email)}`);
            return { pass: ok.status === 201 && again.status === 409 && notAllowed.status === 403 && Boolean(lookup.data.warning),
                actual: `Report HTTP ${ok.status}; repeat HTTP ${again.status}; from a stranger HTTP ${notAllowed.status}; payee warning: "${lookup.data.warning ? lookup.data.warning.text : 'none'}"` };
        });

    await record('TC-52', 'FR-30', 'Send money to a phone number',
        'A user links a Kenyan number (password needed); another user finds and pays them by that number',
        async () => {
            const phone = randomPhone();
            const a = await user('phonea', { deposit: 700, pin: true });
            const b = await user('phoneb');
            const wrong = await b.call('PUT', '/api/me/phone', { phone, password: 'wrong-password' });
            const set = await b.call('PUT', '/api/me/phone', { phone, password: PASSWORD });
            const lookup = await a.call('GET', `/api/wallet/recipient?email=${encodeURIComponent(phone)}`);
            const pay = await a.call('POST', '/api/wallet/transfer', { recipientEmail: phone, amount: 100, pin: PIN });
            return { pass: wrong.status === 403 && set.status === 200 && lookup.data.email === b.email && pay.status === 200 && await balanceOf(b.walletId) === 100,
                actual: `Wrong password HTTP ${wrong.status}; linked ${set.data.phone}; lookup finds ${lookup.data.name}; payment HTTP ${pay.status}` };
        });

    await record('TC-53', 'FR-31', 'M-Pesa deposit by STK push (simulator)',
        'Accepting the phone prompt credits the wallet once, from external:mpesa in the journal; cancelling credits nothing; a callback with a wrong token is ignored',
        async () => {
            const a = await user('mpesa', { phone: randomPhone() });
            const start = await a.call('POST', '/api/mpesa/stk', { amount: 750 });
            const pay = await a.call('POST', `/api/mpesa/simulator/${start.data.id}`, { action: 'pay' });
            const repeat = await a.call('POST', `/api/mpesa/simulator/${start.data.id}`, { action: 'pay' });
            const second = await a.call('POST', '/api/mpesa/stk', { amount: 300 });
            const cancel = await a.call('POST', `/api/mpesa/simulator/${second.data.id}`, { action: 'cancel' });
            const forged = await client()('POST', '/api/mpesa/callback/not-the-token', { Body: { stkCallback: { CheckoutRequestID: 'x', ResultCode: 0 } } });
            const [[line]] = await db.execute(
                "SELECT COUNT(*) AS n FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.transaction_id = ? AND l.account = 'external:mpesa'",
                [pay.data.transaction_id || 0]);
            return { pass: start.status === 201 && /^ws_CO_/.test(start.data.checkoutRequestId) && pay.data.status === 'success' && repeat.data.status === 'success'
                && cancel.data.status === 'failed' && Number(cancel.data.result_code) === 1032 && await balanceOf(a.walletId) === 750 && forged.status === 404 && Number(line.n) === 1,
                actual: `STK HTTP ${start.status} (${start.data.checkoutRequestId}); paid: ${pay.data.status}, receipt ${pay.data.receipt}; repeat callback still one credit; cancelled: ${cancel.data.status} (${cancel.data.result_code}); balance ${await balanceOf(a.walletId)}; forged callback HTTP ${forged.status}` };
        }, simulator);

    await record('TC-54', 'FR-32', 'USSD menu for feature phones',
        'The simulator refuses anyone not signed in and dials from their own number; balance needs the PIN; sending shows the recipient\'s registered name before the PIN and completes; the language switches to Swahili',
        async () => {
            const phoneA = randomPhone();
            const phoneB = randomPhone();
            const a = await user('ussda', { deposit: 900, pin: true, phone: phoneA });
            await user('ussdb', { phone: phoneB });
            const ussd = async text => (await a.call('POST', '/api/ussd/simulate', { text })).data.text;
            const anonymous = await client()('POST', '/api/ussd/simulate', { phoneNumber: `+254${phoneA.slice(1)}`, text: '' });
            const menu = await ussd('');
            const wrong = await ussd('1*0000');
            const bal = await ussd(`1*${PIN}`);
            const payee = await ussd(`2*${phoneB}`);
            const confirm = await ussd(`2*${phoneB}*200`);
            const sent = await ussd(`2*${phoneB}*200*${PIN}`);
            const lang = await ussd('4');
            const sw = await ussd('');
            return { pass: anonymous.status === 401 && menu.startsWith('CON ') && wrong.startsWith('END ') && /900\.00/.test(bal) && /ussdb Test/.test(payee)
                && /ussdb Test/.test(confirm) && /^END Sent KES 200\.00/.test(sent) && await balanceOf(a.walletId) === 700 && /Kiswahili/.test(lang) && /Karibu/.test(sw),
                actual: `Without signing in: HTTP ${anonymous.status}; menu "${menu.split('\n')[0]}"; wrong PIN "${wrong}"; balance "${bal}"; payee "${payee.replace('\n', ' / ')}"; sent "${sent}"; language "${lang}"` };
        }, ussdOn);

    await record('TC-55', 'FR-33', 'Chama: contributions and a majority-approved payout',
        'Members contribute to the pot; a payout needs a majority (2 of 2) and is paid only after the second approval; the pot has its own journal account',
        async () => {
            const chair = await user('chamachair', { deposit: 3000 });
            const member = await user('chamamember', { deposit: 2000 });
            const created = await chair.call('POST', '/api/chamas', { name: `Test chama ${RUN_ID}`, contributionAmount: 500 });
            const id = created.data.id;
            await chair.call('POST', `/api/chamas/${id}/invite`, { email: member.email });
            const join = await member.call('POST', `/api/chamas/${id}/accept`, {});
            await chair.call('POST', `/api/chamas/${id}/contribute`, { amount: 1000 });
            await member.call('POST', `/api/chamas/${id}/contribute`, { amount: 800 });
            const proposal = await chair.call('POST', `/api/chamas/${id}/payouts`, { amount: 1500, recipientId: member.id, reason: 'School fees' });
            const before = await balanceOf(member.walletId);
            const vote = await member.call('POST', `/api/chamas/payouts/${proposal.data.id}/vote`, { vote: 'approve' });
            const detail = await chair.call('GET', `/api/chamas/${id}`);
            const [[pot]] = await db.execute('SELECT SUM(amount) AS total FROM journal_lines WHERE account = ?', [`chama:${id}`]);
            return { pass: created.status === 201 && join.status === 200 && proposal.data.status === 'proposed' && proposal.data.needed === 2
                && vote.data.status === 'paid' && await balanceOf(member.walletId) === before + 1500 && Number(detail.data.chama.balance) === 300 && Number(pot.total) === 300,
                actual: `Created HTTP ${created.status}; joined HTTP ${join.status}; payout ${proposal.data.status}, needs ${proposal.data.needed}; after second vote: ${vote.data.status}; pot ${detail.data.chama.balance}, journal ${pot.total}` };
        });

    await record('TC-56', 'FR-34', 'Fraud API with keys, decisions, rate limits and signed webhooks',
        'A client\'s key assesses payments; a burst is challenged; external_id makes calls safe to retry; a wrong key is refused; the rate limit applies; the webhook is signed correctly',
        async () => {
            const created = await boss.call('POST', '/api/admin/api-clients', { name: `Test client ${RUN_ID}` });
            const key = created.data.apiKey;
            const api = (body, k = key) => fetch(`${BASE}/api/v1/assess`, {
                method: 'POST', headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            }).then(async r => ({ status: r.status, data: await r.json() }));
            const first = await api({ external_id: 'p1', type: 'TRANSFER', amount: 300, account_id: 'c1', counterparty_id: 'c2', account_balance: 9000, counterparty_balance: 50 });
            const repeat = await api({ external_id: 'p1', type: 'TRANSFER', amount: 300, account_id: 'c1', counterparty_id: 'c2', account_balance: 9000, counterparty_balance: 50 });
            let last;
            for (let i = 0; i < 4; i += 1) {
                last = await api({ type: 'TRANSFER', amount: 300, account_id: 'c1', counterparty_id: 'c2', account_balance: 8700 - i * 300, counterparty_balance: 350 + i * 300 });
            }
            const badKey = await api({ type: 'CASH_OUT', amount: 10, account_id: 'c1', account_balance: 100 }, 'swk_live_not_a_real_key_000000000');
            const label = await fetch(`${BASE}/api/v1/assessments/${first.data.id}/feedback`, {
                method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'legit' }),
            }).then(r => r.status);

            // Webhook: a local receiver checks the signature.
            let received = null;
            const server = http.createServer((req, res) => {
                let body = '';
                req.on('data', c => { body += c; });
                req.on('end', () => { received = { body, signature: req.headers['securewallet-signature'] }; res.writeHead(200); res.end('ok'); });
            });
            await new Promise(r => server.listen(0, '127.0.0.1', r));
            const port = server.address().port;
            await boss.call('PATCH', `/api/admin/api-clients/${created.data.id}`, { webhookUrl: `http://127.0.0.1:${port}/hook`, rateLimit: 3 });
            const test = await boss.call('POST', `/api/admin/api-clients/${created.data.id}/webhook/test`, {});
            server.close();
            let signed = false;
            if (received) {
                const parts = Object.fromEntries(received.signature.split(',').map(p => p.split('=')));
                const expected = crypto.createHmac('sha256', created.data.webhookSecret).update(`${parts.t}.${received.body}`).digest('hex');
                signed = expected === parts.v1;
            }
            const limited = [];
            for (let i = 0; i < 5; i += 1) limited.push((await api({ type: 'CASH_OUT', amount: 10, account_id: `r${i}`, account_balance: 100 })).status);
            return { pass: created.status === 201 && first.status === 201 && first.data.decision === 'allow' && repeat.status === 200 && repeat.data.id === first.data.id
                && last.data.decision !== 'allow' && badKey.status === 401 && label === 200 && test.data.status === 'delivered' && signed && limited.includes(429),
                actual: `Client HTTP ${created.status}; first ${first.data.decision} (${first.data.id}); retry returns ${repeat.data.id}; 5th payment in a burst: ${last.data.decision} (${(last.data.reasons || []).join('; ')}); wrong key HTTP ${badKey.status}; label HTTP ${label}; webhook ${test.data.status}, signature valid: ${signed}; with a limit of 3 a minute: ${limited.join(', ')}` };
        }, scoring);

    await record('TC-57', 'FR-35', 'Retraining from decisions and shadow scoring',
        'Analyst decisions become labelled examples; retraining produces a challenger; later payments are also scored by the challenger in shadow; the challenger can be discarded',
        async () => {
            const before = await boss.call('GET', '/api/admin/models');
            const retrain = await boss.call('POST', '/api/admin/models/retrain', {});
            let state = 'running';
            let models;
            for (let i = 0; i < 40 && state === 'running'; i += 1) {
                await new Promise(r => setTimeout(r, 1000));
                models = await boss.call('GET', '/api/admin/models');
                state = models.data.job.state;
            }
            const a = await user('shadowa', { deposit: 500, pin: true });
            const b = await user('shadowb');
            const pay = await a.call('POST', '/api/wallet/transfer', { recipientEmail: b.email, amount: 50, pin: PIN });
            const shadow = ((await txOf(pay.data.transactionId)).meta.risk || {}).shadow;
            const discard = await boss.call('POST', '/api/admin/models/discard', {});
            return { pass: before.status === 200 && retrain.status === 202 && state === 'done' && Boolean(models.data.challenger) && Boolean(shadow)
                && shadow.version === models.data.challenger.version && discard.status === 200,
                actual: `Labels: ${JSON.stringify(retrain.data.labels)}; job ${state}; challenger ${models && models.data.challenger ? models.data.challenger.version : 'none'}; payment shadow-scored ${shadow ? shadow.score : 'no'}; discard HTTP ${discard.status}` };
        }, scoring);

    await record('TC-58', 'FR-35', 'Drift between live payments and the training data',
        'The drift check reports a population stability index for each model feature (at least 20 scored payments are made first, so the case does not depend on what ran before it)',
        async () => {
            const a = await user('drifta', { deposit: 20000, pin: true });
            const b = await user('driftb');
            for (let i = 0; i < 21; i += 1) {
                await a.call('POST', '/api/wallet/transfer', { recipientEmail: b.email, amount: 50 + i * 7, pin: PIN, purpose: 'family_friends' });
            }
            const drift = await boss.call('GET', '/api/admin/models/drift');
            const features = Object.keys(drift.data.features || {});
            return { pass: drift.status === 200 && features.length === 7,
                actual: `HTTP ${drift.status}; ${drift.data.n} payments; ${features.map(f => `${f} ${drift.data.features[f].psi}`).join(', ')}` };
        }, scoring);

    await record('TC-59', 'NFR-03', 'Retry queue scores payments made while the model was down',
        'An unscored transfer is scored later with the features recorded at the time; a risky one raises a late alert',
        async () => {
            const a = await user('latea', { deposit: 5000, pin: true });
            const b = await user('lateb');
            const pay = await a.call('POST', '/api/wallet/transfer', { recipientEmail: b.email, amount: 5000, purpose: 'family_friends', pin: PIN });
            // Make it look as if the model had been down.
            await db.execute("DELETE FROM fraud_alerts WHERE transaction_id = ?", [pay.data.transactionId || 0]);
            await db.execute("UPDATE transactions SET scoring_status = 'unscored', fraud_score = NULL WHERE id = ?", [pay.data.transactionId || 0]);
            const outcome = await require('../src/services/scoringQueue').runOnce();
            const tx = await txOf(pay.data.transactionId);
            const [[alert]] = await db.execute('SELECT alert_type FROM fraud_alerts WHERE transaction_id = ?', [pay.data.transactionId || 0]);
            return { pass: tx.scoring_status === 'scored' && Boolean(tx.meta.risk.scored_late_at) && alert && alert.alert_type === 'late_score',
                actual: `Queue scored ${outcome.scored}, flagged ${outcome.flagged}; transaction ${tx.scoring_status}, risk ${tx.fraud_score}; alert ${alert ? alert.alert_type : 'none'}` };
        }, scoring);

    await record('TC-60', 'FR-36', 'Money-flow network around an account',
        'The network view finds the accounts an account paid and was paid by, two hops out',
        async () => {
            const a = await user('neta', { deposit: 2000, pin: true });
            const b = await user('netb', { pin: true });
            const c = await user('netc');
            await a.call('POST', '/api/wallet/transfer', { recipientEmail: b.email, amount: 400, pin: PIN });
            await b.call('POST', '/api/wallet/transfer', { recipientEmail: c.email, amount: 300, pin: PIN });
            const net = await boss.call('GET', `/api/admin/network?account=${encodeURIComponent(a.email)}&hops=2&hours=24`);
            const ids = (net.data.nodes || []).map(n => n.id);
            return { pass: net.status === 200 && [a.walletId, b.walletId, c.walletId].every(id => ids.includes(id)) && net.data.edges.length >= 2,
                actual: `HTTP ${net.status}; ${ids.length} accounts, ${net.data.edges ? net.data.edges.length : 0} flows; includes the second hop: ${ids.includes(c.walletId)}` };
        });

    await record('TC-61', 'FR-23', 'Attack lab evaluation of every scenario',
        'Every attack step expected to be caught is caught; ordinary steps raise no false alarm',
        async () => {
            const run = await boss.call('POST', '/api/admin/lab/run-all', {});
            const t = run.data.total || {};
            const rows = (run.data.rows || []).map(r => `${r.scenario.id} ${r.summary.detected}/${r.summary.attackSteps}`).join(', ');
            await boss.call('POST', '/api/admin/lab/cleanup', {});
            return { pass: run.status === 200 && t.detected === t.attackSteps && t.falsePositives === 0,
                actual: `${t.detected} of ${t.attackSteps} attack steps caught (model alone ${t.modelAlone}); false alarms ${t.falsePositives} of ${t.normalSteps}; ${rows}` };
        }, lab);

    await record('TC-62', 'FR-37', 'Data export (right of access)',
        'The user downloads their data; it includes their transactions and devices and never the password, PIN or two-factor secret',
        async () => {
            const a = await user('exporter', { deposit: 250, pin: true });
            const out = await a.call('GET', '/api/me/export');
            const text = JSON.stringify(out.data);
            return { pass: out.status === 200 && out.data.transactions.length === 1 && out.data.devices.length === 1 && !/password_hash|pin_hash|totp_secret|\$2[aby]\$/.test(text),
                actual: `HTTP ${out.status}; ${out.data.transactions ? out.data.transactions.length : 0} transactions, ${out.data.devices ? out.data.devices.length : 0} devices; secrets absent: ${!/password_hash|pin_hash|totp_secret|\$2[aby]\$/.test(text)}` };
        });

    await record('TC-63', 'FR-38', 'Usability survey (System Usability Scale)',
        'A completed questionnaire is scored on the 0 to 100 SUS scale; incomplete answers are refused; results are summarised for administrators',
        async () => {
            const a = await user('survey');
            const best = await a.call('POST', '/api/survey/sus', { answers: [5, 1, 5, 1, 5, 1, 5, 1, 5, 1] });
            const mid = await a.call('POST', '/api/survey/sus', { answers: [4, 2, 4, 2, 4, 2, 4, 2, 4, 2], comment: 'Clear' });
            const bad = await a.call('POST', '/api/survey/sus', { answers: [5, 5] });
            const results = await boss.call('GET', '/api/admin/survey');
            return { pass: best.data.score === 100 && mid.data.score === 75 && bad.status === 400 && results.data.n >= 2,
                actual: `Best answers score ${best.data.score}; middle answers ${mid.data.score}; incomplete HTTP ${bad.status}; summary of ${results.data.n} responses, mean ${results.data.meanScore}` };
        });

    await record('TC-64', 'NFR-11', 'Latency metrics',
        '/metrics is refused without credentials and gives Prometheus metrics, including model latency, to an administrator',
        async () => {
            const anonymous = await client()('GET', '/metrics');
            const metricsText = await boss.call('GET', '/metrics');
            const text = metricsText.data.text || '';
            const system = await boss.call('GET', '/api/admin/system');
            const model = (system.data.series || []).find(s => s.name === 'model_score_ms');
            return { pass: anonymous.status === 401 && metricsText.status === 200 && /securewallet_latency_ms/.test(text) && Boolean(model),
                actual: `Anonymous HTTP ${anonymous.status}; admin HTTP ${metricsText.status}; model latency p50 ${model ? model.p50 : '?'} ms, p95 ${model ? model.p95 : '?'} ms over ${model ? model.count : 0} calls` };
        });

    await record('TC-65', 'FR-24', 'Reconciliation after every test',
        'The journal balances, both hash chains verify, and every wallet, savings goal, loan, chama and held payment matches its journal account',
        async () => {
            const run = await boss.call('POST', '/api/admin/ledger/reconcile', {});
            const s = run.data.summary || {};
            return { pass: run.status === 200 && run.data.ok === true,
                actual: `OK: ${run.data.ok}; ${s.journalChain ? s.journalChain.checked : 0} journal entries and ${s.auditChain ? s.auditChain.checked : 0} audit records verified; ${s.wallets ? s.wallets.accounts : 0} wallets checked; issues ${run.data.issues ? run.data.issues.length : '?'}${run.data.issues && run.data.issues.length ? ': ' + run.data.issues.slice(0, 3).map(i => i.detail).join('; ') : ''}` };
        });
}

function writeResults() {
    const dir = path.join(__dirname, 'results');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const lines = [
        '# SecureWallet version 3 test results',
        '',
        `Run: ${stamp} UTC against ${BASE} (risk mode ${status.riskMode || 'unknown'}, attack lab ${status.attackLab ? 'on' : 'off'}, M-Pesa ${status.mpesaMode}, USSD simulator ${status.ussdSimulator ? 'on' : 'off'}, scoring ${status.scoring || 'unknown'})`,
        '',
        '| ID | Req. | Test description | Expected result | Actual result | Status |',
        '|---|---|---|---|---|---|',
        ...results.map(r => `| ${r.id} | ${r.requirement} | ${r.description} | ${r.expected} | ${r.actual.replace(/\|/g, '/')} | ${r.status} |`),
    ];
    fs.writeFileSync(path.join(dir, 'results-v3.md'), lines.join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'results-v3.json'), JSON.stringify({ run: stamp, base: BASE, status, results }, null, 2));
    const passed = results.filter(r => r.status === 'Pass').length;
    const ran = results.filter(r => r.status !== 'Not run').length;
    const skipped = results.length - ran;
    console.log(`\n${passed} of ${ran} test cases passed${skipped ? `, ${skipped} not run` : ''}. Results saved to tests/results/results-v3.md`);
}

(async () => {
    try {
        const health = await fetch(BASE + '/api').catch(() => null);
        if (!health || !health.ok) {
            console.log(`The website is not reachable at ${BASE}. Start it with npm run dev and try again.`);
            process.exitCode = 1;
            return;
        }
        await suite();
        writeResults();
    } finally {
        await db.end();
        if (results.some(r => r.status === 'Fail')) process.exitCode = 1;
    }
})();
