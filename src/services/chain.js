// Hash chains for append-only records (the journal and the audit log).
//
// Each record stores the exact text that was hashed (its payload), the
// hash of the record before it, and its own hash:
//
//     hash = SHA-256(previous hash + "\n" + payload)
//
// Changing, removing or reordering any earlier record breaks every hash
// after it, so tampering can be detected by recomputing the chain. The
// database also refuses UPDATE and DELETE on these tables (triggers in
// migration 004), so changing a record needs the triggers dropped first.
//
// Appending locks the chain's row in chain_heads until the surrounding
// database transaction commits, so records are linked in commit order.
// To avoid deadlocks, a transaction that appends to both chains always
// appends to the journal before the audit log.

const crypto = require('crypto');

const GENESIS = '0'.repeat(64);

function sha256(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function linkHash(prevHash, payload) {
    return sha256(`${prevHash}\n${payload}`);
}

// UTC time with milliseconds, in the form MySQL accepts for DATETIME(3).
function nowStamp() {
    return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

// Locks the head of a chain and returns { lastId, lastHash, openedAt }.
async function lockHead(connection, name) {
    const [rows] = await connection.execute(
        'SELECT last_id, last_hash, opened_at FROM chain_heads WHERE name = ? FOR UPDATE',
        [name]
    );
    if (!rows.length) {
        throw new Error(`Chain "${name}" is missing. Run node scripts/migrate.js.`);
    }
    return { lastId: Number(rows[0].last_id), lastHash: rows[0].last_hash, openedAt: rows[0].opened_at };
}

async function moveHead(connection, name, id, hash) {
    await connection.execute(
        'UPDATE chain_heads SET last_id = ?, last_hash = ? WHERE name = ?',
        [id, hash, name]
    );
}

module.exports = { GENESIS, sha256, linkHash, nowStamp, lockHead, moveHead };
