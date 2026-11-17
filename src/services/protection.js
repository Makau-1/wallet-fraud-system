// User protection (version 3): account freezes, "This wasn't me" disputes
// and reports about recipients.
//
//   Freeze      stops all money leaving an account until an administrator
//               restores it. A user can freeze their own account (a lost
//               phone, a suspicious message), and disputing a payment
//               freezes it automatically.
//   Dispute     "This wasn't me" on one of the user's own payments: the
//               account is frozen, any payment still on hold or cooling off
//               is returned, and an analyst reviews the claim. If the claim
//               is upheld, whatever the recipient still holds of the money
//               is recovered (a clawback) and the recipient is frozen.
//   Report      a user reports an account they have paid or been paid by.
//               Other users then see a warning before paying that account,
//               and the risk engine adds a signal.
//
// Decisions that move KES 10,000 or more (TWO_PERSON_THRESHOLD) need two
// different administrators: the first proposes and the second approves.

const db = require('../config/db');
const journal = require('./journal');
const audit = require('./audit');
const events = require('./events');
const { ServiceError, withTransaction, round2 } = require('./ledger');

const REPORT_REASONS = {
    scam: 'Scam or fraud',
    fake_goods: 'Paid for goods or services that never came',
    impersonation: 'Pretended to be someone else',
    unauthorised: 'Took money without permission',
    other: 'Something else',
};
const DISPUTABLE = ['transfer', 'withdrawal', 'bank_transfer', 'payment'];

function twoPersonThreshold() {
    const value = Number(process.env.TWO_PERSON_THRESHOLD);
    return Number.isFinite(value) && value > 0 ? value : 10000;
}

async function recipientStanding(userId) {
    const [[reports]] = await db.execute(
        `SELECT COUNT(DISTINCT reporter_id) AS n FROM recipient_reports
         WHERE reported_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)`, [userId]);
    const [[alerts]] = await db.execute(
        `SELECT COUNT(*) AS n FROM fraud_alerts fa
         JOIN transactions t ON t.id = fa.transaction_id
         JOIN wallets w ON w.id = t.receiver_wallet_id
         WHERE w.user_id = ? AND fa.status = 'confirmed_fraud'`, [userId]);
    const [[disputes]] = await db.execute(
        `SELECT COUNT(*) AS n FROM disputes d
         JOIN transactions t ON t.id = d.transaction_id
         JOIN wallets w ON w.id = t.receiver_wallet_id
         WHERE w.user_id = ? AND d.status = 'upheld'`, [userId]);
    return { reports: Number(reports.n), confirmed: Number(alerts.n) + Number(disputes.n) };
}

// The warning shown on the confirmation-of-payee step, or null.
async function payeeWarning(userId) {
    const standing = await recipientStanding(userId);
    if (standing.confirmed > 0) {
        return { level: 'high', text: 'Fraud has been confirmed on a payment to this account. Do not send money unless you are certain who it belongs to.' };
    }
    if (standing.reports > 0) {
        return {
            level: standing.reports >= 3 ? 'high' : 'medium',
            text: standing.reports === 1
                ? 'Another SecureWallet user has reported this account. Check who you are paying before you continue.'
                : `${standing.reports} SecureWallet users have reported this account. Check who you are paying before you continue.`,
        };
    }
    return null;
}

// Returns every payment of the user's that is still on hold or cooling off.
// When an administrator freezes an account (respectTwoPerson), a held
// payment at or above the two-person threshold that is waiting for an
// analyst stays held: returning it is a decision that needs a second
// administrator, made from the alert. A user disputing their own payment
// may always have their money returned to them.
async function cancelPendingOutgoing(connection, userId, notices, { respectTwoPerson = false } = {}) {
    const payments = require('./payments');
    const [rows] = await connection.execute(
        `SELECT t.id FROM transactions t JOIN wallets w ON w.id = t.sender_wallet_id
         WHERE w.user_id = ? AND t.status = 'pending'
           AND NOT (? AND t.amount >= ? AND EXISTS (
               SELECT 1 FROM fraud_alerts a WHERE a.transaction_id = t.id AND a.status = 'pending'))`,
        [userId, respectTwoPerson ? 1 : 0, twoPersonThreshold()]);
    const cancelled = [];
    for (const row of rows) {
        const outcome = await payments.settleHeld(connection, row.id, 'reverse', { action: 'cancelled', notices });
        if (outcome) cancelled.push(row.id);
    }
    return cancelled;
}

