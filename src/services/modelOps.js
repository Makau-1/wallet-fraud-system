// Model operations (version 3): the website side of the feedback loop.
//
//   labels      every decision an analyst or a client has made about a
//               payment becomes a labelled example: a confirmed alert or an
//               upheld dispute is fraud (1); a cleared alert or a rejected
//               dispute is legitimate (0); fraud API clients send their own
//               labels
//   retrain     sends the examples to the scoring service, which trains a
//               challenger on PaySim plus these examples
//   shadow      the challenger scores live payments alongside the champion;
//               this compares the two, overall and on labelled payments
//   drift       compares the feature values of recent live payments with
//               the training data
//   promote / rollback / discard  change which model is in charge
//
// Every change is written to the audit log.

const db = require('../config/db');
const audit = require('./audit');

const ML_URL = (process.env.ML_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');

async function ml(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${ML_URL}${path}`, {
        method,
        headers: {
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(process.env.ML_ADMIN_TOKEN ? { 'X-ML-Admin-Token': process.env.ML_ADMIN_TOKEN } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
    });
    let data = {};
    try { data = await response.json(); } catch (e) { data = {}; }
    if (!response.ok) {
        const error = new Error(data.detail || `Scoring service returned ${response.status}`);
        error.status = response.status === 404 || response.status === 409 ? response.status : 502;
        throw error;
    }
    return data;
}

function parse(meta) {
    if (!meta) return {};
    return typeof meta === 'string' ? JSON.parse(meta) : meta;
}

const MODEL_TYPE = { transfer: 'TRANSFER', withdrawal: 'CASH_OUT', bank_transfer: 'CASH_OUT' };

// The transaction as the model saw it, from what was stored with it.
function featuresOf(meta, amount) {
    if (meta.risk && meta.risk.features) return meta.risk.features;
    const type = MODEL_TYPE[meta.type];
    if (!type || meta.sender_balance_before === undefined) return null;
    const hasRecipient = meta.receiver_balance_before !== undefined;
    return {
        type,
        amount: Number(amount),
        oldbalanceOrg: Number(meta.sender_balance_before),
        newbalanceOrig: Number(meta.sender_balance_after),
        oldbalanceDest: hasRecipient ? Number(meta.receiver_balance_before) : 0,
        newbalanceDest: hasRecipient ? Math.round((Number(meta.receiver_balance_before) + Number(amount)) * 100) / 100 : 0,
    };
}

async function labelledExamples() {
    const byTx = new Map();
    const [alerts] = await db.query(
        `SELECT t.id, t.amount, t.metadata, fa.status
         FROM fraud_alerts fa JOIN transactions t ON t.id = fa.transaction_id
         WHERE fa.status IN ('confirmed_fraud', 'cleared')`);
    alerts.forEach(a => byTx.set(`w${a.id}`, { ...a, label: a.status === 'confirmed_fraud' ? 1 : 0, source: 'alert' }));
    const [disputes] = await db.query(
        `SELECT t.id, t.amount, t.metadata, d.status
         FROM disputes d JOIN transactions t ON t.id = d.transaction_id
         WHERE d.status IN ('upheld', 'rejected')`);
    disputes.forEach(d => byTx.set(`w${d.id}`, { ...d, label: d.status === 'upheld' ? 1 : 0, source: 'dispute' }));

    const examples = [];
    const counts = { alert: 0, dispute: 0, api: 0, fraud: 0, legit: 0, skipped: 0 };
    byTx.forEach(row => {
        const features = featuresOf(parse(row.metadata), row.amount);
        if (!features) { counts.skipped += 1; return; }
        examples.push({ ...features, label: row.label });
        counts[row.source] += 1;
        counts[row.label ? 'fraud' : 'legit'] += 1;
    });

    const [apiRows] = await db.query("SELECT features, label FROM api_events WHERE label IS NOT NULL AND features IS NOT NULL");
    apiRows.forEach(r => {
        const features = parse(r.features);
        const label = r.label === 'fraud' ? 1 : 0;
        examples.push({ ...features, label });
        counts.api += 1;
        counts[label ? 'fraud' : 'legit'] += 1;
    });
    return { examples, counts };
}

// How the challenger compares with the champion on live payments it has
// scored in shadow, overall and on payments that were later labelled.
async function shadowStats(challengerVersion) {
    if (!challengerVersion) return null;
    const [rows] = await db.query(
        `SELECT t.id, t.metadata, fa.status AS alert_status, d.status AS dispute_status
         FROM transactions t
         LEFT JOIN fraud_alerts fa ON fa.transaction_id = t.id
         LEFT JOIN disputes d ON d.transaction_id = t.id
         WHERE JSON_UNQUOTE(JSON_EXTRACT(t.metadata, '$.risk.shadow.version')) = ?
         ORDER BY t.id DESC LIMIT 5000`, [challengerVersion]);
    const threshold = 0.5;
    let agree = 0;
    let diff = 0;
    let championFlags = 0;
    let challengerFlags = 0;
    const labelled = { champion: { tp: 0, fp: 0, fn: 0, tn: 0 }, challenger: { tp: 0, fp: 0, fn: 0, tn: 0 } };
    rows.forEach(row => {
        const risk = parse(row.metadata).risk || {};
        if (typeof risk.model_score !== 'number' || !risk.shadow) return;
        const a = risk.model_score >= threshold;
        const b = risk.shadow.score >= threshold;
        if (a === b) agree += 1;
        if (a) championFlags += 1;
        if (b) challengerFlags += 1;
        diff += Math.abs(risk.model_score - risk.shadow.score);
        const label = row.dispute_status === 'upheld' || row.alert_status === 'confirmed_fraud' ? 1
            : row.dispute_status === 'rejected' || row.alert_status === 'cleared' ? 0 : null;
        if (label === null) return;
        [['champion', a], ['challenger', b]].forEach(([name, flagged]) => {
            const m = labelled[name];
            if (flagged && label) m.tp += 1; else if (flagged) m.fp += 1; else if (label) m.fn += 1; else m.tn += 1;
        });
    });
    const n = rows.length;
    const rate = m => ({
        ...m,
        precision: m.tp + m.fp ? Math.round((m.tp / (m.tp + m.fp)) * 1000) / 1000 : null,
        recall: m.tp + m.fn ? Math.round((m.tp / (m.tp + m.fn)) * 1000) / 1000 : null,
    });
    return {
        scored: n,
        agreement: n ? Math.round((agree / n) * 1000) / 1000 : null,
        meanDifference: n ? Math.round((diff / n) * 10000) / 10000 : null,
        championFlags,
        challengerFlags,
        labelled: { champion: rate(labelled.champion), challenger: rate(labelled.challenger) },
    };
}

async function status() {
    const models = await ml('/models');
    const { counts } = await labelledExamples();
    const shadow = await shadowStats(models.challenger && models.challenger.version);
    let comparison = null;
    if (models.challenger) {
        try { comparison = (await ml('/models/challenger/comparison')).champion; } catch (e) { comparison = null; }
    }
    return { ...models, labels: counts, shadow, comparison };
}

async function retrain(req) {
    const { examples, counts } = await labelledExamples();
    const result = await ml('/models/retrain', { method: 'POST', body: { examples } });
    await audit.record({ ...audit.actor(req), action: 'model.retrain', targetType: 'model', details: counts });
    return { ...result, labels: counts };
}

async function change(req, action) {
    const paths = { promote: ['/models/promote', 'POST'], rollback: ['/models/rollback', 'POST'], discard: ['/models/challenger', 'DELETE'] };
    const [path, method] = paths[action];
    const result = await ml(path, { method });
    await audit.record({ ...audit.actor(req), action: `model.${action}`, targetType: 'model', details: result });
    return result;
}

// Drift: the last 500 scored live payments against the training data.
async function drift() {
    const [rows] = await db.query(
        `SELECT JSON_EXTRACT(metadata, '$.risk.contributions') AS contributions FROM transactions
         WHERE scoring_status = 'scored' AND JSON_LENGTH(JSON_EXTRACT(metadata, '$.risk.contributions')) > 0
         ORDER BY id DESC LIMIT 500`);
    const vectors = rows.map(r => {
        const list = parse(r.contributions) || [];
        return Object.fromEntries(list.map(c => [c.feature, c.value]));
    });
    if (vectors.length < 20) {
        return { n: vectors.length, features: {}, note: 'At least 20 scored payments are needed to measure drift.' };
    }
    return ml('/models/drift', { method: 'POST', body: { rows: vectors } });
}

module.exports = { status, retrain, change, drift, labelledExamples, featuresOf, ml };
