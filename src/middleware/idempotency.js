// Idempotency keys (version 3).
//
// A payment request may be sent twice: a double click, a phone that loses
// signal and retries, a proxy that repeats a request. With an
// Idempotency-Key header, the first request is processed and its result
// stored; any later request with the same key gets the stored result back
// instead of moving the money again.
//
//   - same key, same request, finished   -> the stored response (header
//                                            Idempotent-Replayed: true)
//   - same key, still being processed    -> 409 (a key left unfinished for
//                                            two minutes is released)
//   - same key, a different request      -> 422
// Only successful responses are stored. If the first attempt fails (for
// example the PIN was asked for), the key is released so the client can
// retry with the same key. Keys are kept for 24 hours.
//
// The header is optional, so clients that do not send it behave as before.

const crypto = require('crypto');
const db = require('../config/db');

function requestHash(req) {
    return crypto.createHash('sha256')
        .update(`${req.method} ${req.baseUrl}${req.path}\n${JSON.stringify(req.body || {})}`)
        .digest('hex');
}

function idempotency(req, res, next) {
    const key = req.get('Idempotency-Key');
    if (!key) return next();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) {
        return res.status(400).json({ message: 'Idempotency-Key must be 8 to 64 letters, digits, - or _' });
    }
    const userId = req.session.userId;
    const hash = requestHash(req);

    (async () => {
        try {
            await db.execute('INSERT INTO idempotency_keys (user_id, idem_key, request_hash) VALUES (?, ?, ?)', [userId, key, hash]);
        } catch (error) {
            if (error.code !== 'ER_DUP_ENTRY') throw error;
            const [rows] = await db.execute(
                'SELECT request_hash, status_code, response, created_at < DATE_SUB(NOW(), INTERVAL 2 MINUTE) AS stale FROM idempotency_keys WHERE user_id = ? AND idem_key = ?',
                [userId, key]);
            const stored = rows[0];
            if (!stored) return next();
            if (stored.request_hash !== hash) {
                return res.status(422).json({ message: 'This Idempotency-Key was already used for a different request' });
            }
            if (stored.status_code === null) {
                if (Number(stored.stale)) {
                    // The first attempt never finished (a crash, say): release the key.
                    await db.execute('DELETE FROM idempotency_keys WHERE user_id = ? AND idem_key = ? AND status_code IS NULL', [userId, key]);
                }
                return res.status(409).json({ message: 'This request is still being processed. Try again in a moment.' });
            }
            res.set('Idempotent-Replayed', 'true');
            return res.status(stored.status_code).type('application/json').send(stored.response);
        }

        // Store the response before it is sent, so a retry that arrives
        // straight afterwards finds it.
        let settled = false;
        // A response sent some other way, or a connection that closes
        // before any response, releases the key so a retry can go ahead.
        res.on('close', () => {
            if (!settled) {
                db.execute('DELETE FROM idempotency_keys WHERE user_id = ? AND idem_key = ? AND status_code IS NULL', [userId, key])
                    .catch(error => console.error('[Idempotency]', error.message));
            }
        });
        const send = res.json.bind(res);
        res.json = (body) => {
            settled = true;
            const ok = res.statusCode >= 200 && res.statusCode < 300;
            const save = ok
                ? db.execute('UPDATE idempotency_keys SET status_code = ?, response = ? WHERE user_id = ? AND idem_key = ?',
                    [res.statusCode, JSON.stringify(body), userId, key])
                : db.execute('DELETE FROM idempotency_keys WHERE user_id = ? AND idem_key = ?', [userId, key]);
            save.catch(error => console.error('[Idempotency]', error.message)).finally(() => send(body));
            return res;
        };
        return next();
    })().catch(error => {
        console.error('[Idempotency]', error.message);
        res.status(500).json({ message: 'Something went wrong. Try again.' });
    });
}

async function purgeExpired() {
    await db.execute('DELETE FROM idempotency_keys WHERE created_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)');
}

module.exports = { idempotency, purgeExpired };
