// Reconciliation (version 3).
//
// Proves that the books agree with themselves:
//   1. every journal entry adds up to zero, and so does the whole journal
//   2. the journal and the audit log hash chains are intact, and each
//      journal entry's columns and lines match the payload that was hashed
//   3. every wallet, savings goal, loan, chama and held payment holds
//      exactly what its journal account says
//   4. every money movement made since the journal started has an entry
//
// Runs every night (RECONCILE_HOUR, default 02:00 server time), on demand
// from the admin Ledger page, and from scripts/reconcile.js, which the
// automated tests run after every test suite.

const db = require('../config/db');
const { GENESIS, linkHash } = require('./chain');
const { payloadOf, money, cents } = require('./journal');
const auditPayload = require('./audit').payloadOf;

const LIMIT = 25; // issues listed per check

function stamp(column) {
    return `LEFT(DATE_FORMAT(${column}, '%Y-%m-%d %H:%i:%s.%f'), 23)`;
}

async function verifyJournalChain(issues) {
    let prev = GENESIS;
    let lastId = 0;
    let checked = 0;
    for (;;) {
        const [entries] = await db.query(
            `SELECT id, ${stamp('created_at')} AS created_at, kind, transaction_id, memo, payload, prev_hash, hash
             FROM journal_entries WHERE id > ? ORDER BY id LIMIT 1000`, [lastId]);
        if (!entries.length) break;
        const ids = entries.map(e => e.id);
        const [lines] = await db.query(
            'SELECT entry_id, account, amount FROM journal_lines WHERE entry_id IN (?) ORDER BY id', [ids]);
        const byEntry = new Map();
        lines.forEach(l => {
            if (!byEntry.has(l.entry_id)) byEntry.set(l.entry_id, []);
            byEntry.get(l.entry_id).push([l.account, money(l.amount)]);
        });
        for (const e of entries) {
            checked += 1;
            if (e.prev_hash !== prev) {
                issues.push({ check: 'journal_chain', id: e.id, detail: 'Previous hash does not match the entry before it' });
            }
            if (linkHash(e.prev_hash, e.payload) !== e.hash) {
                issues.push({ check: 'journal_chain', id: e.id, detail: 'Hash does not match the recorded payload' });
            }
            const expected = payloadOf({
                createdAt: e.created_at, kind: e.kind, transactionId: e.transaction_id === null ? null : Number(e.transaction_id),
                memo: e.memo, lines: byEntry.get(e.id) || [],
            });
            if (expected !== e.payload) {
                issues.push({ check: 'journal_chain', id: e.id, detail: 'Stored columns or lines differ from the hashed payload' });
            }
            prev = e.hash;
            lastId = e.id;
        }
    }
    const [head] = await db.query("SELECT last_id, last_hash FROM chain_heads WHERE name = 'journal'");
    if (head.length && (Number(head[0].last_id) !== lastId || head[0].last_hash !== prev)) {
        issues.push({ check: 'journal_chain', id: lastId, detail: 'The chain head does not point at the last entry' });
    }
    return { checked, headHash: prev };
}

async function verifyAuditChain(issues) {
    let prev = GENESIS;
    let lastId = 0;
    let checked = 0;
    for (;;) {
        const [rows] = await db.query(
            `SELECT id, ${stamp('created_at')} AS created_at, actor_id, actor_role, action, target_type, target_id,
                    details, ip, payload, prev_hash, hash
             FROM audit_log WHERE id > ? ORDER BY id LIMIT 1000`, [lastId]);
        if (!rows.length) break;
        for (const r of rows) {
            checked += 1;
            if (r.prev_hash !== prev) issues.push({ check: 'audit_chain', id: r.id, detail: 'Previous hash does not match the record before it' });
            if (linkHash(r.prev_hash, r.payload) !== r.hash) issues.push({ check: 'audit_chain', id: r.id, detail: 'Hash does not match the recorded payload' });
            const expected = auditPayload({
                createdAt: r.created_at, actorId: r.actor_id === null ? null : Number(r.actor_id), actorRole: r.actor_role,
                action: r.action, targetType: r.target_type, targetId: r.target_id, details: r.details, ip: r.ip,
            });
            if (expected !== r.payload) issues.push({ check: 'audit_chain', id: r.id, detail: 'Stored columns differ from the hashed payload' });
            prev = r.hash;
            lastId = r.id;
        }
    }
    return { checked, headHash: prev };
}

// Compares a list of [id, expected] against journal sums for prefix:id.
async function compareAccounts(issues, check, prefix, expectedRows) {
    const [sums] = await db.query(
        `SELECT account, SUM(amount) AS total FROM journal_lines WHERE account LIKE ? GROUP BY account`, [`${prefix}:%`]);
    const journal = new Map(sums.map(s => [s.account, cents(s.total)]));
    const seen = new Set();
    for (const row of expectedRows) {
        const key = `${prefix}:${row.id}`;
        seen.add(key);
        const have = journal.get(key) || 0;
        if (have !== cents(row.expected)) {
            if (issues.filter(i => i.check === check).length < LIMIT) {
                issues.push({ check, id: key, detail: `Recorded ${money(row.expected)}, journal says ${money(have / 100)}` });
            }
        }
    }
    let orphanTotal = 0;
    for (const [key, have] of journal) {
        if (!seen.has(key) && have !== 0) {
            orphanTotal += have;
            if (issues.filter(i => i.check === check).length < LIMIT) {
                issues.push({ check, id: key, detail: `Journal holds ${money(have / 100)} for an account that no longer exists` });
            }
        }
    }
    const total = [...journal.values()].reduce((a, b) => a + b, 0);
    return { accounts: expectedRows.length, total: total / 100, orphanTotal: orphanTotal / 100 };
}

