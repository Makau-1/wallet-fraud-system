// Scored payments (versions 2 and 3): transfers, withdrawals and bank
// transfers.
//
// One function handles all three, so the scam check, the risk assessment,
// the PIN challenge, holds and cooling-off are applied in exactly one
// place. The website, the USSD menu and the attack lab all call it, so each
// exercises the same code path.
//
// Order of work:
//   1. validate the request; refuse it if the account is frozen
//   2. scam check (enforce mode): a first, larger transfer to someone needs
//      the sender to say what it is for
//   3. assess the risk: model score plus behavioural, network, device,
//      recipient-report and purpose signals
//   4. in enforce mode, apply the tier: allow, challenge with the PIN, or
//      hold; a risky purpose adds a cooling-off period instead of sending
//   5. in one database transaction: lock the wallets, re-check the balance,
//      move the money (or put it on hold), record the transaction with its
//      assessment, post the double-entry journal entry, and raise an alert
//      when the risk is at or above the threshold
//   6. after commit: notify the recipient, the sender and the analysts
//
// In advisory mode steps 2 and 4 are skipped: every transaction completes
// and risky ones are flagged for review afterwards (the version 1 behaviour).

const bcrypt = require('bcrypt');
const db = require('../config/db');
const riskEngine = require('./riskEngine');
const journal = require('./journal');
const events = require('./events');
const metrics = require('./metrics');
const { ServiceError, checkAmount, round2, withTransaction, checkNotFrozen } = require('./ledger');

const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;

const KINDS = {
    transfer: { modelType: 'TRANSFER', done: 'Transfer successful', held: 'Transfer is on hold for review', title: 'Transfer' },
    withdrawal: { modelType: 'CASH_OUT', done: 'Withdrawal successful', held: 'Withdrawal is on hold for review', title: 'Withdrawal' },
    bank_transfer: { modelType: 'CASH_OUT', done: 'Bank transfer sent', held: 'Bank transfer is on hold for review', title: 'Bank transfer' },
};

// Why the money is being sent. The risky answers are the ones scammers
// coach their victims into: a caller or message telling them to pay, an
// "investment", a fee to claim a job, prize or loan, or "returning" money
// someone claims to have sent by mistake.
const PURPOSES = [
    { key: 'family_friends', label: 'Family or friends' },
    { key: 'goods_services', label: 'Paying for goods or services' },
    { key: 'bills_rent', label: 'Bills, rent or school fees' },
    { key: 'asked_by_caller', label: 'Someone called or messaged and asked me to pay', risky: true },
    { key: 'investment', label: 'An investment or trading opportunity', risky: true },
    { key: 'job_prize_loan', label: 'A fee to get a job, prize or loan', risky: true },
    { key: 'sent_by_mistake', label: 'Returning money someone says they sent me by mistake', risky: true },
    { key: 'other', label: 'Something else' },
];
const PURPOSE_BY_KEY = new Map(PURPOSES.map(p => [p.key, p]));

function scamCheckMin() {
    const value = Number(process.env.SCAM_CHECK_MIN);
    return Number.isFinite(value) && value >= 0 ? value : 1000;
}

function coolingOffMinutes() {
    const value = Number(process.env.COOLING_OFF_MINUTES);
    return Number.isFinite(value) && value >= 0 ? value : 30;
}

async function walletOf(userId) {
    const [rows] = await db.execute(
        `SELECT w.id, w.balance, u.id AS user_id, u.email, u.name, u.frozen_at,
                u.pin_hash, u.pin_failed_attempts,
                (u.pin_locked_until IS NOT NULL AND u.pin_locked_until > NOW()) AS pin_locked
         FROM wallets w JOIN users u ON u.id = w.user_id
         WHERE u.id = ? LIMIT 1`,
        [userId]
    );
    if (!rows.length) throw new ServiceError(404, 'Wallet not found');
    return rows[0];
}

