const pool = require('../config/db');

async function getWalletByUserId(userId) {
    const sql = `
        SELECT id, user_id, balance, currency
        FROM wallets
        WHERE user_id = ?
        LIMIT 1
    `;

    const [rows] = await pool.execute(sql, [userId]);

    return rows.length ? rows[0] : null;
}

async function incrementBalance(walletId, amount) {
    const sql = `
        UPDATE wallets
        SET balance = balance + ?
        WHERE id = ?
    `;

    const [result] = await pool.execute(sql, [amount, walletId]);

    return result;
}

async function decrementBalance(walletId, amount) {
    const sql = `
        UPDATE wallets
        SET balance = balance - ?
        WHERE id = ?
    `;

    const [result] = await pool.execute(sql, [amount, walletId]);

    return result;
}

// Returns the wallet's transactions, newest first, with the other
// party's details and the fraud check result for each transaction.
async function getTransactionsByWalletId(walletId, limit, offset) {
    const sql = `
        SELECT
            t.id,
            t.amount,
            t.currency,
            t.sender_wallet_id,
            t.receiver_wallet_id,
            t.status,
            t.metadata,
            t.created_at,
            t.fraud_score,
            t.scoring_status,
            CASE WHEN t.sender_wallet_id = ? THEN 'out' ELSE 'in' END AS direction,
            sender.name AS sender_name,
            sender.email AS sender_email,
            receiver.name AS receiver_name,
            receiver.email AS receiver_email,
            fa.status AS alert_status
        FROM transactions t
        LEFT JOIN wallets sw ON sw.id = t.sender_wallet_id
        LEFT JOIN users sender ON sender.id = sw.user_id
        LEFT JOIN wallets rw ON rw.id = t.receiver_wallet_id
        LEFT JOIN users receiver ON receiver.id = rw.user_id
        LEFT JOIN fraud_alerts fa ON fa.transaction_id = t.id
        WHERE t.sender_wallet_id = ? OR t.receiver_wallet_id = ?
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ? OFFSET ?
    `;

    const [rows] = await pool.execute(sql, [
        walletId,
        walletId,
        walletId,
        Number(limit),
        Number(offset)
    ]);

    const countSql = `
        SELECT COUNT(*) as total
        FROM transactions
        WHERE sender_wallet_id = ? OR receiver_wallet_id = ?
    `;

    const [countRows] = await pool.execute(countSql, [walletId, walletId]);

    return {
        transactions: rows,
        total: countRows[0].total
    };
}

module.exports = {
    getWalletByUserId,
    incrementBalance,
    decrementBalance,
    getTransactionsByWalletId
};
