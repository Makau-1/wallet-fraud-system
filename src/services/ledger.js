// Shared ledger operations for the money services (savings, loans,
// payments). Every change to a wallet balance locks the wallet row,
// checks the balance, updates it and writes a row to transactions in the
// same database transaction, so the balance and the history always agree.

const db = require('../config/db');
const journal = require('./journal');

class ServiceError extends Error {
    constructor(status, message, body) {
        super(message);
        this.status = status;
        if (body) this.body = body;
    }
}

// Money that a frozen account may still move: into its own savings and
// towards repaying its own loan.
const ALLOWED_WHEN_FROZEN = new Set(['savings_deposit', 'loan_repayment']);

// Refuses outgoing money from an account its owner (or an administrator)
// has frozen, for example after "This wasn't me".
async function checkNotFrozen(connection, walletId) {
    const [rows] = await connection.execute(
        'SELECT u.frozen_at FROM wallets w JOIN users u ON u.id = w.user_id WHERE w.id = ?', [walletId]);
    if (rows.length && rows[0].frozen_at) {
        throw new ServiceError(423, 'This account is frozen, so no money can leave it. Contact support to restore it.',
            { message: 'This account is frozen, so no money can leave it. Contact support to restore it.', frozen: true });
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

// Takes money out of a wallet. meta.type names the service, and decides
// the journal account on the other side (services/journal.js).
async function debit(connection, walletId, amount, meta) {
    const before = await lockWallet(connection, walletId);
    if (!ALLOWED_WHEN_FROZEN.has(meta.type)) await checkNotFrozen(connection, walletId);
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
    await journal.post(connection, {
        kind: meta.type,
        transactionId: result.insertId,
        lines: [[journal.account.wallet(walletId), -amount], [journal.counterFor(meta), amount]],
    });
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
    await journal.post(connection, {
        kind: meta.type,
        transactionId: result.insertId,
        lines: [[journal.counterFor(meta), -amount], [journal.account.wallet(walletId), amount]],
    });
    return { transactionId: result.insertId, before, after };
}

// Wraps a route handler so ServiceErrors become clean JSON responses.
function handle(name, fn) {
    return async (req, res) => {
        try {
            await fn(req, res);
        } catch (error) {
            if (error instanceof ServiceError) {
                return res.status(error.status).json(error.body || { message: error.message });
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
    checkNotFrozen,
    debit,
    credit,
    handle,
};
