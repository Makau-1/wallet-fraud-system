// Instant loans. The limit grows with the money a user has received in the
// last 30 days, a one-off fee is added when the loan is taken, and the loan
// is repaid from the wallet in one or more payments. A user with a
// transaction confirmed as fraud in the last 90 days cannot borrow, which
// links lending decisions to the fraud review.

const db = require('../config/db');
const {
    ServiceError, round2, checkAmount, withTransaction,
    walletForUser, lockWallet, debit, credit, handle,
} = require('../services/ledger');

const FEE_RATE = 0.075;        // one-off facilitation fee
const TERM_DAYS = 30;
const LIMIT_SHARE = 0.3;       // share of the last 30 days' inflow
const MIN_LOAN = 100;
const MAX_LIMIT = 50000;

// Due dates are compared and formatted in MySQL, as for savings goals.
const COLUMNS = `*,
    DATE_FORMAT(due_date, '%Y-%m-%d') AS due_date_s,
    (status = 'active' AND due_date < CURDATE()) AS is_overdue`;

function shape(loan) {
    if (!loan) return null;
    const due = Number(loan.amount_due);
    const repaid = Number(loan.amount_repaid);
    return {
        id: loan.id,
        principal: Number(loan.principal),
        fee: Number(loan.fee),
        amount_due: due,
        amount_repaid: repaid,
        outstanding: round2(due - repaid),
        status: loan.status,
        overdue: Boolean(Number(loan.is_overdue)),
        due_date: loan.due_date_s,
        created_at: loan.created_at,
        repaid_at: loan.repaid_at,
    };
}

// Works out the limit and whether the user may borrow now. `conn` is either
// the pool or a connection inside a transaction.
//
// Inflow counts deposits plus transfers received, but each sender's
// transfers count only net of what this user sent back to them, so passing
// money back and forth between two accounts does not raise either limit.
// Transfers under review or confirmed as fraud are left out.
async function assess(conn, walletId) {
    const [depositRows] = await conn.execute(
        `SELECT COALESCE(SUM(amount), 0) AS total
         FROM transactions
         WHERE receiver_wallet_id = ?
           AND status = 'completed'
           AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
           AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.type')) = 'deposit'`,
        [walletId]
    );
    const [flowRows] = await conn.execute(
        `SELECT IF(t.receiver_wallet_id = ?, t.sender_wallet_id, t.receiver_wallet_id) AS other,
                SUM(IF(t.receiver_wallet_id = ?, t.amount, -t.amount)) AS net
         FROM transactions t
         LEFT JOIN fraud_alerts fa ON fa.transaction_id = t.id
         WHERE (t.receiver_wallet_id = ? OR t.sender_wallet_id = ?)
           AND t.sender_wallet_id IS NOT NULL
           AND t.receiver_wallet_id IS NOT NULL
           AND t.status = 'completed'
           AND t.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
           AND JSON_UNQUOTE(JSON_EXTRACT(t.metadata, '$.type')) = 'transfer'
           AND (fa.id IS NULL OR fa.status = 'cleared')
         GROUP BY other`,
        [walletId, walletId, walletId, walletId]
    );
    const netTransfers = flowRows.reduce((sum, row) => sum + Math.max(0, Number(row.net)), 0);
    const inflow = Number(depositRows[0].total) + netTransfers;
    const limit = Math.min(MAX_LIMIT, Math.floor((inflow * LIMIT_SHARE) / 50) * 50);

    const [fraudRows] = await conn.execute(
        `SELECT COUNT(*) AS n
         FROM fraud_alerts fa
         JOIN transactions t ON t.id = fa.transaction_id
         WHERE t.sender_wallet_id = ?
           AND fa.status = 'confirmed_fraud'
           AND fa.created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)`,
        [walletId]
    );

    const [activeRows] = await conn.execute(
        `SELECT ${COLUMNS} FROM loans WHERE wallet_id = ? AND status = 'active' LIMIT 1`,
        [walletId]
    );

    let reason = null;
    if (Number(fraudRows[0].n) > 0) {
        reason = 'Loans are unavailable because a recent transaction on this account was confirmed as fraud.';
    } else if (activeRows.length) {
        reason = 'Repay your current loan to borrow again.';
    } else if (limit < MIN_LOAN) {
        reason = `Receive more money into your wallet to unlock a loan. Your limit is ${LIMIT_SHARE * 100}% of what you received in the last 30 days.`;
    }

    return { limit, inflow, eligible: reason === null, reason, active: activeRows[0] || null };
}

