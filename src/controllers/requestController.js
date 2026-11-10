// Money requests. A user asks another user for an amount; the payer can pay
// it or decline it, and the requester can cancel it while it is pending.
//
// Paying a request goes through the ordinary transfer endpoint, so it is
// locked, recorded and fraud-scored exactly like any other transfer. The
// request is then linked to that transfer, after checking that the
// transfer really is from the payer to the requester for the full amount.

const db = require('../config/db');
const {
    ServiceError, checkAmount, walletForUser, handle,
} = require('../services/ledger');

const MAX_PENDING = 20;

const SELECT = `
    SELECT r.id, r.amount, r.note, r.status, r.transaction_id, r.min_transaction_id, r.created_at, r.responded_at,
           r.requester_wallet_id, r.payer_wallet_id,
           ru.name AS requester_name, ru.email AS requester_email,
           pu.name AS payer_name, pu.email AS payer_email
    FROM money_requests r
    JOIN wallets rw ON rw.id = r.requester_wallet_id
    JOIN users ru ON ru.id = rw.user_id
    JOIN wallets pw ON pw.id = r.payer_wallet_id
    JOIN users pu ON pu.id = pw.user_id`;

function shape(row, walletId) {
    const incoming = row.payer_wallet_id === walletId;
    return {
        id: row.id,
        direction: incoming ? 'incoming' : 'outgoing',
        amount: Number(row.amount),
        note: row.note,
        status: row.status,
        transaction_id: row.transaction_id,
        created_at: row.created_at,
        responded_at: row.responded_at,
        other: incoming
            ? { name: row.requester_name, email: row.requester_email }
            : { name: row.payer_name, email: row.payer_email },
    };
}

const list = handle('RequestController', async (req, res) => {
    const wallet = await walletForUser(req.session.userId);
    const [rows] = await db.execute(
        `${SELECT}
         WHERE r.payer_wallet_id = ? OR r.requester_wallet_id = ?
         ORDER BY r.status = 'pending' DESC, r.created_at DESC, r.id DESC
         LIMIT 50`,
        [wallet.id, wallet.id]
    );
    const requests = rows.map(row => shape(row, wallet.id));
    res.json({
        requests,
        pendingIncoming: requests.filter(r => r.direction === 'incoming' && r.status === 'pending').length,
    });
});

const create = handle('RequestController', async (req, res) => {
    const wallet = await walletForUser(req.session.userId);
    const amount = checkAmount(req.body.amount);
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 120) : '';

    const [payerRows] = await db.execute(
        `SELECT w.id FROM users u JOIN wallets w ON w.user_id = u.id
         WHERE LOWER(u.email) = ? LIMIT 1`,
        [email]
    );
    if (!payerRows.length) throw new ServiceError(404, 'No SecureWallet user has that email address');
    const payerWalletId = payerRows[0].id;
    if (payerWalletId === wallet.id) throw new ServiceError(400, 'You cannot request money from yourself');

    const [countRows] = await db.execute(
        "SELECT COUNT(*) AS n FROM money_requests WHERE requester_wallet_id = ? AND status = 'pending'",
        [wallet.id]
    );
    if (Number(countRows[0].n) >= MAX_PENDING) {
        throw new ServiceError(409, `You can have up to ${MAX_PENDING} open requests`);
    }

    // Only transfers made after the request can pay it. Recording the
    // newest transaction id is exact, unlike a timestamp in whole seconds.
    const [result] = await db.execute(
        `INSERT INTO money_requests (requester_wallet_id, payer_wallet_id, amount, note, min_transaction_id)
         SELECT ?, ?, ?, ?, COALESCE(MAX(id), 0) FROM transactions`,
        [wallet.id, payerWalletId, amount, note || null]
    );
    res.status(201).json({ message: 'Request sent', id: result.insertId });
});

async function findRequest(id, walletId, role) {
    const column = role === 'payer' ? 'payer_wallet_id' : 'requester_wallet_id';
    const [rows] = await db.execute(`${SELECT} WHERE r.id = ? AND r.${column} = ? LIMIT 1`, [id, walletId]);
    if (!rows.length) throw new ServiceError(404, 'Request not found');
    if (rows[0].status !== 'pending') throw new ServiceError(409, 'This request has already been answered');
    return rows[0];
}

// Links a completed transfer to the request and marks it paid.
const markPaid = handle('RequestController', async (req, res) => {
    const wallet = await walletForUser(req.session.userId);
    const request = await findRequest(Number(req.params.id), wallet.id, 'payer');
    const transactionId = Number(req.body.transactionId);

    const [txRows] = await db.execute(
        `SELECT id, amount, sender_wallet_id, receiver_wallet_id, created_at,
                JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.type')) AS type
         FROM transactions WHERE id = ? AND status = 'completed'`,
        [transactionId || 0]
    );
    const tx = txRows[0];
    const matches = tx
        && tx.type === 'transfer'
        && tx.sender_wallet_id === wallet.id
        && tx.receiver_wallet_id === request.requester_wallet_id
        && Number(tx.amount) === Number(request.amount)
        && Number(tx.id) > Number(request.min_transaction_id);
    if (!matches) throw new ServiceError(400, 'That transfer does not match this request');

    const [result] = await db.execute(
        `UPDATE money_requests
         SET status = 'paid', transaction_id = ?, responded_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'pending'`,
        [transactionId, request.id]
    ).catch(error => {
        if (error.code === 'ER_DUP_ENTRY') throw new ServiceError(409, 'That transfer already paid another request');
        throw error;
    });
    if (!result.affectedRows) throw new ServiceError(409, 'This request has already been answered');
    res.json({ message: 'Request paid' });
});

function respond(role, status, message) {
    return handle('RequestController', async (req, res) => {
        const wallet = await walletForUser(req.session.userId);
        const request = await findRequest(Number(req.params.id), wallet.id, role);
        const [result] = await db.execute(
            `UPDATE money_requests SET status = ?, responded_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'pending'`,
            [status, request.id]
        );
        if (!result.affectedRows) throw new ServiceError(409, 'This request has already been answered');
        res.json({ message });
    });
}

module.exports = {
    list,
    create,
    markPaid,
    decline: respond('payer', 'declined', 'Request declined'),
    cancel: respond('requester', 'cancelled', 'Request cancelled'),
};
