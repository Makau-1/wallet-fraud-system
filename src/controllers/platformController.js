// Administrator endpoints added in version 3: overview, disputes and
// reports, account freezes, the money-flow network, model operations, the
// ledger, the audit log, system health, fraud API clients, the attack lab's
// evaluation run and usability survey results.

const crypto = require('crypto');
const db = require('../config/db');
const { ServiceError, handle } = require('../services/ledger');
const protection = require('../services/protection');
const graph = require('../services/graph');
const modelOps = require('../services/modelOps');
const reconcile = require('../services/reconcile');
const audit = require('../services/audit');
const metrics = require('../services/metrics');
const events = require('../services/events');
const scoringQueue = require('../services/scoringQueue');
const webhooks = require('../services/webhooks');
const fraudApi = require('../services/fraudApi');
const attackLab = require('../services/attackLab');
const riskEngine = require('../services/riskEngine');
const mpesa = require('../services/mpesa');

function idParam(req, name = 'id') {
    const value = Number(req.params[name]);
    if (!Number.isInteger(value) || value <= 0) throw new ServiceError(400, 'Invalid id');
    return value;
}

function upstream(error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(error.status || 502, error.message || 'The scoring service is not reachable');
}

// ---------- overview ----------

const overview = handle('Platform', async (req, res) => {
    const [[today]] = await db.query(
        `SELECT COUNT(*) AS payments, COALESCE(SUM(amount), 0) AS volume,
                SUM(status = 'pending') AS pending
         FROM transactions
         WHERE created_at >= CURDATE()
           AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.type')) IN ('transfer', 'withdrawal', 'bank_transfer')`);
    const [[alerts]] = await db.query(
        `SELECT SUM(status = 'pending') AS waiting, SUM(status = 'confirmed_fraud') AS confirmed, SUM(status = 'cleared') AS cleared,
                SUM(status = 'pending' AND proposed_status IS NOT NULL) AS awaiting_second
         FROM fraud_alerts`);
    const [[stopped]] = await db.query(
        `SELECT COALESCE(SUM(t.amount), 0) AS amount, COUNT(*) AS n FROM transactions t
         WHERE JSON_UNQUOTE(JSON_EXTRACT(t.metadata, '$.risk.action')) IN ('reversed', 'cancelled')`);
    const [[held]] = await db.query("SELECT COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS n FROM transactions WHERE status = 'pending' AND sender_wallet_id IS NOT NULL");
    const [[review]] = await db.query(
        `SELECT AVG(TIMESTAMPDIFF(SECOND, created_at, reviewed_at)) AS seconds FROM fraud_alerts
         WHERE reviewed_at IS NOT NULL AND reviewed_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`);
    const [[disputes]] = await db.query("SELECT SUM(status = 'open') AS open FROM disputes");
    const [[frozen]] = await db.query('SELECT COUNT(*) AS n FROM users WHERE frozen_at IS NOT NULL');
    const [daily] = await db.query(
        `SELECT DATE(created_at) AS day, COUNT(*) AS alerts, SUM(status = 'confirmed_fraud') AS confirmed
         FROM fraud_alerts WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
         GROUP BY DATE(created_at) ORDER BY day`);
    const [lastRun] = await db.query('SELECT id, ok, finished_at, summary FROM reconciliation_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1');
    const decided = Number(alerts.confirmed || 0) + Number(alerts.cleared || 0);
    const latency = metrics.summarise().find(s => s.name === 'model_score_ms');
    res.json({
        riskMode: riskEngine.mode(),
        today: { payments: Number(today.payments), volume: Number(today.volume), pending: Number(today.pending || 0) },
        alerts: {
            waiting: Number(alerts.waiting || 0), confirmed: Number(alerts.confirmed || 0), cleared: Number(alerts.cleared || 0),
            awaitingSecondApproval: Number(alerts.awaiting_second || 0),
            // Share of decided alerts that analysts cleared: the false-alarm rate as reviewers saw it.
            clearedShare: decided ? Math.round((Number(alerts.cleared) / decided) * 1000) / 10 : null,
        },
        stopped: { amount: Number(stopped.amount), count: Number(stopped.n) },
        held: { amount: Number(held.amount), count: Number(held.n) },
        averageReviewMinutes: review.seconds === null ? null : Math.round(Number(review.seconds) / 6) / 10,
        openDisputes: Number(disputes.open || 0),
        frozenAccounts: Number(frozen.n),
        unscoredBacklog: await scoringQueue.backlog(),
        modelLatency: latency ? { p50: latency.p50, p95: latency.p95, n: latency.count } : null,
        reconciliation: lastRun.length ? { id: lastRun[0].id, ok: Boolean(lastRun[0].ok), at: lastRun[0].finished_at } : null,
        daily: daily.map(d => ({ day: d.day, alerts: Number(d.alerts), confirmed: Number(d.confirmed) })),
    });
});