const summary = handle('LoanController', async (req, res) => {
    const wallet = await walletForUser(req.session.userId);
    const state = await assess(db, wallet.id);
    const [history] = await db.execute(
        `SELECT ${COLUMNS} FROM loans WHERE wallet_id = ? ORDER BY created_at DESC, id DESC LIMIT 10`,
        [wallet.id]
    );
    res.json({
        limit: state.limit,
        eligible: state.eligible,
        reason: state.reason,
        feeRate: FEE_RATE,
        termDays: TERM_DAYS,
        minLoan: MIN_LOAN,
        active: shape(state.active),
        history: history.map(shape),
    });
});

const apply = handle('LoanController', async (req, res) => {
    const wallet = await walletForUser(req.session.userId);
    const amount = checkAmount(req.body.amount, MAX_LIMIT);

    const outcome = await withTransaction(async (connection) => {
        // Lock the wallet first so two applications cannot both pass the
        // "no active loan" check.
        await lockWallet(connection, wallet.id);
        const state = await assess(connection, wallet.id);
        if (!state.eligible) throw new ServiceError(409, state.reason);
        if (amount < MIN_LOAN) throw new ServiceError(400, `The smallest loan is ${MIN_LOAN}`);
        if (amount > state.limit) throw new ServiceError(400, `Your loan limit is ${state.limit.toFixed(2)}`);

        const fee = round2(amount * FEE_RATE);
        const due = round2(amount + fee);
        const [result] = await connection.execute(
            `INSERT INTO loans (wallet_id, principal, fee, amount_due, due_date)
             VALUES (?, ?, ?, ?, DATE_ADD(CURDATE(), INTERVAL ? DAY))`,
            [wallet.id, amount, fee, due, TERM_DAYS]
        );
        const moved = await credit(connection, wallet.id, amount, {
            type: 'loan_disbursement',
            loan_id: result.insertId,
            fee,
        });
        const [rows] = await connection.execute(`SELECT ${COLUMNS} FROM loans WHERE id = ?`, [result.insertId]);
        return { moved, loan: rows[0] };
    });

    res.status(201).json({
        message: 'Loan sent to your wallet',
        transactionId: outcome.moved.transactionId,
        balance: outcome.moved.after,
        loan: shape(outcome.loan),
    });
});

const repay = handle('LoanController', async (req, res) => {
    const wallet = await walletForUser(req.session.userId);
    const amount = checkAmount(req.body.amount);

    const outcome = await withTransaction(async (connection) => {
        const [rows] = await connection.execute(
            `SELECT ${COLUMNS} FROM loans WHERE wallet_id = ? AND status = 'active' LIMIT 1 FOR UPDATE`,
            [wallet.id]
        );
        if (!rows.length) throw new ServiceError(404, 'You have no loan to repay');
        const loan = rows[0];
        const outstanding = round2(Number(loan.amount_due) - Number(loan.amount_repaid));
        if (amount > outstanding) throw new ServiceError(400, `You only owe ${outstanding.toFixed(2)}`);

        const moved = await debit(connection, wallet.id, amount, {
            type: 'loan_repayment',
            loan_id: loan.id,
        });
        const cleared = round2(outstanding - amount) === 0;
        await connection.execute(
            `UPDATE loans
             SET amount_repaid = amount_repaid + ?,
                 status = IF(?, 'repaid', status),
                 repaid_at = IF(?, CURRENT_TIMESTAMP, repaid_at)
             WHERE id = ?`,
            [amount, cleared, cleared, loan.id]
        );
        const [after] = await connection.execute(`SELECT ${COLUMNS} FROM loans WHERE id = ?`, [loan.id]);
        return { moved, loan: after[0], cleared };
    });

    res.json({
        message: outcome.cleared ? 'Loan fully repaid' : 'Repayment received',
        transactionId: outcome.moved.transactionId,
        balance: outcome.moved.after,
        loan: shape(outcome.loan),
    });
});

module.exports = { summary, apply, repay, FEE_RATE };