async function freeze(userId, reason, req, { cancelPending = true } = {}) {
    const notices = [];
    const cancelled = await withTransaction(async (connection) => {
        await connection.execute(
            'UPDATE users SET frozen_at = COALESCE(frozen_at, NOW()), frozen_reason = ? WHERE id = ?',
            [String(reason).slice(0, 255), userId]);
        const list = cancelPending ? await cancelPendingOutgoing(connection, userId, notices, { respectTwoPerson: true }) : [];
        await audit.record({ ...audit.actor(req), action: 'account.freeze', targetType: 'user', targetId: userId,
            details: { reason, cancelled: list } }, connection);
        return list;
    });
    notices.forEach(n => events.notify(n.userId, n));
    events.notify(userId, { kind: 'account_frozen', title: 'Your account is frozen', body: 'No money can leave it until it is restored.' });
    events.toAdmins('account.frozen', { userId, reason });
    return { cancelled };
}

async function unfreeze(userId, req) {
    const [result] = await db.execute(
        'UPDATE users SET frozen_at = NULL, frozen_reason = NULL WHERE id = ? AND frozen_at IS NOT NULL', [userId]);
    if (!result.affectedRows) throw new ServiceError(409, 'This account is not frozen');
    await audit.record({ ...audit.actor(req), action: 'account.restore', targetType: 'user', targetId: userId });
    events.notify(userId, { kind: 'account_restored', title: 'Your account has been restored', body: 'You can send money again.' });
    return { restored: true };
}

async function openDispute(userId, transactionId, reason, req) {
    const [rows] = await db.execute(
        `SELECT t.id, t.amount, t.status, t.created_at, JSON_UNQUOTE(JSON_EXTRACT(t.metadata, '$.type')) AS type,
                (t.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS recent
         FROM transactions t JOIN wallets w ON w.id = t.sender_wallet_id
         WHERE t.id = ? AND w.user_id = ?`, [transactionId, userId]);
    if (!rows.length) throw new ServiceError(404, 'Payment not found');
    const tx = rows[0];
    if (!DISPUTABLE.includes(tx.type)) throw new ServiceError(400, 'This kind of transaction cannot be disputed');
    if (!Number(tx.recent)) throw new ServiceError(409, 'Payments older than 30 days cannot be disputed here');

    const notices = [];
    const outcome = await withTransaction(async (connection) => {
        let disputeId;
        try {
            const [created] = await connection.execute(
                'INSERT INTO disputes (user_id, transaction_id, reason) VALUES (?, ?, ?)',
                [userId, transactionId, reason ? String(reason).slice(0, 500) : null]);
            disputeId = created.insertId;
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') throw new ServiceError(409, 'You have already reported this payment');
            throw error;
        }
        await connection.execute(
            "UPDATE users SET frozen_at = COALESCE(frozen_at, NOW()), frozen_reason = 'Reported an unauthorised payment' WHERE id = ?",
            [userId]);
        const cancelled = await cancelPendingOutgoing(connection, userId, notices);
        await audit.record({ ...audit.actor(req), action: 'dispute.open', targetType: 'transaction', targetId: transactionId,
            details: { disputeId, cancelled } }, connection);
        return { disputeId, cancelled };
    });
    notices.forEach(n => events.notify(n.userId, n));
    events.notify(userId, {
        kind: 'dispute_opened', title: 'We are looking into this payment',
        body: 'Your account is frozen so no more money can leave it. An analyst will contact you.',
    });
    events.toAdmins('dispute.created', { disputeId: outcome.disputeId, transactionId });
    return { ...outcome, frozen: true };
}

// Moves up to `amount` back from the recipient of a disputed transfer.
async function clawback(connection, tx, disputeId) {
    const ids = [tx.sender_wallet_id, tx.receiver_wallet_id].sort((a, b) => a - b);
    const [locked] = await connection.query('SELECT id, balance FROM wallets WHERE id IN (?) ORDER BY id FOR UPDATE', [ids]);
    const recipientRow = locked.find(w => String(w.id) === String(tx.receiver_wallet_id));
    if (!recipientRow) return 0;
    const recovered = round2(Math.min(Number(tx.amount), Number(recipientRow.balance)));
    if (recovered <= 0) return 0;
    await connection.execute('UPDATE wallets SET balance = balance - ? WHERE id = ?', [recovered, tx.receiver_wallet_id]);
    await connection.execute('UPDATE wallets SET balance = balance + ? WHERE id = ?', [recovered, tx.sender_wallet_id]);
    const [result] = await connection.execute(
        `INSERT INTO transactions (amount, sender_wallet_id, receiver_wallet_id, status, metadata)
         VALUES (?, ?, ?, 'completed', ?)`,
        [recovered, tx.receiver_wallet_id, tx.sender_wallet_id, JSON.stringify({
            type: 'clawback', dispute_id: disputeId, original_transaction_id: tx.id,
        })]);
    await journal.post(connection, {
        kind: 'clawback', transactionId: result.insertId,
        lines: [[journal.account.wallet(tx.receiver_wallet_id), -recovered], [journal.account.wallet(tx.sender_wallet_id), recovered]],
    });
    return recovered;
}

