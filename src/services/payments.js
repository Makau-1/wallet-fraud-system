// Scored payments (version 2): transfers, withdrawals and bank transfers.
//
// One function handles all three, so the risk assessment, the PIN challenge
// and holds are applied in exactly one place. The attack lab calls the same
// function, so it exercises the real code path.
//
// Order of work:
//   1. validate the request and read the current balances
//   2. assess the risk (model score plus behavioural and network signals)
//   3. in enforce mode, apply the tier: allow, challenge with the PIN, or hold
//   4. in one database transaction: lock the wallets, re-check the balance,
//      move the money (or hold it), record the transaction with its risk
//      assessment, and raise an alert when the risk is at or above the threshold
//
// In advisory mode step 3 is skipped: every transaction completes and risky
// ones are flagged for review afterwards, which is the version 1 behaviour.

const bcrypt = require('bcrypt');
const db = require('../config/db');
const riskEngine = require('./riskEngine');
const { ServiceError, checkAmount, round2, withTransaction } = require('./ledger');

const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;

const KINDS = {
    transfer: { modelType: 'TRANSFER', done: 'Transfer successful', held: 'Transfer is on hold for review' },
    withdrawal: { modelType: 'CASH_OUT', done: 'Withdrawal successful', held: 'Withdrawal is on hold for review' },
    bank_transfer: { modelType: 'CASH_OUT', done: 'Bank transfer sent', held: 'Bank transfer is on hold for review' },
};

async function walletOf(userId) {
    const [rows] = await db.execute(
        `SELECT w.id, w.balance, u.id AS user_id, u.email, u.name,
                u.pin_hash, u.pin_failed_attempts,
                (u.pin_locked_until IS NOT NULL AND u.pin_locked_until > NOW()) AS pin_locked
         FROM wallets w JOIN users u ON u.id = w.user_id
         WHERE u.id = ? LIMIT 1`,
        [userId]
    );
    if (!rows.length) throw new ServiceError(404, 'Wallet not found');
    return rows[0];
}

async function walletByEmail(email) {
    const [rows] = await db.execute(
        `SELECT w.id, w.balance, u.id AS user_id, u.email, u.name
         FROM wallets w JOIN users u ON u.id = w.user_id
         WHERE LOWER(u.email) = ? LIMIT 1`,
        [String(email).trim().toLowerCase()]
    );
    return rows[0] || null;
}

// One payment at a time for each sender. The risk assessment reads the
// sender's recent history, so two payments assessed side by side would each
// miss the other, and a burst sent in parallel would slip past the velocity
// and split-payment signals. The same queue makes PIN attempts count one at
// a time. The queue lives in this process, which is enough while the
// website runs as a single process (see docs/DEPLOYMENT.md); several
// processes would need a shared lock instead.
const senderQueues = new Map();

function withSenderLock(userId, work) {
    const key = String(userId);
    const previous = senderQueues.get(key) || Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.catch(() => {});
    senderQueues.set(key, settled);
    settled.then(() => {
        if (senderQueues.get(key) === settled) senderQueues.delete(key);
    });
    return run;
}

// Checks the transaction PIN. Five wrong attempts lock it for 15 minutes.
// Called inside the sender lock, so the attempt count it reads is current.
async function verifyPin(sender, pin) {
    if (Number(sender.pin_locked)) {
        throw new ServiceError(423, `Too many wrong PIN attempts. Try again in ${PIN_LOCK_MINUTES} minutes.`);
    }
    const ok = typeof pin === 'string' && /^\d{4}$/.test(pin) && await bcrypt.compare(pin, sender.pin_hash);
    if (ok) {
        await db.execute('UPDATE users SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?', [sender.user_id]);
        return;
    }
    const attempts = Number(sender.pin_failed_attempts) + 1;
    const lock = attempts >= PIN_MAX_ATTEMPTS;
    await db.execute(
        `UPDATE users
         SET pin_failed_attempts = ?,
             pin_locked_until = IF(?, DATE_ADD(NOW(), INTERVAL ${PIN_LOCK_MINUTES} MINUTE), pin_locked_until)
         WHERE id = ?`,
        [lock ? 0 : attempts, lock, sender.user_id]
    );
    throw new ServiceError(403, lock
        ? `Incorrect PIN. The PIN is locked for ${PIN_LOCK_MINUTES} minutes.`
        : `Incorrect PIN. ${PIN_MAX_ATTEMPTS - attempts} attempts left.`);
}

// A challenge is returned to the client, which asks for the PIN and sends
// the same request again with it.
class Challenge extends ServiceError {
    constructor(challenge, message, assessment) {
        super(428, message);
        // Full detail, for the attack lab and the server only.
        this.risk = { score: assessment.risk, model_score: assessment.modelScore, tier: assessment.tier, reasons: assessment.signals.map(s => s.label) };
        // What the person making the payment is told.
        this.body = { message, challenge, risk: { tier: assessment.tier, reasons: publicReasons(assessment.signals) } };
    }
}

