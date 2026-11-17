// Live updates and notifications (version 3).
//
// The browser keeps one connection open to GET /api/events and the server
// pushes events down it as they happen (Server-Sent Events). Users receive
// their notifications (money received, a payment held or released, a new
// device signing in); administrators also receive new alerts, disputes and
// reconciliation results, so the review queue updates without reloading.
//
// Server-Sent Events were chosen over WebSockets because updates only flow
// from the server to the browser, they need no extra library, they reuse
// the session cookie, and they pass through the HTTPS proxy unchanged.
//
// Connections are kept in this process, which suits the single web process
// the deployment runs (docs/DEPLOYMENT.md).

const db = require('../config/db');

const userStreams = new Map(); // user id -> Set of responses
const adminStreams = new Set();

function send(res, type, data) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

// GET /api/events
function stream(req, res) {
    const userId = String(req.session.userId);
    const isAdmin = req.session.role === 'admin';
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    send(res, 'ready', { at: new Date().toISOString() });

    if (!userStreams.has(userId)) userStreams.set(userId, new Set());
    userStreams.get(userId).add(res);
    if (isAdmin) adminStreams.add(res);

    // A comment every 25 seconds keeps proxies from closing an idle stream.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
        clearInterval(heartbeat);
        const set = userStreams.get(userId);
        if (set) {
            set.delete(res);
            if (!set.size) userStreams.delete(userId);
        }
        adminStreams.delete(res);
    });
}

function toUser(userId, type, data) {
    const set = userStreams.get(String(userId));
    if (set) set.forEach(res => send(res, type, data));
}

function toAdmins(type, data) {
    adminStreams.forEach(res => send(res, type, data));
}

// Stores a notification and pushes it to the user's open pages. Never
// throws: a notification must not undo the action it reports.
async function notify(userId, { kind, title, body = null }) {
    try {
        const [result] = await db.execute(
            'INSERT INTO notifications (user_id, kind, title, body) VALUES (?, ?, ?, ?)',
            [userId, kind, String(title).slice(0, 160), body ? String(body).slice(0, 500) : null]);
        toUser(userId, 'notification', { id: result.insertId, kind, title, body, created_at: new Date().toISOString() });
    } catch (error) {
        console.error('[Events] Could not store notification:', error.message);
    }
}

function connectionCount() {
    let users = 0;
    userStreams.forEach(set => { users += set.size; });
    return { streams: users, admins: adminStreams.size };
}

module.exports = { stream, toUser, toAdmins, notify, connectionCount };