// ---------- disputes, reports and freezes ----------

const listDisputes = handle('Platform', async (req, res) => {
    const status = ['open', 'upheld', 'rejected'].includes(req.query.status) ? req.query.status : null;
    res.json({ disputes: await protection.disputes(status), twoPersonThreshold: protection.twoPersonThreshold(), me: req.session.userId });
});

const decideDispute = handle('Platform', async (req, res) => {
    const result = await protection.decideDispute(idParam(req), req.body.decision, req);
    res.status(result.awaitingSecondApproval ? 202 : 200).json(result);
});

const rejectDisputeProposal = handle('Platform', async (req, res) => {
    res.json(await protection.rejectDisputeProposal(idParam(req), req));
});

const reported = handle('Platform', async (req, res) => {
    res.json({ accounts: await protection.reportedAccounts() });
});

const freezeUser = handle('Platform', async (req, res) => {
    const reason = typeof req.body.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim() : 'Frozen by an administrator';
    res.json(await protection.freeze(idParam(req), reason.slice(0, 200), req));
});

const restoreUser = handle('Platform', async (req, res) => {
    res.json(await protection.unfreeze(idParam(req), req));
});

// ---------- network ----------

const network = handle('Platform', async (req, res) => {
    const walletId = await graph.walletIdFor(req.query.account);
    if (!walletId) throw new ServiceError(404, 'No account matches that email, phone number or wallet number');
    res.json(await graph.around(walletId, { hops: req.query.hops, hours: req.query.hours }));
});

const networkFindings = handle('Platform', async (req, res) => {
    res.json({ accounts: await graph.findings() });
});

// ---------- models ----------

const models = handle('Platform', async (req, res) => {
    try { res.json(await modelOps.status()); } catch (error) { upstream(error); }
});

const retrain = handle('Platform', async (req, res) => {
    try { res.status(202).json(await modelOps.retrain(req)); } catch (error) { upstream(error); }
});

const modelChange = action => handle('Platform', async (req, res) => {
    try { res.json(await modelOps.change(req, action)); } catch (error) { upstream(error); }
});

const drift = handle('Platform', async (req, res) => {
    try { res.json(await modelOps.drift()); } catch (error) { upstream(error); }
});

// ---------- ledger ----------

const ledger = handle('Platform', async (req, res) => {
    const [runs] = await db.query(
        'SELECT id, started_at, finished_at, trigger_source, ok, summary, issues FROM reconciliation_runs ORDER BY id DESC LIMIT 10');
    const [[head]] = await db.query("SELECT last_id, last_hash, opened_at FROM chain_heads WHERE name = 'journal'");
    const [entries] = await db.query(
        `SELECT e.id, e.created_at, e.kind, e.transaction_id, e.memo, e.hash,
                GROUP_CONCAT(CONCAT(l.account, '=', l.amount) ORDER BY l.id SEPARATOR ';') AS line_list
         FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
         GROUP BY e.id ORDER BY e.id DESC LIMIT 25`);
    res.json({
        head: { lastId: Number(head.last_id), lastHash: head.last_hash, openedAt: head.opened_at },
        runs: runs.map(r => ({ ...r, ok: r.ok === null ? null : Boolean(r.ok), summary: r.summary ? JSON.parse(r.summary) : null, issues: r.issues ? JSON.parse(r.issues) : [] })),
        entries: entries.map(e => ({ ...e, lines: (e.line_list || '').split(';').map(x => { const [account, amount] = x.split('='); return { account, amount: Number(amount) }; }), line_list: undefined })),
    });
});

const reconcileNow = handle('Platform', async (req, res) => {
    const result = await reconcile.run('manual');
    await audit.record({ ...audit.actor(req), action: 'ledger.reconcile', targetType: 'reconciliation', targetId: result.id,
        details: { ok: result.ok, issues: result.issues.length } });
    events.toAdmins('reconciliation.finished', { id: result.id, ok: result.ok });
    res.json(result);
});

const accountLines = handle('Platform', async (req, res) => {
    const account = String(req.params.account || '');
    if (!/^(wallet|savings|loan|held|chama):\d+$|^(external|equity):[a-z]+$/.test(account)) throw new ServiceError(400, 'Unknown account');
    const [rows] = await db.query(
        `SELECT e.id, e.created_at, e.kind, e.transaction_id, l.amount
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
         WHERE l.account = ? ORDER BY e.id DESC LIMIT 100`, [account]);
    const [[sum]] = await db.query('SELECT COALESCE(SUM(amount), 0) AS total FROM journal_lines WHERE account = ?', [account]);
    res.json({ account, balance: Number(sum.total), lines: rows });
});

// ---------- audit log ----------