// Finds a recipient by email address or by Kenyan mobile number, so money
// can be sent to a phone number as with M-Pesa.
function phoneKey(raw) {
    const digits = String(raw || '').replace(/[\s()-]/g, '').replace(/^\+/, '');
    if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
    return /^254[17]\d{8}$/.test(digits) ? digits : null;
}

async function walletByEmail(identifier) {
    const value = String(identifier).trim();
    const phone = value.includes('@') ? null : phoneKey(value);
    const [rows] = await db.execute(
        `SELECT w.id, w.balance, u.id AS user_id, u.email, u.name
         FROM wallets w JOIN users u ON u.id = w.user_id
         WHERE ${phone ? 'u.phone = ?' : 'LOWER(u.email) = ?'} LIMIT 1`,
        [phone || value.toLowerCase()]
    );
    return rows[0] || null;
}

async function findRecipient(identifier) {
    const wallet = await walletByEmail(identifier);
    return wallet ? { id: wallet.user_id, name: wallet.name, email: wallet.email } : null;
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
    if (!sender.pin_hash) {
        throw new ServiceError(428, 'Set a transaction PIN under Security first.', {
            message: 'Set a transaction PIN under Security first.', challenge: 'set_pin',
        });
    }
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

// Checks a user's PIN on its own (the USSD balance and statement menus).
function checkPinFor(userId, pin) {
    return withSenderLock(userId, async () => verifyPin(await walletOf(userId), String(pin || '')));
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

// Asks the sender what the payment is for, before anything is assessed.
class PurposeChallenge extends ServiceError {
    constructor() {
        const message = 'Before you send money to someone new, tell us what it is for.';
        super(428, message);
        this.risk = null;
        this.body = { message, challenge: 'purpose', purposes: PURPOSES.map(({ key, label, risky }) => ({ key, label, risky: Boolean(risky) })) };
    }
}

// Reasons shown to the person making the payment. They describe that
// person's own activity. Signals about the recipient's account are worded
// generally, so the sender learns nothing about someone else's activity,
// and no scores are included, so the response cannot be used to work out
// how far a payment is from the thresholds.
const RECIPIENT_SIGNALS = new Set(['fan_in', 'reported_recipient']);

function publicReasons(signals) {
    return signals.map(signal => (RECIPIENT_SIGNALS.has(signal.key)
        ? 'The recipient\'s account shows unusual activity'
        : signal.label));
}

// The part of a result that is sent to the browser.
function publicResult(result) {
    const { publicReasons: reasons, ...rest } = result;
    if (!rest.risk) return rest;
    const { tier, action, scored } = rest.risk;
    return { ...rest, risk: { tier, action, scored, reasons } };
}

// Signals about the recipient, from other users' reports and from fraud
// confirmed on payments to them (services/protection.js).
async function recipientSignals(recipientUserId) {
    const protection = require('./protection');
    const standing = await protection.recipientStanding(recipientUserId);
    if (standing.confirmed > 0) {
        return [{ key: 'reported_recipient', weight: 0.5, label: 'Fraud has been confirmed on a payment to this recipient' }];
    }
    if (standing.reports >= 3) {
        return [{ key: 'reported_recipient', weight: 0.4, label: `${standing.reports} users have reported this recipient` }];
    }
    if (standing.reports >= 1) {
        return [{ key: 'reported_recipient', weight: 0.2, label: 'Another user has reported this recipient' }];
    }
    return [];
}

async function paidBefore(senderWalletId, recipientWalletId) {
    const [rows] = await db.execute(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE sender_wallet_id = ? AND receiver_wallet_id = ? AND status = 'completed'`,
        [senderWalletId, recipientWalletId]);
    return Number(rows[0].n) > 0;
}

// Executes one scored payment for a user.
//   kind:     'transfer' | 'withdrawal' | 'bank_transfer'
//   details:  extra metadata to store (bank, account_masked, request_id)
//   purpose:  the sender's answer to the scam check
//   requirePin: check the PIN whatever the risk (USSD always does)
//   context:  { newDevice, channel } from the caller
async function execute(request) {
    const config = KINDS[request.kind];
    if (!config) throw new ServiceError(400, 'Unknown payment type');
    const amount = checkAmount(request.amount);
    const started = Date.now();
    try {
        return await withSenderLock(request.userId, () => executeLocked({ ...request, amount, config }));
    } finally {
        metrics.observe('payment_ms', Date.now() - started);
    }
}

async function executeLocked({ userId, kind, amount, config, recipientEmail, pin, purpose, requirePin = false, context = {}, details = {} }) {
    const sender = await walletOf(userId);
    if (sender.frozen_at) {
        throw new ServiceError(423, 'This account is frozen, so no money can leave it. Contact support to restore it.',
            { message: 'This account is frozen, so no money can leave it. Contact support to restore it.', frozen: true });
    }
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

    const enforce = riskEngine.mode() === 'enforce';

    // Scam check: in enforce mode, a first transfer of SCAM_CHECK_MIN or
    // more to someone needs the sender to say what it is for.
    let chosen = null;
    if (purpose !== undefined && purpose !== null && purpose !== '') {
        chosen = PURPOSE_BY_KEY.get(String(purpose));
        if (!chosen) throw new ServiceError(400, 'Choose what the payment is for from the list');
    }
    const firstTime = recipient ? !(await paidBefore(sender.id, recipient.id)) : false;
    if (enforce && recipient && firstTime && amount >= scamCheckMin() && !chosen) {
        throw new PurposeChallenge();
    }

    const extraSignals = [];
    if (context.newDevice) {
        extraSignals.push({ key: 'new_device', weight: 0.25, label: 'Payment from a device first used in the last 24 hours' });
        // The usual account-takeover pattern: a new device paying someone
        // the account had not paid before that device appeared.
        if (recipient) {
            const [[first]] = await db.execute(
                `SELECT MIN(created_at) >= DATE_SUB(NOW(), INTERVAL 24 HOUR) AS recent, COUNT(*) AS n FROM transactions
                 WHERE sender_wallet_id = ? AND receiver_wallet_id = ? AND status = 'completed'`, [sender.id, recipient.id]);
            if (Number(first.n) === 0 || Number(first.recent)) {
                extraSignals.push({ key: 'new_device_new_payee', weight: 0.35, label: 'Paying someone new from a device first used in the last 24 hours' });
            }
        }
    }
    if (recipient) extraSignals.push(...await recipientSignals(recipient.user_id));
    if (chosen && chosen.risky) {
        extraSignals.push({ key: 'scam_purpose', weight: 0.3, label: `Sender says the payment is: ${chosen.label.toLowerCase()}` });
    }

    // Risk assessment, before any money moves.
    const assessment = await riskEngine.assess({
        modelType: config.modelType,
        amount,
        senderWalletId: sender.id,
        receiverWalletId: recipient ? recipient.id : null,
        senderBefore: Number(sender.balance),
        receiverBefore: recipient ? Number(recipient.balance) : 0,
        extraSignals,
    });

    let action = 'allowed';
    if (assessment.risk >= riskEngine.ALERT_THRESHOLD) action = 'flagged';

    if (requirePin) {
        await verifyPin(sender, String(pin || ''));
        if (enforce && assessment.tier === 'challenge') action = 'verified';
    } else if (enforce && assessment.tier === 'challenge') {
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
    // A risky purpose delays the payment, so the sender has time to think
    // or to talk to someone, and can cancel it.
    const cooling = enforce && !hold && Boolean(chosen && chosen.risky);
    const coolingUntil = cooling ? new Date(Date.now() + coolingOffMinutes() * 60000).toISOString() : null;
    if (cooling) action = 'cooling_off';
    const pending = hold || cooling;

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
        await checkNotFrozen(connection, sender.id);

        const senderBefore = Number(senderRow.balance);
        if (amount > senderBefore) throw new ServiceError(400, 'Insufficient funds');
        const senderAfter = round2(senderBefore - amount);

        await connection.execute('UPDATE wallets SET balance = balance - ? WHERE id = ?', [amount, sender.id]);

        const metadata = { type: kind, ...details, sender_balance_before: senderBefore, sender_balance_after: senderAfter };
        if (context.channel) metadata.channel = context.channel;
        if (recipient) {
            const receiverBefore = Number(recipientRow.balance);
            metadata.receiver_balance_before = receiverBefore;
            if (pending) {
                // The money has left the sender but is not paid to the
                // recipient until it is released.
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
            model_version: assessment.modelVersion,
            shadow: assessment.shadow,
            features: assessment.features,
            signals: assessment.signals,
            contributions: assessment.contributions,
        };
        if (chosen) metadata.purpose = { key: chosen.key, label: chosen.label, risky: Boolean(chosen.risky) };
        if (coolingUntil) metadata.cooling_until = coolingUntil;

        const [result] = await connection.execute(
            `INSERT INTO transactions
                (amount, sender_wallet_id, receiver_wallet_id, status, metadata, fraud_score, scoring_status)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                amount,
                sender.id,
                recipient ? recipient.id : null,
                pending ? 'pending' : 'completed',
                JSON.stringify(metadata),
                assessment.scored ? assessment.risk : null,
                assessment.scored ? 'scored' : 'unscored',
            ]
        );
        const transactionId = result.insertId;

        const destination = recipient
            ? journal.account.wallet(recipient.id)
            : journal.account.external(kind === 'bank_transfer' ? 'bank' : 'cash');
        await journal.post(connection, {
            kind,
            transactionId,
            lines: [
                [journal.account.wallet(sender.id), -amount],
                [pending ? journal.account.held(transactionId) : destination, amount],
            ],
        });

        // An alert is raised for held payments and for payments that were
        // flagged without a successful PIN check.
        let alertId = null;
        // A cooling-off payment raises no alert of its own: the sender has
        // confirmed it (with the PIN if the risk called for it) and can still
        // cancel it, and a high-risk payment is held rather than cooled off.
        if (action === 'held' || action === 'flagged') {
            const reasons = assessment.signals.map(s => s.label).join('; ') || 'model score';
            const [alert] = await connection.execute(
                `INSERT INTO fraud_alerts (transaction_id, alert_type, score, status, notes)
                 VALUES (?, ?, ?, 'pending', ?)`,
                [
                    transactionId,
                    hold ? 'hold' : (cooling ? 'cooling_off' : 'model_flag'),
                    assessment.risk,
                    `Model score ${assessment.scored ? assessment.modelScore : 'unavailable'}; risk ${assessment.risk}; ${reasons}`,
                ]
            );
            alertId = alert.insertId;
        }

        return { transactionId, senderAfter, alertId };
    });

    // Tell the people involved. Failures here never undo the payment.
    const money = `KES ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (recipient && !pending) {
        events.notify(recipient.user_id, {
            kind: 'money_received', title: `You received ${money}`, body: `From ${sender.name}`,
        });
    }
    if (hold) {
        events.notify(sender.user_id, {
            kind: 'payment_held', title: `${config.title} of ${money} is on hold`,
            body: 'It has left your balance but has not been paid out. An analyst will release it or return it to you.',
        });
    }
    if (cooling) {
        events.notify(sender.user_id, {
            kind: 'cooling_off', title: `${config.title} of ${money} will be sent later`,
            body: 'You can cancel it from your activity until then.',
        });
    }
    if (outcome.alertId) {
        events.toAdmins('alert.created', { alertId: outcome.alertId, transactionId: outcome.transactionId, amount, risk: assessment.risk, action });
    }

    return {
        message: hold ? config.held : (cooling ? `${config.title} will be sent after a cooling-off period` : config.done),
        transactionId: outcome.transactionId,
        balance: outcome.senderAfter,
        ...(recipient ? { recipient: recipient.email } : {}),
        held: hold,
        ...(cooling ? { coolingOff: { until: coolingUntil, minutes: coolingOffMinutes() } } : {}),
        risk: assessment.scored || action !== 'allowed'
            ? { score: assessment.risk, model_score: assessment.modelScore, tier: assessment.tier, action, scored: assessment.scored, reasons: assessment.signals.map(s => s.label) }
            : null,
        publicReasons: publicReasons(assessment.signals),
    };
}

// Settles a held or cooling-off payment.
//   release: the payment goes through (the recipient is credited)
//   reverse: the money goes back to the sender
// Runs inside the caller's database transaction. `notices` collects the
// notifications to send once that transaction has committed.
async function settleHeld(connection, transactionId, decision, { action, notices } = {}) {
    const [rows] = await connection.execute(
        'SELECT id, amount, sender_wallet_id, receiver_wallet_id, status, metadata FROM transactions WHERE id = ? FOR UPDATE',
        [transactionId]
    );
    const tx = rows[0];
    if (!tx || tx.status !== 'pending') return null;

    const meta = typeof tx.metadata === 'string' ? JSON.parse(tx.metadata) : (tx.metadata || {});
    const amount = Number(tx.amount);
    meta.risk = meta.risk || {};
    const owner = async walletId => {
        if (!walletId) return null;
        const [u] = await connection.execute('SELECT user_id FROM wallets WHERE id = ?', [walletId]);
        return u.length ? u[0].user_id : null;
    };
    const money = `KES ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    if (decision === 'release') {
        let destination = journal.account.external(meta.type === 'bank_transfer' ? 'bank' : 'cash');
        if (tx.receiver_wallet_id) {
            const [walletRows] = await connection.execute('SELECT balance FROM wallets WHERE id = ? FOR UPDATE', [tx.receiver_wallet_id]);
            const before = Number(walletRows[0].balance);
            await connection.execute('UPDATE wallets SET balance = balance + ? WHERE id = ?', [amount, tx.receiver_wallet_id]);
            meta.receiver_balance_before = before;
            meta.receiver_balance_after = round2(before + amount);
            destination = journal.account.wallet(tx.receiver_wallet_id);
        }
        meta.risk.action = 'released';
        if (action) meta.risk.released_by = action;
        await connection.execute("UPDATE transactions SET status = 'completed', metadata = ? WHERE id = ?", [JSON.stringify(meta), tx.id]);
        await journal.post(connection, {
            kind: 'release', transactionId: tx.id,
            lines: [[journal.account.held(tx.id), -amount], [destination, amount]],
        });
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
        if (notices) {
            const senderUser = await owner(tx.sender_wallet_id);
            const recipientUser = await owner(tx.receiver_wallet_id);
            if (senderUser) notices.push({ userId: senderUser, kind: 'payment_released', title: `Your payment of ${money} has been sent` });
            if (recipientUser) notices.push({ userId: recipientUser, kind: 'money_received', title: `You received ${money}` });
        }
        return 'released';
    }

    const [walletRows] = await connection.execute('SELECT balance FROM wallets WHERE id = ? FOR UPDATE', [tx.sender_wallet_id]);
    const before = Number(walletRows[0].balance);
    await connection.execute('UPDATE wallets SET balance = balance + ? WHERE id = ?', [amount, tx.sender_wallet_id]);
    meta.risk.action = action === 'cancelled' ? 'cancelled' : 'reversed';
    meta.refund_balance_after = round2(before + amount);
    await connection.execute("UPDATE transactions SET status = 'failed', metadata = ? WHERE id = ?", [JSON.stringify(meta), tx.id]);
    await journal.post(connection, {
        kind: action === 'cancelled' ? 'cancel' : 'reverse', transactionId: tx.id,
        lines: [[journal.account.held(tx.id), -amount], [journal.account.wallet(tx.sender_wallet_id), amount]],
    });
    if (notices) {
        const senderUser = await owner(tx.sender_wallet_id);
        if (senderUser) {
            notices.push({ userId: senderUser, kind: 'payment_returned', title: `${money} was returned to your wallet`,
                body: action === 'cancelled' ? 'You cancelled the payment.' : 'The payment was stopped after review.' });
        }
    }
    return 'reversed';
}