// An administrator decides a dispute. Returns { status } or, when a
// second administrator must approve, { awaitingSecondApproval: true }.
async function decideDispute(disputeId, decision, req) {
    if (!['upheld', 'rejected'].includes(decision)) throw new ServiceError(400, 'Decision must be upheld or rejected');
    const adminId = req.session.userId;
    const notices = [];
    const result = await withTransaction(async (connection) => {
        const [rows] = await connection.execute(
            `SELECT d.*, t.amount, t.status AS tx_status, t.sender_wallet_id, t.receiver_wallet_id,
                    JSON_UNQUOTE(JSON_EXTRACT(t.metadata, '$.type')) AS type, rw.balance AS recipient_balance,
                    rw.user_id AS recipient_user_id
             FROM disputes d JOIN transactions t ON t.id = d.transaction_id
             LEFT JOIN wallets rw ON rw.id = t.receiver_wallet_id
             WHERE d.id = ? FOR UPDATE`, [disputeId]);
        if (!rows.length) throw new ServiceError(404, 'Dispute not found');
        const d = rows[0];
        if (d.status !== 'open') throw new ServiceError(409, 'This dispute has already been decided');

        const recoverable = decision === 'upheld' && d.type === 'transfer' && d.tx_status === 'completed' && d.receiver_wallet_id
            ? Math.min(Number(d.amount), Number(d.recipient_balance || 0)) : 0;
        if (recoverable >= twoPersonThreshold()) {
            if (!d.proposed_status) {
                await connection.execute(
                    'UPDATE disputes SET proposed_status = ?, proposed_by = ?, proposed_at = NOW() WHERE id = ?',
                    [decision, adminId, disputeId]);
                await audit.record({ ...audit.actor(req), action: 'dispute.propose', targetType: 'dispute', targetId: disputeId,
                    details: { decision, recoverable } }, connection);
                return { awaitingSecondApproval: true, proposed: decision };
            }
            if (String(d.proposed_by) === String(adminId)) {
                throw new ServiceError(409, 'A second administrator must approve this decision');
            }
            if (d.proposed_status !== decision) {
                throw new ServiceError(409, `The first administrator proposed "${d.proposed_status}". Reject the proposal before choosing differently.`);
            }
        }

        let recovered = null;
        if (decision === 'upheld' && d.type === 'transfer' && d.tx_status === 'completed' && d.receiver_wallet_id) {
            recovered = await clawback(connection, d, disputeId);
            if (d.recipient_user_id) {
                await connection.execute(
                    "UPDATE users SET frozen_at = COALESCE(frozen_at, NOW()), frozen_reason = 'Received a payment confirmed as unauthorised' WHERE id = ?",
                    [d.recipient_user_id]);
                notices.push({ userId: d.recipient_user_id, kind: 'account_frozen', title: 'Your account is frozen',
                    body: 'A payment you received was confirmed as unauthorised. Contact support.' });
            }
        }
        await connection.execute(
            'UPDATE disputes SET status = ?, decided_by = ?, decided_at = NOW(), recovered_amount = ? WHERE id = ?',
            [decision, adminId, recovered, disputeId]);
        await audit.record({ ...audit.actor(req), action: d.proposed_status ? 'dispute.approve' : 'dispute.decide',
            targetType: 'dispute', targetId: disputeId, details: { decision, recovered, proposedBy: d.proposed_by || null } }, connection);
        notices.push({ userId: d.user_id, kind: 'dispute_decided',
            title: decision === 'upheld' ? 'Your claim was upheld' : 'Your claim was not upheld',
            body: decision === 'upheld'
                ? (recovered ? `KES ${Number(recovered).toFixed(2)} was recovered to your wallet.` : 'The recipient no longer held the money, so nothing could be recovered.')
                : 'An analyst found the payment was authorised. Contact support if you disagree.' });
        return { status: decision, recovered };
    });
    notices.forEach(n => events.notify(n.userId, n));
    return result;
}

