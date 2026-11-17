// Fraud API (version 3): the risk engine offered to other businesses.
//
// A small wallet, a payment gateway or a SACCO sends each outgoing payment
// to POST /api/v1/assess before completing it and gets back a decision:
//   allow       complete the payment
//   challenge   ask the customer for a second factor first
//   review      hold the payment for a human to check
// with the reasons, the model's explanation and the model version.
//
// The engine is the same one the wallet uses (services/riskEngine.js). Only
// the history differs: for an API client the behavioural and network
// signals are read from the events that client has sent (api_events), so
// each client's customers are judged against that client's own traffic and
// clients never see each other's data.
//
// Clients send outcomes (a declined payment no longer counts in history)
// and labels (fraud or legitimate), which feed the retraining loop.

const crypto = require('crypto');
const db = require('../config/db');
const riskEngine = require('./riskEngine');
const webhooks = require('./webhooks');
const metrics = require('./metrics');

const DECISION = { allow: 'allow', challenge: 'challenge', hold: 'review' };

function hashKey(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
}

function newKey() {
    const body = crypto.randomBytes(24).toString('base64url');
    return `swk_live_${body}`;
}

// History provider over one client's events.
function apiHistory(clientId, accountId, counterpartyId) {
    const one = async (sql, params) => Number((await db.execute(sql, params))[0][0].n);
    const base = 'FROM api_events WHERE client_id = ? AND status = \'completed\'';
    return {
        outgoingCountSince: minutes => one(
            `SELECT COUNT(*) AS n ${base} AND account_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
            [clientId, accountId, minutes]),
        recentOutgoingAmounts: async limit => (await db.execute(
            `SELECT amount ${base} AND account_id = ? ORDER BY id DESC LIMIT ${Number(limit)}`, [clientId, accountId]))[0]
            .map(r => Number(r.amount)),
        paidBefore: () => one(`SELECT COUNT(*) AS n ${base} AND account_id = ? AND counterparty_id = ?`, [clientId, accountId, counterpartyId]),
        toCounterpartySince: minutes => one(
            `SELECT COUNT(*) AS n ${base} AND account_id = ? AND counterparty_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
            [clientId, accountId, counterpartyId, minutes]),
        inflowSince: async minutes => Number((await db.execute(
            `SELECT COALESCE(SUM(amount), 0) AS total ${base} AND counterparty_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
            [clientId, accountId, minutes]))[0][0].total),
        counterpartySendersSince: minutes => one(
            `SELECT COUNT(DISTINCT account_id) AS n ${base} AND counterparty_id = ? AND account_id <> ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
            [clientId, counterpartyId, accountId, minutes]),
        counterpartySendersBefore: minutes => one(
            `SELECT COUNT(DISTINCT account_id) AS n ${base} AND counterparty_id = ? AND created_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
            [clientId, counterpartyId, minutes]),
        returnedSince: (hours, low, high) => one(
            `SELECT COUNT(*) AS n ${base} AND account_id = ? AND counterparty_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR) AND amount BETWEEN ? AND ?`,
            [clientId, counterpartyId, accountId, hours, low, high]),
    };
}

// ---------- authentication and rate limits ----------

const buckets = new Map();

function takeToken(clientId, perMinute) {
    const now = Date.now();
    const bucket = buckets.get(clientId) || { tokens: perMinute, at: now };
    bucket.tokens = Math.min(perMinute, bucket.tokens + ((now - bucket.at) / 60000) * perMinute);
    bucket.at = now;
    if (bucket.tokens < 1) {
        buckets.set(clientId, bucket);
        return Math.ceil(((1 - bucket.tokens) / perMinute) * 60);
    }
    bucket.tokens -= 1;
    buckets.set(clientId, bucket);
    return 0;
}

async function authenticate(req, res, next) {
    const header = req.get('Authorization') || '';
    const match = /^Bearer\s+(swk_[A-Za-z0-9_-]{20,})$/.exec(header.trim());
    if (!match) {
        return res.status(401).json({ error: 'unauthorised', message: 'Send your API key as Authorization: Bearer swk_...' });
    }
    try {
        const [rows] = await db.execute(
            `SELECT k.id AS key_id, c.id, c.name, c.rate_limit_per_minute, c.status
             FROM api_keys k JOIN api_clients c ON c.id = k.client_id
             WHERE k.key_hash = ? AND k.revoked_at IS NULL`, [hashKey(match[1])]);
        if (!rows.length) return res.status(401).json({ error: 'unauthorised', message: 'This API key is not valid or has been revoked' });
        const client = rows[0];
        if (client.status !== 'active') return res.status(403).json({ error: 'suspended', message: 'This client is suspended' });
        const wait = takeToken(client.id, Number(client.rate_limit_per_minute));
        if (wait) {
            res.set('Retry-After', String(wait));
            return res.status(429).json({ error: 'rate_limited', message: `Rate limit of ${client.rate_limit_per_minute} requests a minute reached` });
        }
        db.execute('UPDATE api_keys SET last_used_at = UTC_TIMESTAMP() WHERE id = ?', [client.key_id]).catch(() => {});
        req.apiClient = client;
        return next();
    } catch (error) {
        console.error('[FraudAPI]', error.message);
        return res.status(500).json({ error: 'server_error', message: 'Something went wrong' });
    }
}

// ---------- assessments ----------

function number(value, name, { min = 0, required = true } = {}) {
    if (value === undefined || value === null) {
        if (required) throw Object.assign(new Error(`${name} is required`), { status: 400 });
        return 0;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
        throw Object.assign(new Error(`${name} must be a number of at least ${min}`), { status: 400 });
    }
    return Math.round(value * 100) / 100;
}

function id(value, name, required) {
    if (value === undefined || value === null || value === '') {
        if (required) throw Object.assign(new Error(`${name} is required`), { status: 400 });
        return null;
    }
    const text = String(value);
    if (!/^[A-Za-z0-9_.:@+-]{1,80}$/.test(text)) {
        throw Object.assign(new Error(`${name} may contain only letters, digits and _ . : @ + - (up to 80)`), { status: 400 });
    }
    return text;
}

function present(row) {
    const detail = row.detail ? JSON.parse(row.detail) : {};
    return {
        id: `asm_${row.id}`,
        external_id: row.external_id,
        decision: row.decision,
        risk: row.risk === null ? null : Number(row.risk),
        model_score: row.model_score === null ? null : Number(row.model_score),
        reasons: (detail.signals || []).map(s => s.label),
        signals: detail.signals || [],
        explanation: { base_value: detail.base_value ?? null, contributions: detail.contributions || [] },
        model_version: detail.model_version || null,
        status: row.status,
        label: row.label,
        created_at: row.created_at,
    };
}

async function assess(client, body) {
    const started = Date.now();
    const type = body.type === 'TRANSFER' || body.type === 'CASH_OUT' ? body.type : null;
    if (!type) throw Object.assign(new Error('type must be TRANSFER or CASH_OUT'), { status: 400 });
    const amount = number(body.amount, 'amount', { min: 0.01 });
    const accountId = id(body.account_id, 'account_id', true);
    const counterpartyId = id(body.counterparty_id, 'counterparty_id', type === 'TRANSFER');
    const externalId = id(body.external_id, 'external_id', false);
    const balance = number(body.account_balance, 'account_balance');
    const counterpartyBalance = number(body.counterparty_balance, 'counterparty_balance', { required: false });
    if (amount > balance) throw Object.assign(new Error('amount is more than account_balance'), { status: 400 });

    if (externalId) {
        const [existing] = await db.execute('SELECT * FROM api_events WHERE client_id = ? AND external_id = ?', [client.id, externalId]);
        if (existing.length) return { replay: true, assessment: present(existing[0]) };
    }

    const assessment = await riskEngine.assessWith({
        modelType: type,
        amount,
        senderBefore: balance,
        receiverBefore: counterpartyBalance,
        hasCounterparty: Boolean(counterpartyId),
        history: apiHistory(client.id, accountId, counterpartyId),
    });
    const decision = DECISION[assessment.tier];
    const detail = {
        signals: assessment.signals,
        base_value: assessment.baseValue,
        contributions: assessment.contributions,
        model_version: assessment.modelVersion,
        scored: assessment.scored,
    };
    let result;
    try {
        [result] = await db.execute(
            `INSERT INTO api_events (client_id, external_id, account_id, counterparty_id, type, amount, model_score, risk, decision, detail, features)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [client.id, externalId, accountId, counterpartyId, type, amount, assessment.modelScore, assessment.risk, decision,
                JSON.stringify(detail), JSON.stringify(assessment.features)]);
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY' && externalId) {
            const [existing] = await db.execute('SELECT * FROM api_events WHERE client_id = ? AND external_id = ?', [client.id, externalId]);
            return { replay: true, assessment: present(existing[0]) };
        }
        throw error;
    }
    const [[row]] = await db.execute('SELECT * FROM api_events WHERE id = ?', [result.insertId]);
    const out = present(row);
    if (decision !== 'allow') {
        await webhooks.enqueue(client.id, 'assessment.flagged', out);
    }
    metrics.observe('api_assess_ms', Date.now() - started);
    metrics.count(`api_decision_${decision}`);
    return { replay: false, assessment: out };
}

