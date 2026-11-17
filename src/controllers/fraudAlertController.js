const db = require('../config/db');
const { withTransaction, ServiceError, handle } = require('../services/ledger');
const payments = require('../services/payments');
const protection = require('../services/protection');
const audit = require('../services/audit');
const events = require('../services/events');

const ALERT_STATUSES = ['pending', 'confirmed_fraud', 'cleared'];
const REVIEW_DECISIONS = ['confirmed_fraud', 'cleared'];

// ==================================================
// LIST FRAUD ALERTS
// Optional filter: ?status=pending | confirmed_fraud | cleared
// ==================================================

const getFraudAlerts = async (req, res) => {
    try {
        const status = req.query.status;

        if (status !== undefined && !ALERT_STATUSES.includes(status)) {
            return res.status(400).json({
                message: 'Status must be pending, confirmed_fraud or cleared'
            });
        }

        const [alerts] = await db.execute(
            `SELECT
                fa.id,
                fa.transaction_id,
                fa.alert_type,
                fa.score,
                fa.status,
                fa.notes,
                fa.created_at,
                fa.reviewed_at,
                fa.proposed_status,
                fa.proposed_by,
                fa.proposed_at,
                fa.assigned_to,
                proposer.name AS proposed_by_name,
                assignee.name AS assigned_to_name,
                reviewer.name AS reviewed_by_name,
                (SELECT COUNT(*) FROM alert_notes n WHERE n.alert_id = fa.id) AS note_count,
                t.amount,
                t.currency,
                t.metadata,
                t.status AS transaction_status,
                t.created_at AS transaction_time,
                t.sender_wallet_id,
                t.receiver_wallet_id,
                sender.id AS sender_user_id,
                sender.email AS sender_email,
                sender.name AS sender_name,
                receiver.email AS receiver_email,
                receiver.name AS receiver_name
            FROM fraud_alerts fa
            JOIN transactions t
                ON t.id = fa.transaction_id
            LEFT JOIN wallets sw ON sw.id = t.sender_wallet_id
            LEFT JOIN users sender ON sender.id = sw.user_id
            LEFT JOIN wallets rw ON rw.id = t.receiver_wallet_id
            LEFT JOIN users receiver ON receiver.id = rw.user_id
            LEFT JOIN users reviewer ON reviewer.id = fa.reviewed_by
            LEFT JOIN users proposer ON proposer.id = fa.proposed_by
            LEFT JOIN users assignee ON assignee.id = fa.assigned_to
            WHERE (? IS NULL OR fa.status = ?)
            ORDER BY fa.created_at DESC, fa.id DESC
            LIMIT 200`,
            [status ?? null, status ?? null]
        );

        const [countRows] = await db.execute(
            `SELECT status, COUNT(*) AS total
             FROM fraud_alerts
             GROUP BY status`
        );

        const counts = { pending: 0, confirmed_fraud: 0, cleared: 0 };
        countRows.forEach(row => {
            counts[row.status] = Number(row.total);
        });

        return res.status(200).json({
            count: alerts.length,
            counts,
            twoPersonThreshold: protection.twoPersonThreshold(),
            me: req.session.userId,
            alerts
        });
    } catch (error) {
        console.error('Get fraud alerts error:', error.message);

        return res.status(500).json({
            message: 'Failed to retrieve fraud alerts'
        });
    }
};

// ==================================================
// REVIEW A FRAUD ALERT
// Records the decision, the reviewing administrator and the time of
// review. Only pending alerts can be reviewed, so a decision cannot be
// silently overwritten.
//
// Version 2: for a held payment, the decision also moves the money:
// clearing releases it to the recipient, confirming fraud refunds the
// sender.
// Version 3: if that held payment is KES 10,000 or more
// (TWO_PERSON_THRESHOLD), one administrator proposes and a different one
// approves (202 until then). Every step is written to the audit log.
// ==================================================