async function run(trigger = 'manual') {
    const started = new Date();
    const [created] = await db.execute(
        'INSERT INTO reconciliation_runs (started_at, trigger_source) VALUES (UTC_TIMESTAMP(3), ?)', [trigger]);
    const runId = created.insertId;
    const issues = [];
    const summary = {};

    try {
        const [unbalanced] = await db.query(
            `SELECT entry_id, SUM(amount) AS total FROM journal_lines GROUP BY entry_id HAVING SUM(amount) <> 0 LIMIT ${LIMIT}`);
        unbalanced.forEach(u => issues.push({ check: 'balanced_entries', id: u.entry_id, detail: `Lines add up to ${money(u.total)}` }));
        const [grand] = await db.query('SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS line_count FROM journal_lines');
        if (cents(grand[0].total) !== 0) issues.push({ check: 'balanced_entries', id: 'all', detail: `The whole journal adds up to ${money(grand[0].total)}` });
        summary.lines = Number(grand[0].line_count);

        summary.journalChain = await verifyJournalChain(issues);
        summary.auditChain = await verifyAuditChain(issues);

        const [wallets] = await db.query('SELECT id, balance AS expected FROM wallets');
        summary.wallets = await compareAccounts(issues, 'wallet_balances', 'wallet', wallets);
        const [vaults] = await db.query('SELECT id, balance AS expected FROM savings_vaults');
        summary.savings = await compareAccounts(issues, 'savings_balances', 'savings', vaults);
        const [loans] = await db.query('SELECT id, amount_repaid - principal AS expected FROM loans');
        summary.loans = await compareAccounts(issues, 'loan_positions', 'loan', loans);
        const [chamas] = await db.query('SELECT id, balance AS expected FROM chamas');
        summary.chamas = await compareAccounts(issues, 'chama_balances', 'chama', chamas);
        const [held] = await db.query(
            `SELECT id, IF(status = 'pending' AND sender_wallet_id IS NOT NULL, amount, 0) AS expected
             FROM transactions WHERE id IN (SELECT CAST(SUBSTRING(account, 6) AS UNSIGNED) FROM journal_lines WHERE account LIKE 'held:%')
                OR (status = 'pending' AND sender_wallet_id IS NOT NULL)`);
        summary.held = await compareAccounts(issues, 'held_payments', 'held', held);

        const [missing] = await db.query(
            `SELECT t.id FROM transactions t
             LEFT JOIN journal_entries e ON e.transaction_id = t.id
             WHERE e.id IS NULL
               -- opened_at is in server time, like transactions.created_at.
               AND t.created_at >= (SELECT opened_at FROM chain_heads WHERE name = 'journal')
               AND COALESCE(JSON_EXTRACT(t.metadata, '$.seeded'), false) = false
             LIMIT ${LIMIT}`);
        missing.forEach(m => issues.push({ check: 'unjournalled_transactions', id: m.id, detail: 'Transaction has no journal entry' }));

        const [positions] = await db.query(
            `SELECT SUBSTRING_INDEX(account, ':', 1) AS kind,
                    IF(account LIKE 'external:%' OR account LIKE 'equity:%', account, NULL) AS named,
                    SUM(amount) AS total
             FROM journal_lines GROUP BY kind, named`);
        summary.positions = positions.map(p => ({ account: p.named || p.kind, total: Number(p.total) }));
    } catch (error) {
        issues.push({ check: 'run', id: null, detail: `Reconciliation failed: ${error.message}` });
    }

    const ok = issues.length === 0;
    summary.durationMs = Date.now() - started.getTime();
    summary.issueCount = issues.length;
    await db.execute(
        'UPDATE reconciliation_runs SET finished_at = UTC_TIMESTAMP(3), ok = ?, summary = ?, issues = ? WHERE id = ?',
        [ok ? 1 : 0, JSON.stringify(summary), JSON.stringify(issues), runId]);
    return { id: runId, ok, summary, issues };
}

// Runs once a day at RECONCILE_HOUR (server time). Checked every minute.
function schedule(onResult) {
    const hour = Number.isInteger(Number(process.env.RECONCILE_HOUR)) ? Number(process.env.RECONCILE_HOUR) : 2;
    let lastDay = null;
    const timer = setInterval(async () => {
        const now = new Date();
        const day = now.toDateString();
        if (now.getHours() !== hour || lastDay === day) return;
        lastDay = day;
        try {
            const result = await run('scheduled');
            if (onResult) onResult(result);
        } catch (error) {
            console.error('[Reconcile] Scheduled run failed:', error.message);
        }
    }, 60 * 1000);
    timer.unref();
}

// Checks only the two hash chains (the admin Audit page's "Verify" button).
async function verifyChains() {
    const issues = [];
    const journal = await verifyJournalChain(issues);
    const auditChain = await verifyAuditChain(issues);
    return { ok: issues.length === 0, journal, audit: auditChain, issues: issues.slice(0, 50) };
}

module.exports = { run, schedule, verifyChains };
