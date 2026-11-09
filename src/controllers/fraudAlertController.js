
const db = require('../config/db');

const getFraudAlerts = async (req, res) => {
    try {
        const [alerts] = await db.execute(`
            SELECT
                fa.id,
                fa.transaction_id,
                fa.alert_type,
                fa.score,
                fa.status,
                fa.notes,
                fa.created_at,
                fa.updated_at,
                t.amount,
                t.status AS transaction_status
            FROM fraud_alerts fa
            LEFT JOIN transactions t
                ON t.id = fa.transaction_id
            ORDER BY fa.created_at DESC
        `);

        return res.status(200).json({
            count: alerts.length,
            alerts
        });
    } catch (error) {
        console.error('Get fraud alerts error:', error.message);

        return res.status(500).json({
            message: 'Failed to retrieve fraud alerts'
        });
    }
};

const updateFraudAlertStatus = async (req, res) => {
    try {
        const alertId = Number(req.params.id);
        const { status, notes } = req.body;

        if (!Number.isInteger(alertId) || alertId <= 0) {
            return res.status(400).json({
                message: 'Invalid alert ID'
            });
        }

        const allowedStatuses = ['confirmed_fraud', 'cleared'];

        if (!allowedStatuses.includes(status)) {
            return res.status(400).json({
                message: 'Status must be confirmed_fraud or cleared'
            });
        }

        const [result] = await db.execute(
            `UPDATE fraud_alerts
             SET status = ?,
                 notes = COALESCE(?, notes),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [status, notes ?? null, alertId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                message: 'Fraud alert not found'
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