async function rejectDisputeProposal(disputeId, req) {
    const [result] = await db.execute(
        `UPDATE disputes SET proposed_status = NULL, proposed_by = NULL, proposed_at = NULL
         WHERE id = ? AND status = 'open' AND proposed_status IS NOT NULL AND proposed_by <> ?`,
        [disputeId, req.session.userId]);
    if (!result.affectedRows) throw new ServiceError(409, 'There is no proposal from another administrator to reject');
    await audit.record({ ...audit.actor(req), action: 'dispute.reject_proposal', targetType: 'dispute', targetId: disputeId });
    return { cleared: true };
}

async function report(reporterId, { email, reason, details }) {
    if (!Object.prototype.hasOwnProperty.call(REPORT_REASONS, reason)) {
        throw new ServiceError(400, 'Choose a reason for the report');
    }
    const [users] = await db.execute(
        'SELECT u.id, w.id AS wallet_id FROM users u JOIN wallets w ON w.user_id = u.id WHERE LOWER(u.email) = ?',
        [String(email || '').trim().toLowerCase()]);
    if (!users.length) throw new ServiceError(404, 'No account uses that email address');
    const reported = users[0];
    if (String(reported.id) === String(reporterId)) throw new ServiceError(400, 'You cannot report your own account');

    // Only someone who has dealt with an account can report it, which keeps
    // reports meaningful and makes false mass-reporting harder.
    const [[dealt]] = await db.execute(
        `SELECT COUNT(*) AS n FROM transactions t
         JOIN wallets mine ON mine.user_id = ?
         WHERE ((t.sender_wallet_id = mine.id AND t.receiver_wallet_id = ?)
             OR (t.receiver_wallet_id = mine.id AND t.sender_wallet_id = ?))`,
        [reporterId, reported.wallet_id, reported.wallet_id]);
    if (Number(dealt.n) === 0) {
        throw new ServiceError(403, 'You can only report an account you have sent money to or received money from');
    }
    try {
        await db.execute(
            'INSERT INTO recipient_reports (reporter_id, reported_id, reason, details) VALUES (?, ?, ?, ?)',
            [reporterId, reported.id, reason, details ? String(details).slice(0, 500) : null]);
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') throw new ServiceError(409, 'You have already reported this account');
        throw error;
    }
    events.toAdmins('report.created', { reportedId: reported.id });
    return { reported: true };
}

async function reportedAccounts() {
    const [rows] = await db.query(
        `SELECT u.id, u.name, u.email, u.frozen_at, COUNT(DISTINCT r.reporter_id) AS reports,
                GROUP_CONCAT(DISTINCT r.reason ORDER BY r.reason) AS reasons, MAX(r.created_at) AS last_report
         FROM recipient_reports r JOIN users u ON u.id = r.reported_id
         GROUP BY u.id, u.name, u.email, u.frozen_at
         ORDER BY reports DESC, last_report DESC LIMIT 100`);
    return rows.map(r => ({ ...r, reasons: (r.reasons || '').split(',').filter(Boolean).map(k => REPORT_REASONS[k] || k) }));
}

async function disputes(status) {
    const [rows] = await db.execute(
        `SELECT d.id, d.status, d.reason, d.created_at, d.decided_at, d.recovered_amount, d.proposed_status,
                d.proposed_by, proposer.name AS proposed_by_name, decider.name AS decided_by_name,
                t.id AS transaction_id, t.amount, t.status AS transaction_status, t.created_at AS transaction_time,
                JSON_UNQUOTE(JSON_EXTRACT(t.metadata, '$.type')) AS type,
                su.name AS sender_name, su.email AS sender_email, ru.name AS recipient_name, ru.email AS recipient_email,
                rw.balance AS recipient_balance
         FROM disputes d
         JOIN transactions t ON t.id = d.transaction_id
         JOIN users su ON su.id = d.user_id
         LEFT JOIN wallets rw ON rw.id = t.receiver_wallet_id
         LEFT JOIN users ru ON ru.id = rw.user_id
         LEFT JOIN users proposer ON proposer.id = d.proposed_by
         LEFT JOIN users decider ON decider.id = d.decided_by
         WHERE (? IS NULL OR d.status = ?)
         ORDER BY d.created_at DESC LIMIT 100`, [status || null, status || null]);
    return rows;
}

module.exports = {
    REPORT_REASONS, twoPersonThreshold, recipientStanding, payeeWarning,
    freeze, unfreeze, openDispute, decideDispute, rejectDisputeProposal, report, reportedAccounts, disputes,
};
