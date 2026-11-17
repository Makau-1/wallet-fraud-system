// Scoring retry queue (version 3).
//
// When the scoring model is unavailable a payment still goes ahead and is
// recorded as unscored (version 1 behaviour). This worker comes back to
// those payments: every 30 seconds it takes up to 20 unscored transfers,
// withdrawals and bank transfers from the last 48 hours and scores them
// with the features recorded at the time. The model score is combined with
// the signals that were recorded then, and if the result reaches the alert
// threshold an alert is raised for an analyst ("scored late").
//
// A late score cannot block anything: the money has already moved. What it
// does is make sure no risky payment escapes review just because the model
// was down. Each payment is tried at most 20 times.

const db = require('../config/db');
const { scoreTransaction } = require('./fraudService');
const riskEngine = require('./riskEngine');
const { featuresOf } = require('./modelOps');
const events = require('./events');
const metrics = require('./metrics');

const MAX_TRIES = 20;
let running = false;

async function runOnce() {
    if (running) return { skipped: true };
    running = true;
    let scored = 0;
    let flagged = 0;
    try {
        const [rows] = await db.query(
            `SELECT id, amount, metadata FROM transactions
             WHERE scoring_status = 'unscored'
               AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.type')) IN ('transfer', 'withdrawal', 'bank_transfer')
               AND created_at >= DATE_SUB(NOW(), INTERVAL 48 HOUR)
               AND COALESCE(JSON_EXTRACT(metadata, '$.seeded'), false) = false
               AND COALESCE(JSON_EXTRACT(metadata, '$.retry.tries'), 0) < ${MAX_TRIES}
             ORDER BY id LIMIT 20`);
        for (const row of rows) {
            const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
            const features = featuresOf(meta, row.amount);
            if (!features) continue;
            const model = await scoreTransaction(features);
            if (!model) {
                // Still unavailable: note the attempt and stop this round.
                meta.retry = { tries: ((meta.retry && meta.retry.tries) || 0) + 1, last: new Date().toISOString() };
                await db.execute('UPDATE transactions SET metadata = ? WHERE id = ?', [JSON.stringify(meta), row.id]);
                break;
            }
            const signals = (meta.risk && meta.risk.signals) || [];
            const modelScore = Math.min(1, Math.max(0, model.fraud_score));
            const risk = Math.round(riskEngine.combine(modelScore, signals) * 1e6) / 1e6;
            meta.risk = {
                ...(meta.risk || {}),
                score: risk,
                model_score: Math.round(modelScore * 1e6) / 1e6,
                base_value: typeof model.base_value === 'number' ? model.base_value : null,
                model_version: model.model_version || null,
                contributions: model.contributions || [],
                features,
                scored_late_at: new Date().toISOString(),
            };
            meta.retry = { tries: ((meta.retry && meta.retry.tries) || 0) + 1, last: new Date().toISOString() };
            const [updated] = await db.execute(
                "UPDATE transactions SET fraud_score = ?, scoring_status = 'scored', metadata = ? WHERE id = ? AND scoring_status = 'unscored'",
                [risk, JSON.stringify(meta), row.id]);
            if (!updated.affectedRows) continue;
            scored += 1;
            metrics.count('scored_late');
            if (risk >= riskEngine.ALERT_THRESHOLD) {
                const [existing] = await db.execute('SELECT id FROM fraud_alerts WHERE transaction_id = ?', [row.id]);
                if (!existing.length) {
                    const [alert] = await db.execute(
                        `INSERT INTO fraud_alerts (transaction_id, alert_type, score, status, notes)
                         VALUES (?, 'late_score', ?, 'pending', ?)`,
                        [row.id, risk, `Scored after the model came back. Model score ${meta.risk.model_score}; risk ${risk}`]);
                    flagged += 1;
                    events.toAdmins('alert.created', { alertId: alert.insertId, transactionId: row.id, late: true });
                }
            }
        }
    } catch (error) {
        console.error('[ScoringQueue]', error.message);
    } finally {
        running = false;
    }
    return { scored, flagged };
}

async function backlog() {
    const [[row]] = await db.query(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE scoring_status = 'unscored'
           AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.type')) IN ('transfer', 'withdrawal', 'bank_transfer')
           AND created_at >= DATE_SUB(NOW(), INTERVAL 48 HOUR)
           AND COALESCE(JSON_EXTRACT(metadata, '$.seeded'), false) = false`);
    return Number(row.n);
}

function start(intervalMs = 30000) {
    const timer = setInterval(runOnce, intervalMs);
    timer.unref();
}

module.exports = { runOnce, backlog, start };
