// Tamper-evident audit log (version 3).
//
// Records who did what to whom: sign-ins, PIN and two-factor changes,
// account freezes, alert decisions and approvals, settlements, clawbacks,
// model retraining and promotion, API keys, attack-lab runs and
// reconciliation runs. Each record is hash-chained (services/chain.js) and
// the table refuses UPDATE and DELETE.

const db = require('../config/db');
const { linkHash, nowStamp, lockHead, moveHead } = require('./chain');

function payloadOf(row) {
    return JSON.stringify([row.createdAt, row.actorId || null, row.actorRole || null, row.action,
        row.targetType || null, row.targetId === undefined || row.targetId === null ? null : String(row.targetId),
        row.details || null, row.ip || null]);
}

async function append(connection, entry) {
    const head = await lockHead(connection, 'audit');
    const row = {
        ...entry,
        createdAt: nowStamp(),
        details: entry.details === undefined || entry.details === null
            ? null
            : (typeof entry.details === 'string' ? entry.details : JSON.stringify(entry.details)),
    };
    const payload = payloadOf(row);
    const hash = linkHash(head.lastHash, payload);
    const [result] = await connection.execute(
        `INSERT INTO audit_log
            (created_at, actor_id, actor_role, action, target_type, target_id, details, ip, payload, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.createdAt, row.actorId || null, row.actorRole || null, row.action, row.targetType || null,
            row.targetId === undefined || row.targetId === null ? null : String(row.targetId),
            row.details, row.ip || null, payload, head.lastHash, hash]
    );
    await moveHead(connection, 'audit', result.insertId, hash);
    return result.insertId;
}

// Records an action. Pass `connection` to make the record part of the
// caller's database transaction (it then commits or rolls back with the
// action it describes); otherwise it is written on its own.
async function record(entry, connection = null) {
    if (connection) return append(connection, entry);
    const own = await db.getConnection();
    try {
        await own.beginTransaction();
        const id = await append(own, entry);
        await own.commit();
        return id;
    } catch (error) {
        await own.rollback().catch(() => {});
        console.error('[Audit] Could not record', entry.action, error.message);
        return null;
    } finally {
        own.release();
    }
}

// The actor fields for a request made by a signed-in user.
function actor(req) {
    return {
        actorId: req.session && req.session.userId ? req.session.userId : null,
        actorRole: req.session && req.session.role ? req.session.role : null,
        ip: req.ip,
    };
}

module.exports = { record, actor, payloadOf };