// Releases cooling-off payments whose time has come, unless an analyst
// still has an alert open on them. Run every few seconds by the server.
async function releaseDueCoolingOff() {
    const [rows] = await db.query(
        `SELECT t.id, JSON_UNQUOTE(JSON_EXTRACT(t.metadata, '$.cooling_until')) AS until_at
         FROM transactions t
         LEFT JOIN fraud_alerts fa ON fa.transaction_id = t.id AND fa.status = 'pending'
         WHERE t.status = 'pending'
           AND JSON_UNQUOTE(JSON_EXTRACT(t.metadata, '$.risk.action')) = 'cooling_off'
           AND fa.id IS NULL
         LIMIT 50`);
    let released = 0;
    for (const row of rows) {
        if (!row.until_at || Date.parse(row.until_at) > Date.now()) continue;
        const notices = [];
        const outcome = await withTransaction(connection => settleHeld(connection, row.id, 'release', { action: 'cooling_off_ended', notices }));
        if (outcome) {
            released += 1;
            notices.forEach(n => events.notify(n.userId, n));
        }
    }
    return released;
}

// Lets the sender cancel their own payment while it is cooling off.
async function cancelCoolingOff(userId, transactionId) {
    const notices = [];
    const outcome = await withTransaction(async (connection) => {
        const [rows] = await connection.execute(
            `SELECT t.id, t.status, JSON_UNQUOTE(JSON_EXTRACT(t.metadata, '$.risk.action')) AS action
             FROM transactions t JOIN wallets w ON w.id = t.sender_wallet_id
             WHERE t.id = ? AND w.user_id = ? FOR UPDATE`, [transactionId, userId]);
        if (!rows.length) throw new ServiceError(404, 'Payment not found');
        if (rows[0].status !== 'pending' || rows[0].action !== 'cooling_off') {
            throw new ServiceError(409, 'Only a payment that is still cooling off can be cancelled');
        }
        await connection.execute(
            "UPDATE fraud_alerts SET status = 'cleared', notes = CONCAT(COALESCE(notes, ''), ' | Cancelled by the sender'), reviewed_at = CURRENT_TIMESTAMP WHERE transaction_id = ? AND status = 'pending'",
            [transactionId]);
        return settleHeld(connection, transactionId, 'reverse', { action: 'cancelled', notices });
    });
    notices.forEach(n => events.notify(n.userId, n));
    return outcome;
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

// Before test or lab accounts are deleted: a payment still on hold or
// cooling off from a real account to one of them goes back to its sender,
// so deleting the test account cannot take a real user's money with it.
async function refundHeldToClosing(connection, walletIds) {
    if (!walletIds.length) return [];
    const [rows] = await connection.query(
        `SELECT id FROM transactions WHERE status = 'pending'
           AND receiver_wallet_id IN (?) AND (sender_wallet_id IS NULL OR sender_wallet_id NOT IN (?))`,
        [walletIds, walletIds]);
    const refunded = [];
    for (const row of rows) {
        if (await settleHeld(connection, row.id, 'reverse', { action: 'cancelled', notices: [] })) refunded.push(row.id);
    }
    return refunded;
}

module.exports = {
    execute, settleHeld, refundHeldToClosing, respond, releaseDueCoolingOff, cancelCoolingOff, checkPinFor,
    Challenge, PurposeChallenge, PURPOSES, publicResult, walletOf, findRecipient, phoneKey,
};
