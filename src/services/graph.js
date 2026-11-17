// Money-flow network (version 3).
//
// Builds the network of transfers around an account: the accounts it paid
// and was paid by, then the accounts those paid and were paid by, up to a
// set number of hops. Money mules show up as shapes in this network:
// chains (A -> B -> C within minutes), collectors (many accounts paying
// one new account) and cycles (money going round and back).
//
// The admin Network page draws the result; findings() lists the accounts
// whose recent flows look most like mule activity.

const db = require('../config/db');

const MAX_NODES = 60;

async function around(walletId, { hops = 2, hours = 168 } = {}) {
    const start = Number(walletId);
    const depth = Math.min(Math.max(Number(hops) || 2, 1), 3);
    const window = Math.min(Math.max(Number(hours) || 168, 1), 24 * 90);
    const seen = new Set([start]);
    let frontier = [start];
    const edgeMap = new Map();

    for (let level = 0; level < depth && frontier.length && seen.size < MAX_NODES; level += 1) {
        const [rows] = await db.query(
            `SELECT sender_wallet_id AS s, receiver_wallet_id AS r, SUM(amount) AS total, COUNT(*) AS n,
                    MAX(created_at) AS last_at, SUM(status = 'pending') AS pending
             FROM transactions
             WHERE sender_wallet_id IS NOT NULL AND receiver_wallet_id IS NOT NULL
               AND status IN ('completed', 'pending')
               AND created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
               AND (sender_wallet_id IN (?) OR receiver_wallet_id IN (?))
             GROUP BY sender_wallet_id, receiver_wallet_id
             ORDER BY total DESC LIMIT 400`, [window, frontier, frontier]);
        const next = [];
        for (const row of rows) {
            for (const id of [Number(row.s), Number(row.r)]) {
                if (!seen.has(id) && seen.size < MAX_NODES) {
                    seen.add(id);
                    next.push(id);
                }
            }
            if (seen.has(Number(row.s)) && seen.has(Number(row.r))) {
                edgeMap.set(`${row.s}>${row.r}`, {
                    from: Number(row.s), to: Number(row.r), total: Number(row.total), count: Number(row.n),
                    lastAt: row.last_at, pending: Number(row.pending) > 0,
                });
            }
        }
        frontier = next;
    }

    const ids = [...seen];
    const [nodes] = await db.query(
        `SELECT w.id, w.balance, u.id AS user_id, u.name, u.email, u.frozen_at, u.created_at,
                (SELECT COUNT(DISTINCT r.reporter_id) FROM recipient_reports r WHERE r.reported_id = u.id) AS reports,
                (SELECT COUNT(*) FROM fraud_alerts fa JOIN transactions t ON t.id = fa.transaction_id
                  WHERE (t.sender_wallet_id = w.id OR t.receiver_wallet_id = w.id) AND fa.status = 'pending') AS open_alerts,
                (SELECT COUNT(*) FROM fraud_alerts fa JOIN transactions t ON t.id = fa.transaction_id
                  WHERE t.receiver_wallet_id = w.id AND fa.status = 'confirmed_fraud') AS confirmed_in
         FROM wallets w JOIN users u ON u.id = w.user_id WHERE w.id IN (?)`, [ids]);

    return {
        centre: start,
        hours: window,
        hops: depth,
        truncated: seen.size >= MAX_NODES,
        nodes: nodes.map(n => ({
            id: Number(n.id),
            userId: Number(n.user_id),
            name: n.name,
            email: n.email,
            balance: Number(n.balance),
            frozen: Boolean(n.frozen_at),
            reports: Number(n.reports),
            openAlerts: Number(n.open_alerts),
            confirmedIn: Number(n.confirmed_in),
            centre: Number(n.id) === start,
        })),
        edges: [...edgeMap.values()],
    };
}

// Accounts whose last 7 days look most like mule activity: money received
// from several accounts and sent on quickly, or reported by other users.
async function findings() {
    const [rows] = await db.query(
        `SELECT w.id, u.name, u.email, u.frozen_at,
                COUNT(DISTINCT inflow.sender_wallet_id) AS senders,
                COALESCE(SUM(inflow.amount), 0) AS received,
                (SELECT COALESCE(SUM(o.amount), 0) FROM transactions o
                  WHERE o.sender_wallet_id = w.id AND o.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
                    AND o.status IN ('completed', 'pending')) AS sent,
                (SELECT COUNT(DISTINCT r.reporter_id) FROM recipient_reports r WHERE r.reported_id = u.id) AS reports
         FROM wallets w JOIN users u ON u.id = w.user_id
         LEFT JOIN transactions inflow ON inflow.receiver_wallet_id = w.id AND inflow.sender_wallet_id IS NOT NULL
              AND inflow.status = 'completed' AND inflow.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
         GROUP BY w.id, u.id, u.name, u.email, u.frozen_at
         HAVING senders >= 3 OR reports > 0
         ORDER BY reports DESC, senders DESC LIMIT 25`);
    return rows.map(r => {
        const received = Number(r.received);
        const sent = Number(r.sent);
        return {
            walletId: Number(r.id), name: r.name, email: r.email, frozen: Boolean(r.frozen_at),
            senders: Number(r.senders), received, sent, reports: Number(r.reports),
            passThrough: received > 0 ? Math.round(Math.min(1, sent / received) * 100) : 0,
        };
    });
}

async function walletIdFor(identifier) {
    const value = String(identifier || '').trim();
    if (/^\d+$/.test(value)) return Number(value);
    const [rows] = await db.execute(
        'SELECT w.id FROM wallets w JOIN users u ON u.id = w.user_id WHERE LOWER(u.email) = ? OR u.phone = ? LIMIT 1',
        [value.toLowerCase(), value.replace(/^\+/, '')]);
    return rows.length ? Number(rows[0].id) : null;
}

module.exports = { around, findings, walletIdFor };