const updateFraudAlertStatus = async (req, res) => {
    try {
        const alertId = Number(req.params.id);
        const { status, notes } = req.body;

        if (!Number.isInteger(alertId) || alertId <= 0) {
            return res.status(400).json({ message: 'Invalid alert ID' });
        }
        if (!REVIEW_DECISIONS.includes(status)) {
            return res.status(400).json({ message: 'Status must be confirmed_fraud or cleared' });
        }
        if (notes !== undefined && notes !== null && typeof notes !== 'string') {
            return res.status(400).json({ message: 'Notes must be text' });
        }

        const adminId = req.session.userId;
        const notices = [];
        const outcome = await withTransaction(async (connection) => {
            const [rows] = await connection.execute(
                `SELECT fa.id, fa.status, fa.proposed_status, fa.proposed_by, fa.transaction_id,
                        t.amount, t.status AS transaction_status
                 FROM fraud_alerts fa JOIN transactions t ON t.id = fa.transaction_id
                 WHERE fa.id = ? FOR UPDATE`, [alertId]);
            if (!rows.length) return { notFound: true };
            const alert = rows[0];
            if (alert.status !== 'pending') return { alreadyReviewed: true };

            const movesMoney = alert.transaction_status === 'pending';
            const needsTwo = movesMoney && Number(alert.amount) >= protection.twoPersonThreshold();
            if (needsTwo) {
                if (!alert.proposed_status) {
                    await connection.execute(
                        'UPDATE fraud_alerts SET proposed_status = ?, proposed_by = ?, proposed_at = NOW() WHERE id = ?',
                        [status, adminId, alertId]);
                    await audit.record({ ...audit.actor(req), action: 'alert.propose', targetType: 'alert', targetId: alertId,
                        details: { decision: status, amount: Number(alert.amount) } }, connection);
                    return { proposed: status };
                }
                if (String(alert.proposed_by) === String(adminId)) {
                    throw new ServiceError(409, 'A second administrator must approve this decision');
                }
                if (alert.proposed_status !== status) {
                    throw new ServiceError(409, `The first administrator proposed "${alert.proposed_status === 'cleared' ? 'release' : 'confirm fraud'}". Reject the proposal before choosing differently.`);
                }
            }

            await connection.execute(
                `UPDATE fraud_alerts
                 SET status = ?,
                     notes = COALESCE(?, notes),
                     reviewed_by = ?,
                     reviewed_at = CURRENT_TIMESTAMP,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND status = 'pending'`,
                [status, notes ?? null, adminId, alertId]
            );
            const settlement = await payments.settleHeld(
                connection, alert.transaction_id, status === 'cleared' ? 'release' : 'reverse', { notices });
            await audit.record({ ...audit.actor(req), action: needsTwo ? 'alert.approve' : 'alert.decide',
                targetType: 'alert', targetId: alertId,
                details: { decision: status, settlement, amount: Number(alert.amount), proposedBy: alert.proposed_by || null } }, connection);
            return { settlement };
        });

        if (outcome.notFound) return res.status(404).json({ message: 'Fraud alert not found' });
        if (outcome.alreadyReviewed) return res.status(409).json({ message: 'This alert has already been reviewed' });
        if (outcome.proposed) {
            events.toAdmins('alert.updated', { alertId, proposed: outcome.proposed });
            return res.status(202).json({
                message: 'Decision recorded. A second administrator must approve it before the money moves.',
                alertId, awaitingSecondApproval: true, proposed: outcome.proposed,
            });
        }
        notices.forEach(n => events.notify(n.userId, n));
        events.toAdmins('alert.updated', { alertId, status });

        return res.status(200).json({
            message: 'Fraud alert status updated successfully',
            alertId,
            status,
            settlement: outcome.settlement
        });
    } catch (error) {
        if (error instanceof ServiceError) {
            return res.status(error.status).json({ message: error.message });
        }
        console.error('Update fraud alert error:', error.message);
        return res.status(500).json({ message: 'Failed to update fraud alert status' });
    }
};

// A second administrator turns down a proposal, so the alert can be
// decided afresh.
const rejectProposal = handle('FraudAlerts', async (req, res) => {
    const alertId = Number(req.params.id);
    const [result] = await db.execute(
        `UPDATE fraud_alerts SET proposed_status = NULL, proposed_by = NULL, proposed_at = NULL
         WHERE id = ? AND status = 'pending' AND proposed_status IS NOT NULL AND proposed_by <> ?`,
        [alertId, req.session.userId]);
    if (!result.affectedRows) throw new ServiceError(409, 'There is no proposal from another administrator to reject');
    await audit.record({ ...audit.actor(req), action: 'alert.reject_proposal', targetType: 'alert', targetId: alertId });
    events.toAdmins('alert.updated', { alertId });
    res.json({ cleared: true });
});

// ---------- case notes and assignment ----------

const listNotes = handle('FraudAlerts', async (req, res) => {
    const [rows] = await db.execute(
        `SELECT n.id, n.note, n.created_at, u.name AS author
         FROM alert_notes n LEFT JOIN users u ON u.id = n.author_id
         WHERE n.alert_id = ? ORDER BY n.id`, [Number(req.params.id)]);
    res.json({ notes: rows });
});

const addNote = handle('FraudAlerts', async (req, res) => {
    const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
    if (!note) throw new ServiceError(400, 'Write a note first');
    const alertId = Number(req.params.id);
    try {
        await db.execute('INSERT INTO alert_notes (alert_id, author_id, note) VALUES (?, ?, ?)',
            [alertId, req.session.userId, note.slice(0, 1000)]);
    } catch (error) {
        if (error.code === 'ER_NO_REFERENCED_ROW_2' || error.code === 'ER_NO_REFERENCED_ROW') throw new ServiceError(404, 'Alert not found');
        throw error;
    }
    await audit.record({ ...audit.actor(req), action: 'alert.note', targetType: 'alert', targetId: alertId });
    res.status(201).json({ added: true });
});

const assign = handle('FraudAlerts', async (req, res) => {
    const alertId = Number(req.params.id);
    const to = req.body.unassign ? null : req.session.userId;
    const [result] = await db.execute("UPDATE fraud_alerts SET assigned_to = ? WHERE id = ? AND status = 'pending'", [to, alertId]);
    if (!result.affectedRows) throw new ServiceError(409, 'Only an alert waiting for review can be assigned');
    await audit.record({ ...audit.actor(req), action: to ? 'alert.assign' : 'alert.unassign', targetType: 'alert', targetId: alertId });
    events.toAdmins('alert.updated', { alertId });
    res.json({ assignedTo: to });
});

module.exports = {
    getFraudAlerts,
    updateFraudAlertStatus,
    rejectProposal,
    listNotes,
    addNote,
    assign
};
