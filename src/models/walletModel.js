const pool = require('../config/db');

async function getWalletByUserId(userId) {
    const sql = `
        SELECT id, user_id, balance
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

async function getTransactionsByWalletId(walletId, limit, offset) {
    const sql = `
        SELECT id, amount, sender_wallet_id, receiver_wallet_id, status, metadata, created_at
        FROM transactions
        WHERE sender_wallet_id = ? OR receiver_wallet_id = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
    `;

    const [rows] = await pool.execute(sql, [
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