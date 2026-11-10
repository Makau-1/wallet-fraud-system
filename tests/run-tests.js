// SecureWallet functional test runner (Sprint 5)
// Runs test cases TC-01 to TC-16 from Table 5.3 against the running system
// and writes the evidence to tests/results/.
//
// Before running:
//   1. MySQL is running and .env is filled in.
//   2. The website is running:            npm run dev
//   3. The scoring service is running:    (from ml) python -m uvicorn ml.app:app --port 8000
//
// Run from the project root:
//   node tests/run-tests.js            runs TC-01 to TC-15
//   node tests/run-tests.js --tc16     runs TC-16 only (stop the scoring service first)
//   node tests/run-tests.js --cleanup  deletes all test accounts before a demo

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/config/db');

const BASE = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const ML_URL = (process.env.ML_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
const RUN_ID = Date.now().toString(36);
const PASSWORD = 'TestPass123';
const results = [];

// ---------- small HTTP client with its own session cookie ----------
function client() {
    let cookie = '';
    return async function call(method, url, body) {
        const response = await fetch(BASE + url, {
            method,
            headers: {
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                ...(cookie ? { Cookie: cookie } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';')[0];
        let data = {};
        try { data = await response.json(); } catch (e) { data = {}; }
        return { status: response.status, data };
    };
}

function email(name) {
    return `${name}.${RUN_ID}@test.securewallet`;
}

async function record(id, requirement, description, expected, fn) {
    let actual = '';
    let pass = false;
    try {
        const outcome = await fn();
        pass = outcome.pass;
        actual = outcome.actual;
    } catch (error) {
        actual = `Error: ${error.message}`;
    }
    results.push({ id, requirement, description, expected, actual, status: pass ? 'Pass' : 'Fail' });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${description}\n      ${actual}`);
}

async function balanceOf(userEmail) {
    const [rows] = await db.execute(
        'SELECT w.balance FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.email = ?',
        [userEmail]
    );
    return rows.length ? Number(rows[0].balance) : null;
}

let THRESHOLD = 0.5;
async function mlIsUp() {
    try {
        const response = await fetch(`${ML_URL}/health`, { signal: AbortSignal.timeout(1500) });
        if (response.ok) {
            const info = await response.json().catch(() => ({}));
            if (typeof info.threshold === 'number') THRESHOLD = info.threshold;
        }
        return response.ok;
    } catch (e) {
        return false;
    }
}

// Removes every account this script created (emails ending @test.securewallet)
// together with their wallets, transactions and fraud alerts.
async function cleanup() {
    const [wallets] = await db.query(
        "SELECT w.id FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.email LIKE '%@test.securewallet'");
    const ids = wallets.map(w => w.id);
    if (ids.length) {
        await db.query(
            'DELETE fa FROM fraud_alerts fa JOIN transactions t ON t.id = fa.transaction_id WHERE t.sender_wallet_id IN (?) OR t.receiver_wallet_id IN (?)', [ids, ids]);
        await db.query('DELETE FROM transactions WHERE sender_wallet_id IN (?) OR receiver_wallet_id IN (?)', [ids, ids]);
    }
    const [result] = await db.query("DELETE FROM users WHERE email LIKE '%@test.securewallet'");
    console.log(`Removed ${result.affectedRows} test users and their wallets, transactions and alerts.`);
}

// ---------- test cases ----------
async function mainSuite() {
    const alice = client();
    const bob = client();
    const admin = client();
    const anonymous = client();
    const A = email('alice'), B = email('bob'), ADMIN = email('admin');

    await record('TC-01', 'FR-01', 'Register a new user with valid details',
        'User created, password stored as bcrypt hash, wallet created with balance 0',
        async () => {
            const r = await alice('POST', '/api/auth/register', { name: 'Alice Test', email: A, password: PASSWORD });
            const [rows] = await db.execute(
                'SELECT u.password_hash, w.balance FROM users u JOIN wallets w ON w.user_id = u.id WHERE u.email = ?', [A]);
            const hashed = rows.length && /^\$2[aby]\$/.test(rows[0].password_hash);
            const zero = rows.length && Number(rows[0].balance) === 0;
            return { pass: r.status === 201 && hashed && zero,
                actual: `HTTP ${r.status}; bcrypt hash stored: ${!!hashed}; wallet balance: ${rows.length ? rows[0].balance : 'none'}` };
        });

    await bob('POST', '/api/auth/register', { name: 'Bob Test', email: B, password: PASSWORD });
    await admin('POST', '/api/auth/register', { name: 'Admin Test', email: ADMIN, password: PASSWORD });
    await db.execute("UPDATE users SET role = 'admin' WHERE email = ?", [ADMIN]);

    await record('TC-02', 'FR-01', 'Register with an email already in use',
        'Request rejected; no duplicate user',
        async () => {
            const r = await anonymous('POST', '/api/auth/register', { name: 'Copy', email: A, password: PASSWORD });
            const [rows] = await db.execute('SELECT COUNT(*) AS n FROM users WHERE email = ?', [A]);
            return { pass: r.status === 409 && Number(rows[0].n) === 1,
                actual: `HTTP ${r.status} "${r.data.message}"; users with this email: ${rows[0].n}` };
        });

    await record('TC-03', 'FR-02', 'Log in with correct credentials',
        'Session created; user details returned without hash',
        async () => {
            const r = await alice('POST', '/api/auth/login', { email: A, password: PASSWORD });
            const me = await alice('GET', '/api/auth/me');
            const leaked = JSON.stringify(r.data).includes('$2');
            return { pass: r.status === 200 && me.status === 200 && !leaked,
                actual: `HTTP ${r.status}; session valid: ${me.status === 200}; hash in response: ${leaked}` };
        });

    await record('TC-04', 'FR-02', 'Log in with a wrong password',
        'HTTP 401 with generic message',
        async () => {
            const wrong = await anonymous('POST', '/api/auth/login', { email: A, password: 'WrongPass999' });
            const unknown = await anonymous('POST', '/api/auth/login', { email: email('nobody'), password: 'WrongPass999' });
            const same = wrong.data.message === unknown.data.message;
            return { pass: wrong.status === 401 && unknown.status === 401 && same,
                actual: `HTTP ${wrong.status} "${wrong.data.message}"; same message for unknown email: ${same}` };
        });

    await record('TC-05', 'NFR-01', 'Call a wallet endpoint without a session',
        'HTTP 401; no data returned',
        async () => {
            const r = await anonymous('GET', '/api/wallet/balance');
            return { pass: r.status === 401 && r.data.balance === undefined,
                actual: `HTTP ${r.status} "${r.data.message}"` };
        });

    await record('TC-06', 'FR-03', 'Deposit a positive amount',
        'Balance increases; transaction recorded',
        async () => {
            const before = await balanceOf(A);
            const r = await alice('POST', '/api/wallet/deposit', { amount: 5000 });
            const after = await balanceOf(A);
            const [rows] = await db.execute('SELECT COUNT(*) AS n FROM transactions WHERE id = ?', [r.data.transactionId || 0]);
            return { pass: r.status === 200 && after === before + 5000 && Number(rows[0].n) === 1,
                actual: `HTTP ${r.status}; balance ${before.toFixed(2)} to ${after.toFixed(2)}; transaction #${r.data.transactionId} recorded` };
        });

    await record('TC-07', 'FR-03', 'Deposit zero, a negative or a non-numeric amount',
        'Request rejected; balance unchanged',
        async () => {
            const before = await balanceOf(A);
            const codes = [];
            for (const amount of [0, -50, 'abc']) {
                codes.push((await alice('POST', '/api/wallet/deposit', { amount })).status);
            }
            const after = await balanceOf(A);
            return { pass: codes.every(c => c === 400) && before === after,
                actual: `HTTP ${codes.join(', ')}; balance unchanged: ${before === after}` };
        });

    await record('TC-08', 'FR-04', 'Withdraw more than the balance',
        'HTTP 400; balance unchanged',
        async () => {
            const before = await balanceOf(A);
            const r = await alice('POST', '/api/wallet/withdraw', { amount: before + 1 });
            const after = await balanceOf(A);
            return { pass: r.status === 400 && before === after,
                actual: `HTTP ${r.status} "${r.data.message}"; balance unchanged: ${before === after}` };
        });

    await record('TC-09', 'FR-05', 'Transfer between two users',
        'Both balances update atomically; one transaction row',
        async () => {
            const a0 = await balanceOf(A), b0 = await balanceOf(B);
            const r = await alice('POST', '/api/wallet/transfer', { recipientEmail: B, amount: 200 });
            const a1 = await balanceOf(A), b1 = await balanceOf(B);
            const [rows] = await db.execute('SELECT COUNT(*) AS n FROM transactions WHERE id = ?', [r.data.transactionId || 0]);
            return { pass: r.status === 200 && a1 === a0 - 200 && b1 === b0 + 200 && Number(rows[0].n) === 1,
                actual: `HTTP ${r.status}; sender ${a0.toFixed(2)} to ${a1.toFixed(2)}; recipient ${b0.toFixed(2)} to ${b1.toFixed(2)}; one row #${r.data.transactionId}` };
        });

    await record('TC-10', 'FR-05', 'Transfer to a non-existent email',
        'HTTP 404; no balance changes',
        async () => {
            const before = await balanceOf(A);
            const r = await alice('POST', '/api/wallet/transfer', { recipientEmail: email('ghost'), amount: 10 });
            const after = await balanceOf(A);
            return { pass: r.status === 404 && before === after,
                actual: `HTTP ${r.status} "${r.data.message}"; balance unchanged: ${before === after}` };
        });

    await record('TC-11', 'FR-06', 'View transaction history',
        'All transactions listed newest first, paginated',
        async () => {
            const page1 = await alice('GET', '/api/wallet/history?page=1&limit=1');
            const all = await alice('GET', '/api/wallet/history?page=1&limit=100');
            const rows = all.data.transactions.map(t => [new Date(t.created_at).getTime(), t.id]);
            const ordered = rows.every((r, i) => i === 0 || rows[i - 1][0] > r[0] || (rows[i - 1][0] === r[0] && rows[i - 1][1] > r[1]));
            return { pass: all.status === 200 && ordered && page1.data.transactions.length === 1 && page1.data.totalPages === all.data.totalTransactions,
                actual: `HTTP ${all.status}; ${all.data.totalTransactions} transactions; newest first: ${ordered}; 1 per page gives ${page1.data.totalPages} pages` };
        });

    // The scoring checks need the model service.
    const mlUp = await mlIsUp();

    await record('TC-12', 'FR-07', 'Small transfer consistent with normal behaviour',
        'Scored; no alert created',
        async () => {
            if (!mlUp) return { pass: false, actual: `Scoring service not reachable at ${ML_URL}; start it and re-run` };
            const r = await alice('POST', '/api/wallet/transfer', { recipientEmail: B, amount: 150 });
            const [rows] = await db.execute(
                'SELECT t.scoring_status, t.fraud_score, COUNT(fa.id) AS alerts FROM transactions t LEFT JOIN fraud_alerts fa ON fa.transaction_id = t.id WHERE t.id = ? GROUP BY t.id',
                [r.data.transactionId || 0]);
            const row = rows[0] || {};
            return { pass: r.status === 200 && row.scoring_status === 'scored' && Number(row.alerts) === 0,
                actual: `HTTP ${r.status}; ${row.scoring_status}; fraud score ${row.fraud_score}; alerts: ${row.alerts}` };
        });

    let flaggedIds = [];
    await record('TC-13', 'FR-07', 'Transfer that drains the sender balance',
        'Scored at or above the threshold; pending alert created',
        async () => {
            if (!mlUp) return { pass: false, actual: `Scoring service not reachable at ${ML_URL}; start it and re-run` };
            const all = await balanceOf(A);
            const r = await alice('POST', '/api/wallet/transfer', { recipientEmail: B, amount: all });
            const [rows] = await db.execute(
                'SELECT t.fraud_score, fa.id AS alert_id, fa.status FROM transactions t LEFT JOIN fraud_alerts fa ON fa.transaction_id = t.id WHERE t.id = ?',
                [r.data.transactionId || 0]);
            const row = rows[0] || {};
            if (row.alert_id) flaggedIds.push(row.alert_id);
            return { pass: r.status === 200 && Number(row.fraud_score) >= THRESHOLD && row.status === 'pending',
                actual: `HTTP ${r.status}; fraud score ${row.fraud_score}; alert #${row.alert_id || 'none'} ${row.status || ''}; transfer completed: ${r.status === 200}` };
        });

    await record('TC-14', 'FR-08', 'Administrator confirms and dismisses alerts',
        'Status set to confirmed_fraud or cleared with reviewer and time',
        async () => {
            if (!mlUp) return { pass: false, actual: 'Needs TC-13 alerts; start the scoring service and re-run' };
            // Second flagged transaction, from Bob draining his wallet.
            await bob('POST', '/api/auth/login', { email: B, password: PASSWORD });
            const bobAll = await balanceOf(B);
            const second = await bob('POST', '/api/wallet/transfer', { recipientEmail: A, amount: bobAll });
            const [secondRows] = await db.execute('SELECT id FROM fraud_alerts WHERE transaction_id = ?', [second.data.transactionId || 0]);
            if (secondRows.length) flaggedIds.push(secondRows[0].id);
            if (flaggedIds.length < 2) return { pass: false, actual: `Only ${flaggedIds.length} alert(s) available to review` };

            await admin('POST', '/api/auth/login', { email: ADMIN, password: PASSWORD });
            const c = await admin('PATCH', `/api/admin/fraud-alerts/${flaggedIds[0]}/status`, { status: 'confirmed_fraud' });
            const d = await admin('PATCH', `/api/admin/fraud-alerts/${flaggedIds[1]}/status`, { status: 'cleared' });
            const again = await admin('PATCH', `/api/admin/fraud-alerts/${flaggedIds[0]}/status`, { status: 'cleared' });
            const [rows] = await db.execute(
                'SELECT id, status, reviewed_by, reviewed_at FROM fraud_alerts WHERE id IN (?, ?) ORDER BY id', flaggedIds.slice(0, 2));
            const recorded = rows.every(r => r.reviewed_by && r.reviewed_at);
            const statuses = rows.map(r => `#${r.id} ${r.status}`).join(', ');
            return { pass: c.status === 200 && d.status === 200 && again.status === 409 && recorded,
                actual: `Confirm HTTP ${c.status}, dismiss HTTP ${d.status}; ${statuses}; reviewer and time recorded: ${recorded}; second review refused: HTTP ${again.status}` };
        });

    await record('TC-15', 'NFR-02', 'Non-administrator calls an admin endpoint',
        'HTTP 403',
        async () => {
            const list = await alice('GET', '/api/admin/fraud-alerts');
            const patch = await alice('PATCH', '/api/admin/fraud-alerts/1/status', { status: 'cleared' });
            return { pass: list.status === 403 && patch.status === 403,
                actual: `List HTTP ${list.status}; review HTTP ${patch.status} "${patch.data.message}"` };
        });

    results.push({ id: 'TC-16', requirement: 'NFR-03', description: 'Transfer while the inference service is stopped',
        expected: 'Transfer completes; marked unscored', actual: 'Run separately: stop the scoring service, then node tests/run-tests.js --tc16', status: 'Not run' });

    await servicesSuite({ alice, mlUp });
}

// ---------- money services: savings, loans, payments, requests ----------
async function txRow(id) {
    const [rows] = await db.execute(
        "SELECT id, amount, scoring_status, fraud_score, JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.type')) AS type FROM transactions WHERE id = ?",
        [id || 0]);
    return rows[0] || {};
}

async function servicesSuite({ alice, mlUp }) {
    const carol = client();
    const dan = client();
    const C = email('carol'), D = email('dan');
    for (const [c, e, n] of [[carol, C, 'Carol Test'], [dan, D, 'Dan Test']]) {
        await c('POST', '/api/auth/register', { name: n, email: e, password: PASSWORD });
        await c('POST', '/api/auth/login', { email: e, password: PASSWORD });
    }
    await carol('POST', '/api/wallet/deposit', { amount: 2000 });
    await dan('POST', '/api/wallet/deposit', { amount: 1000 });

    await record('TC-17', 'FR-09', 'Create a locked savings goal and move money into it',
        'Goal created; wallet debited; goal balance credited; recorded as savings_deposit',
        async () => {
            const created = await carol('POST', '/api/savings', { name: 'School fees', target: 5000, lockDays: 30 });
            const id = created.data.vault && created.data.vault.id;
            const before = await balanceOf(C);
            const r = await carol('POST', `/api/savings/${id}/deposit`, { amount: 500 });
            const after = await balanceOf(C);
            const tx = await txRow(r.data.transactionId);
            return { pass: created.status === 201 && r.status === 200 && after === before - 500 && r.data.vaultBalance === 500 && tx.type === 'savings_deposit',
                actual: `Create HTTP ${created.status}; deposit HTTP ${r.status}; wallet ${before.toFixed(2)} to ${after.toFixed(2)}; goal holds ${r.data.vaultBalance}; recorded as ${tx.type}` };
        });

    await record('TC-18', 'FR-09', 'Withdraw from a goal before its unlock date',
        'HTTP 409; wallet and goal unchanged',
        async () => {
            const list = await carol('GET', '/api/savings');
            const goal = list.data.vaults.find(v => v.name === 'School fees');
            const before = await balanceOf(C);
            const r = await carol('POST', `/api/savings/${goal.id}/withdraw`, {});
            const after = await balanceOf(C);
            const again = (await carol('GET', '/api/savings')).data.vaults.find(v => v.id === goal.id);
            return { pass: r.status === 409 && before === after && again.balance === 500,
                actual: `HTTP ${r.status} "${r.data.message}"; wallet unchanged: ${before === after}; goal still holds ${again.balance}` };
        });

    await record('TC-19', 'FR-09', 'Withdraw everything from a goal with no lock',
        'Money returned to wallet; goal closed; recorded as savings_release',
        async () => {
            const created = await carol('POST', '/api/savings', { name: 'Flexible', lockDays: 0 });
            const id = created.data.vault.id;
            await carol('POST', `/api/savings/${id}/deposit`, { amount: 300 });
            const before = await balanceOf(C);
            const r = await carol('POST', `/api/savings/${id}/withdraw`, {});
            const after = await balanceOf(C);
            const goal = (await carol('GET', '/api/savings')).data.vaults.find(v => v.id === id);
            const tx = await txRow(r.data.transactionId);
            return { pass: r.status === 200 && after === before + 300 && goal.status === 'closed' && tx.type === 'savings_release',
                actual: `HTTP ${r.status}; wallet ${before.toFixed(2)} to ${after.toFixed(2)}; goal ${goal.status}; recorded as ${tx.type}` };
        });

    await record('TC-20', 'FR-10', 'Loan limit follows recent inflow',
        'Limit is 30% of money received in the last 30 days, rounded down to 50',
        async () => {
            const r = await carol('GET', '/api/loans');
            return { pass: r.status === 200 && r.data.limit === 600 && r.data.eligible === true,
                actual: `HTTP ${r.status}; received 2,000.00; limit ${r.data.limit}; eligible: ${r.data.eligible}` };
        });

    await record('TC-21', 'FR-10', 'Take a loan within the limit, then apply again',
        'Wallet credited; amount due includes 7.5% fee; second application refused',
        async () => {
            const before = await balanceOf(C);
            const r = await carol('POST', '/api/loans', { amount: 400 });
            const after = await balanceOf(C);
            const second = await carol('POST', '/api/loans', { amount: 100 });
            const loan = r.data.loan || {};
            return { pass: r.status === 201 && after === before + 400 && loan.amount_due === 430 && second.status === 409,
                actual: `HTTP ${r.status}; wallet ${before.toFixed(2)} to ${after.toFixed(2)}; due ${loan.amount_due} by ${String(loan.due_date).slice(0, 10)}; second application HTTP ${second.status}` };
        });

    await record('TC-22', 'FR-10', 'Repay a loan in two parts',
        'Overpayment refused; partial then final repayment clears the loan',
        async () => {
            const over = await carol('POST', '/api/loans/repay', { amount: 1000 });
            const part = await carol('POST', '/api/loans/repay', { amount: 200 });
            const rest = await carol('POST', '/api/loans/repay', { amount: 230 });
            const after = await carol('GET', '/api/loans');
            const last = after.data.history[0] || {};
            return { pass: over.status === 400 && part.status === 200 && rest.status === 200 && last.status === 'repaid' && after.data.active === null,
                actual: `Overpay HTTP ${over.status}; part HTTP ${part.status} (${part.data.loan && part.data.loan.outstanding} left); final HTTP ${rest.status}; loan ${last.status}` };
        });

    await record('TC-23', 'FR-10', 'Borrow after a transaction was confirmed as fraud',
        'Loan refused with a fraud-related reason',
        async () => {
            if (!mlUp) return { pass: false, actual: 'Needs the alert confirmed in TC-14; start the scoring service and re-run' };
            const r = await alice('GET', '/api/loans');
            const apply = await alice('POST', '/api/loans', { amount: 100 });
            return { pass: r.data.eligible === false && /fraud/i.test(r.data.reason || '') && apply.status === 409,
                actual: `Eligible: ${r.data.eligible}; "${r.data.reason}"; application HTTP ${apply.status}` };
        });

    await record('TC-24', 'FR-11', 'Bank transfer, and one with an invalid account number',
        'Valid transfer debits the wallet and is fraud-scored as a cash-out; invalid one rejected',
        async () => {
            const bad = await carol('POST', '/api/payments/bank', { bank: 'KCB Bank', accountNumber: '12ab', amount: 50 });
            const before = await balanceOf(C);
            const r = await carol('POST', '/api/payments/bank', { bank: 'KCB Bank', accountNumber: '1234567890', amount: 250 });
            const after = await balanceOf(C);
            const tx = await txRow(r.data.transactionId);
            const scoredOk = mlUp ? tx.scoring_status === 'scored' : tx.scoring_status === 'unscored';
            return { pass: bad.status === 400 && r.status === 200 && after === before - 250 && tx.type === 'bank_transfer' && scoredOk,
                actual: `Invalid HTTP ${bad.status}; valid HTTP ${r.status}; wallet ${before.toFixed(2)} to ${after.toFixed(2)}; ${tx.scoring_status}, fraud score ${tx.fraud_score}` };
        });

    await record('TC-25', 'FR-11', 'Pay bill, buy goods and airtime',
        'Each payment debits the wallet without a fraud score; invalid numbers rejected',
        async () => {
            const bad = await carol('POST', '/api/payments/bill', { kind: 'paybill', number: '12', account: 'X', amount: 10 });
            const before = await balanceOf(C);
            const codes = [];
            codes.push((await carol('POST', '/api/payments/bill', { kind: 'paybill', number: '888880', account: 'ACC-001', amount: 100 })).status);
            codes.push((await carol('POST', '/api/payments/bill', { kind: 'till', number: '123456', amount: 50 })).status);
            const air = await carol('POST', '/api/payments/bill', { kind: 'airtime', number: '0712345678', amount: 20 });
            codes.push(air.status);
            const after = await balanceOf(C);
            const history = await carol('GET', '/api/wallet/history?page=1&limit=3');
            const noCheck = history.data.transactions.every(t => t.type === 'payment' && !t.fraud_check);
            return { pass: bad.status === 400 && codes.every(c => c === 200) && after === before - 170 && noCheck,
                actual: `Invalid HTTP ${bad.status}; payments HTTP ${codes.join(', ')}; wallet ${before.toFixed(2)} to ${after.toFixed(2)}; no fraud check shown: ${noCheck}` };
        });

    await record('TC-26', 'FR-12', 'Request money, pay it, and decline another',
        'Request paid through a scored transfer; mismatched or reused transfer refused; decline recorded',
        async () => {
            const req1 = await carol('POST', '/api/requests', { email: D, amount: 120, note: 'Lunch' });
            const req2 = await carol('POST', '/api/requests', { email: D, amount: 80 });
            const wrong = await dan('POST', '/api/wallet/transfer', { recipientEmail: C, amount: 50 });
            const mismatch = await dan('POST', `/api/requests/${req1.data.id}/pay`, { transactionId: wrong.data.transactionId });
            const transfer = await dan('POST', '/api/wallet/transfer', { recipientEmail: C, amount: 120 });
            const paid = await dan('POST', `/api/requests/${req1.data.id}/pay`, { transactionId: transfer.data.transactionId });
            const reuse = await dan('POST', `/api/requests/${req2.data.id}/pay`, { transactionId: transfer.data.transactionId });
            const declined = await dan('POST', `/api/requests/${req2.data.id}/decline`, {});
            const list = await carol('GET', '/api/requests');
            const s1 = list.data.requests.find(r => r.id === req1.data.id).status;
            const s2 = list.data.requests.find(r => r.id === req2.data.id).status;
            const tx = await txRow(transfer.data.transactionId);
            const scoredOk = mlUp ? tx.scoring_status === 'scored' : true;
            return { pass: req1.status === 201 && mismatch.status === 400 && paid.status === 200 && reuse.status === 400 && declined.status === 200 && s1 === 'paid' && s2 === 'declined' && scoredOk,
                actual: `Create HTTP ${req1.status}; wrong amount HTTP ${mismatch.status}; paid HTTP ${paid.status} (transfer ${tx.scoring_status}); reused transfer HTTP ${reuse.status}; decline HTTP ${declined.status}; statuses ${s1}, ${s2}` };
        });
}

async function tc16() {
    if (await mlIsUp()) {
        console.log('The scoring service is still running. Stop it (Ctrl+C in its window) and run this again.');
        return false;
    }
    const sender = client();
    const S = email('tc16sender'), R = email('tc16recipient');
    await sender('POST', '/api/auth/register', { name: 'TC16 Sender', email: S, password: PASSWORD });
    await client()('POST', '/api/auth/register', { name: 'TC16 Recipient', email: R, password: PASSWORD });
    await sender('POST', '/api/auth/login', { email: S, password: PASSWORD });
    await sender('POST', '/api/wallet/deposit', { amount: 1000 });

    await record('TC-16', 'NFR-03', 'Transfer while the inference service is stopped',
        'Transfer completes; marked unscored',
        async () => {
            const started = Date.now();
            const r = await sender('POST', '/api/wallet/transfer', { recipientEmail: R, amount: 100 });
            const ms = Date.now() - started;
            const [rows] = await db.execute('SELECT scoring_status, fraud_score FROM transactions WHERE id = ?', [r.data.transactionId || 0]);
            const row = rows[0] || {};
            return { pass: r.status === 200 && row.scoring_status === 'unscored' && row.fraud_score === null,
                actual: `HTTP ${r.status}; ${row.scoring_status}; fraud score ${row.fraud_score}; response in ${ms} ms` };
        });
    return true;
}

function writeResults(file) {
    const dir = path.join(__dirname, 'results');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const lines = [
        `# SecureWallet functional test results`,
        ``,
        `Run: ${stamp} UTC against ${BASE} (scoring service ${ML_URL})`,
        ``,
        `| ID | Req. | Test description | Expected result | Actual result | Status |`,
        `|---|---|---|---|---|---|`,
        ...results.map(r => `| ${r.id} | ${r.requirement} | ${r.description} | ${r.expected} | ${r.actual.replace(/\|/g, '/')} | ${r.status} |`),
    ];
    fs.writeFileSync(path.join(dir, file + '.md'), lines.join('\n') + '\n');
    fs.writeFileSync(path.join(dir, file + '.json'), JSON.stringify({ run: stamp, base: BASE, results }, null, 2));
    const passed = results.filter(r => r.status === 'Pass').length;
    const ran = results.filter(r => r.status !== 'Not run').length;
    console.log(`\n${passed} of ${ran} test cases passed. Results saved to tests/results/${file}.md`);
}

(async () => {
    try {
        if (process.argv.includes('--cleanup')) { await cleanup(); return; }
        const health = await fetch(BASE + '/api').catch(() => null);
        if (!health || !health.ok) {
            console.log(`The website is not reachable at ${BASE}. Start it with npm run dev and try again.`);
            return;
        }
        if (process.argv.includes('--tc16')) {
            if (await tc16()) writeResults('results-tc16');
        } else {
            await mainSuite();
            writeResults('results');
        }
    } finally {
        await db.end();
        if (results.some(r => r.status === 'Fail')) process.exitCode = 1;
    }
})();