const auditLog = handle('Platform', async (req, res) => {
    const params = [];
    const where = [];
    if (req.query.action) { where.push('a.action LIKE ?'); params.push(`${String(req.query.action).replace(/[%_]/g, '')}%`); }
    if (req.query.before && Number(req.query.before)) { where.push('a.id < ?'); params.push(Number(req.query.before)); }
    const [rows] = await db.query(
        `SELECT a.id, a.created_at, a.actor_id, a.actor_role, u.name AS actor_name, a.action, a.target_type, a.target_id, a.details, a.ip, a.hash
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY a.id DESC LIMIT 50`, params);
    res.json({ entries: rows });
});

const verifyAudit = handle('Platform', async (req, res) => {
    const result = await reconcile.verifyChains();
    await audit.record({ ...audit.actor(req), action: 'audit.verify', details: { ok: result.ok } });
    res.json(result);
});

// ---------- system ----------

const system = handle('Platform', async (req, res) => {
    const [[webhookQueue]] = await db.query("SELECT SUM(status = 'pending') AS pending, SUM(status = 'failed') AS failed FROM webhook_deliveries");
    const [[mpesaPending]] = await db.query("SELECT COUNT(*) AS n FROM mpesa_requests WHERE status = 'pending'");
    let model = null;
    try {
        const response = await fetch(`${(process.env.ML_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(1500) });
        model = response.ok ? await response.json() : null;
    } catch (error) { model = null; }
    res.json({
        ...metrics.snapshot(),
        model,
        riskMode: riskEngine.mode(),
        mpesaMode: mpesa.mode(),
        streams: events.connectionCount(),
        unscoredBacklog: await scoringQueue.backlog(),
        webhooks: { pending: Number(webhookQueue.pending || 0), failed: Number(webhookQueue.failed || 0) },
        mpesaPending: Number(mpesaPending.n),
        node: process.version,
    });
});

// ---------- fraud API clients ----------

const apiClients = handle('Platform', async (req, res) => {
    const [clients] = await db.query(
        `SELECT c.id, c.name, c.contact_email, c.webhook_url, c.rate_limit_per_minute, c.status, c.created_at,
                (SELECT COUNT(*) FROM api_events e WHERE e.client_id = c.id) AS assessments,
                (SELECT COUNT(*) FROM api_events e WHERE e.client_id = c.id AND e.label IS NOT NULL) AS labelled,
                (SELECT MAX(k.last_used_at) FROM api_keys k WHERE k.client_id = c.id) AS last_used_at
         FROM api_clients c ORDER BY c.created_at DESC`);
    const [keys] = await db.query('SELECT id, client_id, prefix, label, created_at, last_used_at, revoked_at FROM api_keys ORDER BY id DESC');
    res.json({ clients: clients.map(c => ({ ...c, keys: keys.filter(k => String(k.client_id) === String(c.id)) })) });
});

const createApiClient = handle('Platform', async (req, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 80) throw new ServiceError(400, 'Give the client a name of up to 80 characters');
    const email = typeof req.body.contactEmail === 'string' ? req.body.contactEmail.trim().slice(0, 255) : null;
    const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
    const [created] = await db.execute('INSERT INTO api_clients (name, contact_email, webhook_secret) VALUES (?, ?, ?)', [name, email || null, secret]);
    const key = fraudApi.newKey();
    await db.execute('INSERT INTO api_keys (client_id, prefix, key_hash, label) VALUES (?, ?, ?, ?)',
        [created.insertId, key.slice(0, 13), fraudApi.hashKey(key), 'First key']);
    await audit.record({ ...audit.actor(req), action: 'api.client_create', targetType: 'api_client', targetId: created.insertId, details: { name } });
    // The key and secret are shown once and never again.
    res.status(201).json({ id: created.insertId, apiKey: key, webhookSecret: secret });
});

const updateApiClient = handle('Platform', async (req, res) => {
    const id = idParam(req);
    const changes = [];
    const params = [];
    if (req.body.webhookUrl !== undefined) {
        const url = req.body.webhookUrl ? await webhooks.checkUrl(req.body.webhookUrl).catch(e => { throw new ServiceError(e.status || 400, e.message); }) : null;
        changes.push('webhook_url = ?'); params.push(url);
    }
    if (req.body.rateLimit !== undefined) {
        const limit = Number(req.body.rateLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 6000) throw new ServiceError(400, 'Rate limit must be 1 to 6,000 a minute');
        changes.push('rate_limit_per_minute = ?'); params.push(limit);
    }
    if (req.body.status !== undefined) {
        if (!['active', 'suspended'].includes(req.body.status)) throw new ServiceError(400, 'Status must be active or suspended');
        changes.push('status = ?'); params.push(req.body.status);
    }
    if (!changes.length) throw new ServiceError(400, 'Nothing to change');
    const [result] = await db.execute(`UPDATE api_clients SET ${changes.join(', ')} WHERE id = ?`, [...params, id]);
    if (!result.affectedRows) throw new ServiceError(404, 'Client not found');
    await audit.record({ ...audit.actor(req), action: 'api.client_update', targetType: 'api_client', targetId: id, details: req.body });
    res.json({ updated: true });
});

const createKey = handle('Platform', async (req, res) => {
    const id = idParam(req);
    const [[client]] = await db.execute('SELECT id FROM api_clients WHERE id = ?', [id]);
    if (!client) throw new ServiceError(404, 'Client not found');
    const key = fraudApi.newKey();
    const label = typeof req.body.label === 'string' ? req.body.label.trim().slice(0, 80) : null;
    await db.execute('INSERT INTO api_keys (client_id, prefix, key_hash, label) VALUES (?, ?, ?, ?)', [id, key.slice(0, 13), fraudApi.hashKey(key), label]);
    await audit.record({ ...audit.actor(req), action: 'api.key_create', targetType: 'api_client', targetId: id });
    res.status(201).json({ apiKey: key });
});

const revokeKey = handle('Platform', async (req, res) => {
    const [result] = await db.execute('UPDATE api_keys SET revoked_at = UTC_TIMESTAMP() WHERE id = ? AND client_id = ? AND revoked_at IS NULL',
        [idParam(req, 'keyId'), idParam(req)]);
    if (!result.affectedRows) throw new ServiceError(404, 'Key not found or already revoked');
    await audit.record({ ...audit.actor(req), action: 'api.key_revoke', targetType: 'api_key', targetId: req.params.keyId });
    res.json({ revoked: true });
});

const rotateSecret = handle('Platform', async (req, res) => {
    const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
    const [result] = await db.execute('UPDATE api_clients SET webhook_secret = ? WHERE id = ?', [secret, idParam(req)]);
    if (!result.affectedRows) throw new ServiceError(404, 'Client not found');
    await audit.record({ ...audit.actor(req), action: 'api.webhook_secret_rotate', targetType: 'api_client', targetId: req.params.id });
    res.json({ webhookSecret: secret });
});

const testWebhook = handle('Platform', async (req, res) => {
    const id = idParam(req);
    const deliveryId = await webhooks.enqueue(id, 'webhook.test', { message: 'Test event from SecureWallet' });
    if (!deliveryId) throw new ServiceError(409, 'Set a webhook URL first');
    await webhooks.runDue();
    const [[row]] = await db.execute('SELECT status, attempts, last_status_code, last_error FROM webhook_deliveries WHERE id = ?', [deliveryId]);
    res.json({ deliveryId, ...row });
});

const deliveries = handle('Platform', async (req, res) => {
    const [rows] = await db.execute(
        `SELECT id, event_type, status, attempts, last_status_code, last_error, created_at, delivered_at, next_attempt_at
         FROM webhook_deliveries WHERE client_id = ? ORDER BY id DESC LIMIT 30`, [idParam(req)]);
    res.json({ deliveries: rows });
});

// ---------- attack lab evaluation ----------

const labRunAll = handle('Platform', async (req, res) => {
    res.json(await attackLab.runAll(req));
});

// ---------- usability survey ----------

const surveyResults = handle('Platform', async (req, res) => {
    const [rows] = await db.query('SELECT role, answers, score, comment, created_at FROM sus_responses ORDER BY id DESC');
    const byRole = {};
    rows.forEach(r => {
        byRole[r.role] = byRole[r.role] || { n: 0, total: 0, items: Array(10).fill(0) };
        byRole[r.role].n += 1;
        byRole[r.role].total += Number(r.score);
        r.answers.split(',').map(Number).forEach((v, i) => { byRole[r.role].items[i] += v; });
    });
    const summary = Object.fromEntries(Object.entries(byRole).map(([role, s]) => [role, {
        n: s.n, meanScore: Math.round((s.total / s.n) * 10) / 10, itemMeans: s.items.map(v => Math.round((v / s.n) * 100) / 100),
    }]));
    const all = rows.length ? Math.round((rows.reduce((t, r) => t + Number(r.score), 0) / rows.length) * 10) / 10 : null;
    res.json({ n: rows.length, meanScore: all, byRole: summary, comments: rows.filter(r => r.comment).slice(0, 30).map(r => ({ role: r.role, comment: r.comment, score: Number(r.score), at: r.created_at })) });
});

module.exports = {
    overview, listDisputes, decideDispute, rejectDisputeProposal, reported, freezeUser, restoreUser,
    network, networkFindings, models, retrain, modelChange, drift, ledger, reconcileNow, accountLines,
    auditLog, verifyAudit, system, apiClients, createApiClient, updateApiClient, createKey, revokeKey,
    rotateSecret, testWebhook, deliveries, labRunAll, surveyResults,
};
