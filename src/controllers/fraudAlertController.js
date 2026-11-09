const db = require('../config/db');

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
                reviewer.name AS reviewed_by_name,
                t.amount,
                t.currency,
                t.metadata,
                t.created_at AS transaction_time,
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
            WHERE (? IS NULL OR fa.status = ?)
            ORDER BY fa.created_at DESC, fa.id DESC`,
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
// Records the decision, the reviewing administrator and
// the time of review. Only pending alerts can be reviewed,
// so a decision cannot be silently overwritten.
// ==================================================

const updateFraudAlertStatus = async (req, res) => {
    try {
        const alertId = Number(req.params.id);
        const { status, notes } = req.body;

        if (!Number.isInteger(alertId) || alertId <= 0) {
            return res.status(400).json({
                message: 'Invalid alert ID'
            });
        }

        if (!REVIEW_DECISIONS.includes(status)) {
            return res.status(400).json({
                message: 'Status must be confirmed_fraud or cleared'
            });
        }

        if (notes !== undefined && notes !== null && typeof notes !== 'string') {
            return res.status(400).json({
                message: 'Notes must be text'
            });
        }

        const [result] = await db.execute(
            `UPDATE fraud_alerts
             SET status = ?,
                 notes = COALESCE(?, notes),
                 reviewed_by = ?,
                 reviewed_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?
               AND status = 'pending'`,
            [status, notes ?? null, req.session.userId, alertId]
        );

        if (result.affectedRows === 0) {
            const [existing] = await db.execute(
                'SELECT status FROM fraud_alerts WHERE id = ? LIMIT 1',
                [alertId]
            );

            if (existing.length === 0) {
                return res.status(404).json({
                    message: 'Fraud alert not found'
                });
            }

            return res.status(409).json({
                message: 'This alert has already been reviewed'
            });
        }

        return res.status(200).json({
            message: 'Fraud alert status updated successfully',
            alertId,
            status
        });
    } catch (error) {
        console.error('Update fraud alert error:', error.message);

        return res.status(500).json({
            message: 'Failed to update fraud alert status'
        });
    }
};

module.exports = {
    getFraudAlerts,
    updateFraudAlertStatus
};