// Reasons shown to the person making the payment. They describe that
// person's own activity. Signals about the recipient's account are worded
// generally, so the sender learns nothing about someone else's activity,
// and no scores are included, so the response cannot be used to work out
// how far a payment is from the thresholds.
function publicReasons(signals) {
    return signals.map(signal => (signal.key === 'fan_in'
        ? 'The recipient\'s account shows unusual activity'
        : signal.label));
}

// The part of a result that is sent to the browser.
function publicResult(result) {
    if (!result.risk) {
        const { publicReasons: unused, ...plain } = result;
        return plain;
    }
    const { tier, action, scored } = result.risk;
    const { publicReasons: reasons, ...rest } = result;
    return { ...rest, risk: { tier, action, scored, reasons } };
}

// Executes one scored payment for a user.
//   kind: 'transfer' | 'withdrawal' | 'bank_transfer'
//   details: extra metadata to store (bank, account_masked)
async function execute(request) {
    const config = KINDS[request.kind];
    if (!config) throw new ServiceError(400, 'Unknown payment type');
    const amount = checkAmount(request.amount);
    return withSenderLock(request.userId, () => executeLocked({ ...request, amount, config }));
}

async function executeLocked({ userId, kind, amount, config, recipientEmail, pin, details = {} }) {
    const sender = await walletOf(userId);
    let recipient = null;
    if (kind === 'transfer') {
        if (typeof recipientEmail !== 'string' || !recipientEmail.trim()) {
            throw new ServiceError(400, 'Recipient email is required');
        }
        recipient = await walletByEmail(recipientEmail);
        if (!recipient) throw new ServiceError(404, 'Recipient not found');
        if (String(recipient.user_id) === String(sender.user_id)) {
            throw new ServiceError(400, 'You cannot transfer money to yourself');
        }
    }
    if (amount > Number(sender.balance)) throw new ServiceError(400, 'Insufficient funds');

    // Risk assessment, before any money moves.
    const assessment = await riskEngine.assess({
        modelType: config.modelType,
        amount,
        senderWalletId: sender.id,
        receiverWalletId: recipient ? recipient.id : null,
        senderBefore: Number(sender.balance),
        receiverBefore: recipient ? Number(recipient.balance) : 0,
    });

    const enforce = assessment.mode === 'enforce';
    let action = 'allowed';
    if (assessment.risk >= riskEngine.ALERT_THRESHOLD) action = 'flagged';

    if (enforce && assessment.tier === 'challenge') {
        if (!sender.pin_hash) {
            throw new Challenge('set_pin', 'This payment needs your transaction PIN. Set a PIN under Security, then try again.', assessment);
        }
        if (pin === undefined || pin === null || pin === '') {
            throw new Challenge('pin', 'This payment looks unusual. Enter your transaction PIN to confirm it is you.', assessment);
        }
        await verifyPin(sender, String(pin));
        action = 'verified';
    }
    const hold = enforce && assessment.tier === 'hold';
    if (hold) action = 'held';

    const outcome = await withTransaction(async (connection) => {
        // Lock the wallets in a consistent order, then re-check the balance.
        const ids = recipient ? [sender.id, recipient.id] : [sender.id];
        const [locked] = await connection.query(
            'SELECT id, balance FROM wallets WHERE id IN (?) ORDER BY id FOR UPDATE',
            [ids]
        );
        const senderRow = locked.find(row => String(row.id) === String(sender.id));
        const recipientRow = recipient ? locked.find(row => String(row.id) === String(recipient.id)) : null;
        if (!senderRow || (recipient && !recipientRow)) throw new ServiceError(404, 'Wallet not found');

        const senderBefore = Number(senderRow.balance);
        if (amount > senderBefore) throw new ServiceError(400, 'Insufficient funds');
        const senderAfter = round2(senderBefore - amount);

        await connection.execute('UPDATE wallets SET balance = balance - ? WHERE id = ?', [amount, sender.id]);

        const metadata = { type: kind, ...details, sender_balance_before: senderBefore, sender_balance_after: senderAfter };
        if (recipient) {
            const receiverBefore = Number(recipientRow.balance);
            metadata.receiver_balance_before = receiverBefore;
            if (hold) {
                // The money has left the sender but is not paid to the
                // recipient until an analyst releases it.
                metadata.receiver_balance_after = receiverBefore;
            } else {
                await connection.execute('UPDATE wallets SET balance = balance + ? WHERE id = ?', [amount, recipient.id]);
                metadata.receiver_balance_after = round2(receiverBefore + amount);
            }
        }
        metadata.risk = {
            mode: assessment.mode,
            action,
            tier: assessment.tier,
            score: assessment.risk,
            model_score: assessment.modelScore,
            base_value: assessment.baseValue ?? null,
            signals: assessment.signals,
            contributions: assessment.contributions,
        };

        const [result] = await connection.execute(
            `INSERT INTO transactions
                (amount, sender_wallet_id, receiver_wallet_id, status, metadata, fraud_score, scoring_status)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                amount,
                sender.id,
                recipient ? recipient.id : null,
                hold ? 'pending' : 'completed',
                JSON.stringify(metadata),
                assessment.scored ? assessment.risk : null,
                assessment.scored ? 'scored' : 'unscored',
            ]
        );

        // An alert is raised for held payments and for payments that were
        // flagged without a successful PIN check.
        if (action === 'held' || action === 'flagged') {
            const reasons = assessment.signals.map(s => s.label).join('; ') || 'model score';
            await connection.execute(
                `INSERT INTO fraud_alerts (transaction_id, alert_type, score, status, notes)
                 VALUES (?, ?, ?, 'pending', ?)`,
                [
                    result.insertId,
                    hold ? 'hold' : 'model_flag',
                    assessment.risk,
                    `Model score ${assessment.scored ? assessment.modelScore : 'unavailable'}; risk ${assessment.risk}; ${reasons}`,
                ]
            );
        }

        return { transactionId: result.insertId, senderAfter };
    });

    return {
        message: hold ? config.held : config.done,
        transactionId: outcome.transactionId,
        balance: outcome.senderAfter,
        ...(recipient ? { recipient: recipient.email } : {}),
        held: hold,
        risk: assessment.scored || action !== 'allowed'
            ? { score: assessment.risk, model_score: assessment.modelScore, tier: assessment.tier, action, scored: assessment.scored, reasons: assessment.signals.map(s => s.label) }
            : null,
        publicReasons: publicReasons(assessment.signals),
    };
}

// Settles a held payment when the analyst decides its alert.
//   release: the payment goes through (the recipient is credited)
//   reverse: the money goes back to the sender
// Runs inside the caller's database transaction.
async function settleHeld(connection, transactionId, decision) {
    const [rows] = await connection.execute(
        'SELECT id, amount, sender_wallet_id, receiver_wallet_id, status, metadata FROM transactions WHERE id = ? FOR UPDATE',
        [transactionId]
    );
    const tx = rows[0];
    if (!tx || tx.status !== 'pending') return null;

    const meta = typeof tx.metadata === 'string' ? JSON.parse(tx.metadata) : (tx.metadata || {});
    const amount = Number(tx.amount);
    meta.risk = meta.risk || {};

    if (decision === 'release') {
        if (tx.receiver_wallet_id) {
            const [walletRows] = await connection.execute('SELECT balance FROM wallets WHERE id = ? FOR UPDATE', [tx.receiver_wallet_id]);
            const before = Number(walletRows[0].balance);
            await connection.execute('UPDATE wallets SET balance = balance + ? WHERE id = ?', [amount, tx.receiver_wallet_id]);
            meta.receiver_balance_before = before;
            meta.receiver_balance_after = round2(before + amount);
        }
        meta.risk.action = 'released';
        await connection.execute("UPDATE transactions SET status = 'completed', metadata = ? WHERE id = ?", [JSON.stringify(meta), tx.id]);
        // If the held transfer was paying a money request, the request is
        // now paid. The request must match the transfer exactly.
        if (Number.isInteger(meta.request_id) && tx.receiver_wallet_id) {
            await connection.execute(
                `UPDATE money_requests
                 SET status = 'paid', transaction_id = ?, responded_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND status = 'pending'
                   AND payer_wallet_id = ? AND requester_wallet_id = ? AND amount = ?`,
                [tx.id, meta.request_id, tx.sender_wallet_id, tx.receiver_wallet_id, tx.amount]
            );
        }
        return 'released';
    }

    const [walletRows] = await connection.execute('SELECT balance FROM wallets WHERE id = ? FOR UPDATE', [tx.sender_wallet_id]);
    const before = Number(walletRows[0].balance);
    await connection.execute('UPDATE wallets SET balance = balance + ? WHERE id = ?', [amount, tx.sender_wallet_id]);
    meta.risk.action = 'reversed';
    meta.refund_balance_after = round2(before + amount);
    await connection.execute("UPDATE transactions SET status = 'failed', metadata = ? WHERE id = ?", [JSON.stringify(meta), tx.id]);
    return 'reversed';
}

// Sends the result of execute(), or its error, as the HTTP response.
async function respond(res, work) {
    try {
        const result = await work();
        return res.status(200).json(publicResult(result));
    } catch (error) {
        if (error instanceof ServiceError) {
            return res.status(error.status).json(error.body || { message: error.message });
        }
        console.error('[Payments]', error);
        return res.status(500).json({ message: 'Payment failed. Try again.' });
    }
}

module.exports = { execute, settleHeld, respond, Challenge };
