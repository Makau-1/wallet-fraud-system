// Webhooks for fraud API clients (version 3).
//
// When an assessment comes back as "challenge" or "review", the client's
// webhook URL receives an assessment.flagged event, so their own systems
// can act on it without polling. Each delivery is signed:
//
//   SecureWallet-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>
//
// where the HMAC is computed with the client's webhook secret over
// "<t>.<raw body>". The receiver recomputes it and rejects a mismatch or a
// timestamp more than five minutes old (scripts/webhook-receiver.js shows
// how). Failed deliveries are retried after 1, 5, 15, 60 and 360 minutes,
// then marked failed.
//
// Webhook URLs are checked before use: in production they must use HTTPS
// and may not point at private or local addresses, so the server cannot be
// used to reach internal systems. The check is made again on the address
// actually connected to (in the socket's own DNS lookup), so a host that
// changes its DNS answer between the check and the request is refused.

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const net = require('net');
const db = require('../config/db');

const BACKOFF_MINUTES = [1, 5, 15, 60, 360];

function sign(secret, timestamp, body) {
    return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

// Addresses a webhook may never reach: private, local, link-local,
// carrier-grade NAT, benchmarking, multicast and reserved ranges, in both
// IPv4 and IPv6 (BlockList also matches IPv4-mapped IPv6 forms).
const BLOCKED = new net.BlockList();
[['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 3]].forEach(([a, p]) => BLOCKED.addSubnet(a, p, 'ipv4'));
[['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32],
    ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]].forEach(([a, p]) => BLOCKED.addSubnet(a, p, 'ipv6'));

function privateAddress(ip) {
    if (!net.isIP(ip)) return true;
    return BLOCKED.check(ip, net.isIPv4(ip) ? 'ipv4' : 'ipv6');
}

// A DNS lookup for the request's socket that refuses blocked addresses.
function guardedLookup(hostname, options, callback) {
    require('dns').lookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) return callback(error);
        const bad = addresses.find(a => privateAddress(a.address));
        if (bad) return callback(Object.assign(new Error('The webhook URL points at a private address'), { code: 'EBLOCKED' }));
        if (options && options.all) return callback(null, addresses);
        return callback(null, addresses[0].address, addresses[0].family);
    });
}

// POSTs the delivery and resolves with the HTTP status. Redirects are not
// followed.
function post(rawUrl, headers, body) {
    const url = new URL(rawUrl);
    const client = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const request = client.request(url, {
            method: 'POST',
            headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
            lookup: allowPrivate() ? undefined : guardedLookup,
            timeout: 5000,
        }, (response) => {
            response.resume();
            resolve(response.statusCode);
        });
        request.on('timeout', () => request.destroy(new Error('Timed out after 5 seconds')));
        request.on('error', reject);
        request.end(body);
    });
}

function allowPrivate() {
    if (process.env.WEBHOOK_ALLOW_PRIVATE === '1') return true;
    return process.env.NODE_ENV !== 'production';
}

async function checkUrl(raw) {
    let url;
    try {
        url = new URL(raw);
    } catch (error) {
        throw Object.assign(new Error('Enter a full URL, for example https://example.com/webhooks'), { status: 400 });
    }
    if (!['https:', 'http:'].includes(url.protocol)) throw Object.assign(new Error('The webhook URL must use https'), { status: 400 });
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
        throw Object.assign(new Error('The webhook URL must use https'), { status: 400 });
    }
    if (!allowPrivate()) {
        const addresses = await dns.lookup(url.hostname, { all: true }).catch(() => []);
        if (!addresses.length) throw Object.assign(new Error('The webhook host could not be found'), { status: 400 });
        if (addresses.some(a => privateAddress(a.address))) {
            throw Object.assign(new Error('The webhook URL points at a private address'), { status: 400 });
        }
    }
    return url.toString();
}

async function enqueue(clientId, eventType, data) {
    const [[client]] = await db.execute('SELECT webhook_url FROM api_clients WHERE id = ? AND status = ?', [clientId, 'active']);
    if (!client || !client.webhook_url) return null;
    const payload = JSON.stringify({ id: `evt_${crypto.randomBytes(9).toString('hex')}`, type: eventType, created: new Date().toISOString(), data });
    const [result] = await db.execute(
        'INSERT INTO webhook_deliveries (client_id, event_type, payload, next_attempt_at) VALUES (?, ?, ?, UTC_TIMESTAMP())',
        [clientId, eventType, payload]);
    return result.insertId;
}

async function deliver(row) {
    const [[client]] = await db.execute('SELECT webhook_url, webhook_secret FROM api_clients WHERE id = ?', [row.client_id]);
    let status = null;
    let error = null;
    if (!client || !client.webhook_url) {
        error = 'No webhook URL is set';
    } else {
        try {
            await checkUrl(client.webhook_url);
            const timestamp = Math.floor(Date.now() / 1000);
            status = await post(client.webhook_url, {
                'Content-Type': 'application/json',
                'User-Agent': 'SecureWallet-Webhooks/1.0',
                'SecureWallet-Event': row.event_type,
                'SecureWallet-Delivery': String(row.id),
                'SecureWallet-Signature': `t=${timestamp},v1=${sign(client.webhook_secret, timestamp, row.payload)}`,
            }, row.payload);
            if (status < 200 || status >= 300) error = `Responded with HTTP ${status}`;
        } catch (e) {
            error = e.message.slice(0, 250);
        }
    }
    const attempts = Number(row.attempts) + 1;
    if (!error) {
        await db.execute(
            "UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, last_status_code = ?, last_error = NULL, delivered_at = UTC_TIMESTAMP() WHERE id = ?",
            [attempts, status, row.id]);
        return true;
    }
    const finished = attempts > BACKOFF_MINUTES.length;
    await db.execute(
        `UPDATE webhook_deliveries SET status = ?, attempts = ?, last_status_code = ?, last_error = ?,
                next_attempt_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE) WHERE id = ?`,
        [finished ? 'failed' : 'pending', attempts, status, error, finished ? 0 : BACKOFF_MINUTES[attempts - 1], row.id]);
    return false;
}

let running = false;
async function runDue() {
    if (running) return 0;
    running = true;
    let sent = 0;
    try {
        const [rows] = await db.query(
            "SELECT * FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= UTC_TIMESTAMP() ORDER BY id LIMIT 20");
        for (const row of rows) {
            if (await deliver(row)) sent += 1;
        }
    } catch (error) {
        console.error('[Webhooks]', error.message);
    } finally {
        running = false;
    }
    return sent;
}

function start(intervalMs = 5000) {
    const timer = setInterval(runDue, intervalMs);
    timer.unref();
}

module.exports = { sign, checkUrl, enqueue, runDue, start, privateAddress };