async function find(clientId, assessmentId) {
    const numeric = Number(String(assessmentId).replace(/^asm_/, ''));
    if (!Number.isInteger(numeric) || numeric <= 0) return null;
    const [rows] = await db.execute('SELECT * FROM api_events WHERE id = ? AND client_id = ?', [numeric, clientId]);
    return rows[0] || null;
}

async function setOutcome(clientId, assessmentId, status) {
    if (!['completed', 'declined', 'reversed'].includes(status)) {
        throw Object.assign(new Error('status must be completed, declined or reversed'), { status: 400 });
    }
    const row = await find(clientId, assessmentId);
    if (!row) throw Object.assign(new Error('Assessment not found'), { status: 404 });
    await db.execute('UPDATE api_events SET status = ? WHERE id = ?', [status, row.id]);
    return present({ ...row, status });
}

async function setLabel(clientId, assessmentId, label) {
    if (!['fraud', 'legit'].includes(label)) throw Object.assign(new Error('label must be fraud or legit'), { status: 400 });
    const row = await find(clientId, assessmentId);
    if (!row) throw Object.assign(new Error('Assessment not found'), { status: 404 });
    await db.execute('UPDATE api_events SET label = ?, labelled_at = UTC_TIMESTAMP() WHERE id = ?', [label, row.id]);
    return present({ ...row, label });
}

async function usage(clientId, days = 30) {
    const [rows] = await db.execute(
        `SELECT DATE(created_at) AS day, decision, COUNT(*) AS n FROM api_events
         WHERE client_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         GROUP BY day, decision ORDER BY day`, [clientId, days]);
    const [[labels]] = await db.execute(
        "SELECT SUM(label = 'fraud') AS fraud, SUM(label = 'legit') AS legit FROM api_events WHERE client_id = ?", [clientId]);
    return { days: rows.map(r => ({ day: r.day, decision: r.decision, count: Number(r.n) })),
        labels: { fraud: Number(labels.fraud || 0), legit: Number(labels.legit || 0) } };
}

module.exports = { authenticate, assess, find, present, setOutcome, setLabel, usage, newKey, hashKey, apiHistory };
