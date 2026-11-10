// Shared ledger operations for the money services (savings, loans,
// payments). Every change to a wallet balance locks the wallet row,
// checks the balance, updates it and writes a row to transactions in the
// same database transaction, so the balance and the history always agree.

const db = require('../config/db');

class ServiceError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const MAX_AMOUNT = 1000000;

function round2(value) {
    return Math.round(Number(value) * 100) / 100;
}

// A positive number with at most two decimal places.
function checkAmount(amount, max = MAX_AMOUNT) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
        throw new ServiceError(400, 'Amount must be a positive number');
    }
    if (Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6) {
        throw new ServiceError(400, 'Amount can have at most two decimal places');
    }
    if (amount > max) {
        throw new ServiceError(400, `Amount cannot be more than ${max.toLocaleString('en-US')}`);
    }
    return round2(amount);
}

// Returns the validation message for an amount, or null if it is valid.
function amountError(amount, max = MAX_AMOUNT) {
    try {
        checkAmount(amount, max);
        return null;
    } catch (error) {
        return error.message;
    }
}

async function withTransaction(work) {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const result = await work(connection);
        await connection.commit();
        return result;
    } catch (error) {
        try {
            await connection.rollback();
        } catch (rollbackError) {
            console.error('[Ledger] Rollback failed:', rollbackError.message);
        }
        throw error;
    } finally {
        connection.release();
    }
}

async function walletForUser(userId) {
    const [rows] = await db.execute(
        'SELECT id, balance, currency FROM wallets WHERE user_id = ? LIMIT 1',
        [userId]
    );
    if (!rows.length) throw new ServiceError(404, 'Wallet not found');
    return rows[0];
}

async function lockWallet(connection, walletId) {
    const [rows] = await connection.execute(
        'SELECT id, balance FROM wallets WHERE id = ? FOR UPDATE',
        [walletId]
    );
    if (!rows.length) throw new ServiceError(404, 'Wallet not found');
    return Number(rows[0].balance);
}

// Takes money out of a wallet. meta.type names the service.
async function debit(connection, walletId, amount, meta) {
    const before = await lockWallet(connection, walletId);
    if (amount > before) throw new ServiceError(400, 'Insufficient funds');
    const after = round2(before - amount);

    await connection.execute(
        'UPDATE wallets SET balance = balance - ? WHERE id = ?',
        [amount, walletId]
    );
    const [result] = await connection.execute(
        `INSERT INTO transactions
            (amount, receiver_wallet_id, sender_wallet_id, status, metadata)
         VALUES (?, NULL, ?, 'completed', ?)`,
        [amount, walletId, JSON.stringify({
            ...meta,
            sender_balance_before: before,
            sender_balance_after: after,
        })]
    );
    return { transactionId: result.insertId, before, after };
}

// Puts money into a wallet. meta.type names the service.
async function credit(connection, walletId, amount, meta) {
    const before = await lockWallet(connection, walletId);
    const after = round2(before + amount);

    await connection.execute(
        'UPDATE wallets SET balance = balance + ? WHERE id = ?',
        [amount, walletId]
    );
    const [result] = await connection.execute(
        `INSERT INTO transactions
            (amount, receiver_wallet_id, sender_wallet_id, status, metadata)
         VALUES (?, ?, NULL, 'completed', ?)`,
        [amount, walletId, JSON.stringify({
            ...meta,
            receiver_balance_before: before,
            receiver_balance_after: after,
        })]
    );
    return { transactionId: result.insertId, before, after };
}

// Wraps a route handler so ServiceErrors become clean JSON responses.
function handle(name, fn) {
    return async (req, res) => {
        try {
            await fn(req, res);
        } catch (error) {
            if (error instanceof ServiceError) {
                return res.status(error.status).json({ message: error.message });
            }
            console.error(`[${name}]`, error);
            return res.status(500).json({ message: 'Something went wrong. Try again.' });
        }
    };
}

module.exports = {
    ServiceError,
    round2,
    checkAmount,
    amountError,
    withTransaction,
    walletForUser,
    lockWallet,
    debit,
    credit,
    handle,
};
