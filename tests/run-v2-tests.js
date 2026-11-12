// SecureWallet version 2 test runner: risk engine, transaction PIN,
// holds, confirmation of payee, attack lab and security hardening.
// Runs test cases TC-27 to TC-40 and writes the evidence to tests/results/.
//
// Start the website in enforce mode with the attack lab on, so every case
// can run. In .env set:
//     RISK_MODE=enforce
//     ATTACK_LAB=1
// then restart the website (npm run dev) with the scoring service running.
//
// Run from the project root:
//   node tests/run-v2-tests.js
//
// In advisory mode the cases that need enforcement are reported as
// "Not run" rather than failed. Test accounts end in @test.securewallet and
// are removed by:  node tests/run-tests.js --cleanup

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/config/db');

const BASE = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const RUN_ID = Date.now().toString(36);
const PASSWORD = 'TestPass123';
const PIN = '4826';
const results = [];
let status = {};

function client() {
    let cookie = '';
    const call = async function (method, url, body) {
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
        return { status: response.status, data, headers: response.headers };
    };
    return call;
}

const email = name => `${name}.${RUN_ID}@test.securewallet`;

// Registers and signs in a user, optionally with a starting balance and PIN.
async function user(name, { deposit = 0, pin = false } = {}) {
    const call = client();
    const address = email(name.toLowerCase());
    await call('POST', '/api/auth/register', { name: `${name} Test`, email: address, password: PASSWORD });
    await call('POST', '/api/auth/login', { email: address, password: PASSWORD });
    if (deposit) await call('POST', '/api/wallet/deposit', { amount: deposit });
    if (pin) await call('POST', '/api/auth/pin', { password: PASSWORD, pin: PIN });
    return { call, email: address };
}

async function balanceOf(address) {
    const [rows] = await db.execute(
        'SELECT w.balance FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.email = ?', [address]);
    return rows.length ? Number(rows[0].balance) : null;
}

async function txOf(id) {
    const [rows] = await db.execute(
        `SELECT t.status, t.fraud_score, t.metadata, fa.id AS alert_id, fa.alert_type, fa.status AS alert_status
         FROM transactions t LEFT JOIN fraud_alerts fa ON fa.transaction_id = t.id WHERE t.id = ?`, [id || 0]);
    const row = rows[0] || {};
    row.meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
    return row;
}

async function record(id, requirement, description, expected, fn, needs) {
    if (needs && !needs.ok) {
        results.push({ id, requirement, description, expected, actual: needs.why, status: 'Not run' });
        console.log(`SKIP  ${id}  ${description}\n      ${needs.why}`);
        return;
    }
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

// A payment the engine puts in the challenge tier: money that has just
// arrived is sent straight back to the person it came from.
async function challengePair(tag, { pin }) {
    const first = await user(`${tag}a`, { deposit: 5000 });
    const second = await user(`${tag}b`, { deposit: 5000, pin });
    await first.call('POST', '/api/wallet/transfer', { recipientEmail: second.email, amount: 500 });
    return { first, second, body: { recipientEmail: first.email, amount: 500 } };
}

// A payment the engine holds: an account receives money and at once sends
// its whole balance to someone it has never paid.
async function heldPayment(tag) {
    const source = await user(`${tag}s`, { deposit: 20000 });
    const middle = await user(`${tag}m`);
    const target = await user(`${tag}t`, { deposit: 100 });
    await source.call('POST', '/api/wallet/transfer', { recipientEmail: middle.email, amount: 3000 });
    const sent = await middle.call('POST', '/api/wallet/transfer', { recipientEmail: target.email, amount: 3000 });
    return { middle, target, sent };
}

async function suite() {
    status = (await client()('GET', '/api/status')).data;
    const scoring = { ok: status.scoring === 'operational', why: 'Not run: the scoring service is not reachable; start it and run again' };
    const enforce = {
        ok: scoring.ok && status.riskMode === 'enforce',
        why: scoring.ok ? 'Not run: needs enforce mode; set RISK_MODE=enforce in .env, restart the website and run again' : scoring.why,
    };
    const lab = { ok: scoring.ok && status.attackLab === true, why: scoring.ok ? 'Not run: needs the attack lab; set ATTACK_LAB=1 in .env, restart the website and run again' : scoring.why };

    const admin = client();
    const ADMIN = email('v2admin');
    await admin('POST', '/api/auth/register', { name: 'Admin Test', email: ADMIN, password: PASSWORD });
    await db.execute("UPDATE users SET role = 'admin' WHERE email = ?", [ADMIN]);
    await admin('POST', '/api/auth/login', { email: ADMIN, password: PASSWORD });

    await record('TC-27', 'FR-18', 'Confirmation of payee before a transfer',
        'Registered name returned for a real recipient; 404 for an unknown address; 401 when signed out',
        async () => {
            const a = await user('payeea', { deposit: 5000 });
            const b = await user('payeeb', { deposit: 500 });
            const known = await a.call('GET', '/api/wallet/recipient?email=' + encodeURIComponent(b.email));
            const unknown = await a.call('GET', '/api/wallet/recipient?email=nobody.' + RUN_ID + '@test.securewallet');
            const anonymous = await client()('GET', '/api/wallet/recipient?email=' + encodeURIComponent(b.email));
            await a.call('POST', '/api/wallet/transfer', { recipientEmail: b.email, amount: 50 });
            const after = await a.call('GET', '/api/wallet/recipient?email=' + encodeURIComponent(b.email));
            return {
                pass: known.status === 200 && known.data.name === 'payeeb Test' && known.data.paidBefore === false
                    && unknown.status === 404 && anonymous.status === 401 && after.data.paidBefore === true,
                actual: `Known HTTP ${known.status} "${known.data.name}", paid before: ${known.data.paidBefore}; unknown HTTP ${unknown.status}; signed out HTTP ${anonymous.status}; after one payment, paid before: ${after.data.paidBefore}`,
            };
        });

    await record('TC-28', 'FR-19', 'Set a transaction PIN',
        'Weak PIN and wrong password refused; valid PIN stored as a bcrypt hash; changing it needs the current PIN',
        async () => {
            const a = await user('pinset');
            const weak = await a.call('POST', '/api/auth/pin', { password: PASSWORD, pin: '1234' });
            const wrong = await a.call('POST', '/api/auth/pin', { password: 'not-the-password', pin: PIN });
            const good = await a.call('POST', '/api/auth/pin', { password: PASSWORD, pin: PIN });
            const noCurrent = await a.call('POST', '/api/auth/pin', { password: PASSWORD, pin: '7391' });
            const change = await a.call('POST', '/api/auth/pin', { password: PASSWORD, pin: '7391', currentPin: PIN });
            const me = await a.call('GET', '/api/auth/me');
            const [rows] = await db.execute('SELECT pin_hash FROM users WHERE email = ?', [a.email]);
            const hashed = rows.length && /^\$2[aby]\$/.test(rows[0].pin_hash || '');
            return {
                pass: weak.status === 400 && wrong.status === 403 && good.status === 200 && noCurrent.status === 403
                    && change.status === 200 && me.data.user.hasPin === true && !!hashed,
                actual: `Weak PIN HTTP ${weak.status}; wrong password HTTP ${wrong.status}; valid HTTP ${good.status}; change without the current PIN HTTP ${noCurrent.status}, with it HTTP ${change.status}; account reports a PIN: ${me.data.user.hasPin}; bcrypt hash stored: ${!!hashed}`,
            };
        });

    await record('TC-29', 'FR-20', 'Risk assessment and explanation stored with a transaction',
        'Model score, risk score, signals and feature contributions recorded; contributions add up to the model score',
        async () => {
            const a = await user('explaina', { deposit: 2000 });
            const b = await user('explainb');
            const r = await a.call('POST', '/api/wallet/transfer', { recipientEmail: b.email, amount: 100 });
            const risk = (await txOf(r.data.transactionId)).meta.risk || {};
            const total = (risk.base_value || 0) + (risk.contributions || []).reduce((sum, c) => sum + c.contribution, 0);
            const addsUp = Math.abs(total - risk.model_score) < 0.001;
            const firstPayment = (risk.signals || []).some(s => s.key === 'new_recipient');
            return {
                pass: r.status === 200 && (risk.contributions || []).length === 7 && addsUp && firstPayment && risk.score >= risk.model_score,
                actual: `HTTP ${r.status}; model score ${risk.model_score}; risk ${risk.score}; signals: ${(risk.signals || []).map(s => s.key).join(', ') || 'none'}; ${(risk.contributions || []).length} contributions; base value plus contributions = ${total.toFixed(4)}`,
            };
        }, scoring);

    await record('TC-30', 'FR-21', 'Unusual payment is challenged for the PIN',
        'HTTP 428 and no money moved without the PIN or with a wrong PIN; payment completes with the right PIN and no alert is raised',
        async () => {
            const { second, body } = await challengePair('chal', { pin: true });
            const before = await balanceOf(second.email);
            const noPin = await second.call('POST', '/api/wallet/transfer', body);
            const wrongPin = await second.call('POST', '/api/wallet/transfer', { ...body, pin: '0000' });
            const untouched = (await balanceOf(second.email)) === before;
            const good = await second.call('POST', '/api/wallet/transfer', { ...body, pin: PIN });
            const tx = await txOf(good.data.transactionId);
            return {
                pass: noPin.status === 428 && noPin.data.challenge === 'pin' && noPin.data.risk.score === undefined && wrongPin.status === 403 && untouched
                    && good.status === 200 && tx.meta.risk.action === 'verified' && !tx.alert_id,
                actual: `No PIN HTTP ${noPin.status} (${noPin.data.challenge || 'no challenge'}: ${noPin.data.risk ? noPin.data.risk.reasons.join('; ') : ''}); scores kept from the client: ${!!noPin.data.risk && noPin.data.risk.score === undefined}; wrong PIN HTTP ${wrongPin.status}; balance unchanged: ${untouched}; right PIN HTTP ${good.status}, recorded as ${tx.meta.risk ? tx.meta.risk.action : 'n/a'}; alert: ${tx.alert_id ? 'raised' : 'none'}`,
            };
        }, enforce);

    await record('TC-31', 'FR-21', 'Unusual payment by a user with no PIN',
        'HTTP 428 asking the user to set a PIN; no money moved',
        async () => {
            const { second, body } = await challengePair('nopin', { pin: false });
            const before = await balanceOf(second.email);
            const r = await second.call('POST', '/api/wallet/transfer', body);
            const untouched = (await balanceOf(second.email)) === before;
            return { pass: r.status === 428 && r.data.challenge === 'set_pin' && untouched,
                actual: `HTTP ${r.status} (${r.data.challenge || 'no challenge'}) "${r.data.message}"; balance unchanged: ${untouched}` };
        }, enforce);

    await record('TC-32', 'FR-19', 'Five wrong PIN attempts lock the PIN',
        'Fifth wrong attempt locks the PIN; the right PIN is then refused with HTTP 423',
        async () => {
            const { second, body } = await challengePair('lock', { pin: true });
            const codes = [];
            for (let i = 0; i < 5; i += 1) {
                codes.push((await second.call('POST', '/api/wallet/transfer', { ...body, pin: '9999' })).status);
            }
            const locked = await second.call('POST', '/api/wallet/transfer', { ...body, pin: PIN });
            return { pass: codes.every(code => code === 403) && locked.status === 423,
                actual: `Wrong attempts HTTP ${codes.join(', ')}; right PIN afterwards HTTP ${locked.status} "${locked.data.message}"` };
        }, enforce);

    await record('TC-33', 'FR-22', 'High-risk payment is held, then released by the analyst',
        'Sender debited, recipient not credited and transaction pending; after the alert is cleared the recipient is credited',
        async () => {
            const { middle, target, sent } = await heldPayment('rel');
            const held = await txOf(sent.data.transactionId);
            const during = { sender: await balanceOf(middle.email), recipient: await balanceOf(target.email) };
            const seen = await target.call('GET', '/api/wallet/history?page=1&limit=10');
            const hidden = !seen.data.transactions.some(t => t.id === sent.data.transactionId);
            const review = await admin('PATCH', `/api/admin/fraud-alerts/${held.alert_id}/status`, { status: 'cleared' });
            const after = await txOf(sent.data.transactionId);
            const recipientAfter = await balanceOf(target.email);
            return {
                pass: sent.status === 200 && sent.data.held === true && held.status === 'pending' && held.alert_type === 'hold'
                    && during.sender === 0 && during.recipient === 100 && hidden
                    && review.data.settlement === 'released' && after.status === 'completed' && recipientAfter === 3100,
                actual: `HTTP ${sent.status}, held: ${sent.data.held}, risk ${held.fraud_score}; transaction ${held.status}, alert type ${held.alert_type}; while held sender ${during.sender}, recipient ${during.recipient}, hidden from recipient: ${hidden}; review HTTP ${review.status} (${review.data.settlement}); transaction ${after.status}, recipient now ${recipientAfter}`,
            };
        }, enforce);

    await record('TC-34', 'FR-22', 'High-risk payment is held, then refunded when fraud is confirmed',
        'After the alert is confirmed as fraud the money is back with the sender and the recipient received nothing',
        async () => {
            const { middle, target, sent } = await heldPayment('ref');
            const held = await txOf(sent.data.transactionId);
            const review = await admin('PATCH', `/api/admin/fraud-alerts/${held.alert_id}/status`, { status: 'confirmed_fraud' });
            const again = await admin('PATCH', `/api/admin/fraud-alerts/${held.alert_id}/status`, { status: 'cleared' });
            const after = await txOf(sent.data.transactionId);
            const sender = await balanceOf(middle.email);
            const recipient = await balanceOf(target.email);
            return {
                pass: sent.data.held === true && review.data.settlement === 'reversed' && again.status === 409
                    && after.status === 'failed' && sender === 3000 && recipient === 100,
                actual: `Held: ${sent.data.held}; review HTTP ${review.status} (${review.data.settlement}); second decision HTTP ${again.status}; transaction ${after.status}; sender back to ${sender}; recipient ${recipient}`,
            };
        }, enforce);

    await record('TC-35', 'NFR-03', 'Signals still protect the wallet when the model score is low',
        'A burst of small payments to one recipient is challenged although the model alone scores each below the threshold',
        async () => {
            const a = await user('bursta', { deposit: 10000, pin: true });
            const b = await user('burstb', { deposit: 500 });
            const codes = [];
            const modelScores = [];
            let last;
            for (let i = 0; i < 4; i += 1) {
                last = await a.call('POST', '/api/wallet/transfer', { recipientEmail: b.email, amount: 300 });
                codes.push(last.status);
                if (last.data.transactionId) modelScores.push((await txOf(last.data.transactionId)).meta.risk.model_score);
            }
            const highest = Math.max(...modelScores);
            return {
                pass: codes.slice(0, 3).every(code => code === 200) && codes[3] === 428 && highest < 0.5,
                actual: `Payments HTTP ${codes.join(', ')}; highest model score among those sent ${highest}; fourth stopped for: ${((last.data.risk || {}).reasons || []).join('; ')}`,
            };
        }, enforce);

    await record('TC-36', 'FR-23', 'Attack lab scenarios',
        'Every attack step expected to be caught is caught; ordinary behaviour raises no false alarm; a non-administrator is refused',
        async () => {
            const outsider = await user('labuser');
            const refused = await outsider.call('POST', '/api/admin/lab/run', { scenario: 'takeover' });
            const lines = [];
            let ok = refused.status === 403;
            for (const id of ['normal', 'takeover', 'velocity', 'mule_chain', 'fan_in', 'round_trip']) {
                const run = await admin('POST', '/api/admin/lab/run', { scenario: id });
                const s = run.data.summary || {};
                ok = ok && run.status === 200 && s.detected === s.attackSteps && s.falsePositives === 0;
                lines.push(id === 'normal'
                    ? `normal: ${s.falsePositives} false alarms in ${s.normalSteps}`
                    : `${id}: ${s.detected} of ${s.attackSteps} caught (model alone ${s.modelAlone})`);
            }
            const cleaned = await admin('POST', '/api/admin/lab/cleanup', {});
            const [left] = await db.execute("SELECT COUNT(*) AS n FROM users WHERE email LIKE '%@lab.securewallet'");
            ok = ok && cleaned.status === 200 && Number(left[0].n) === 0;
            return { pass: ok, actual: `Non-admin HTTP ${refused.status}; ${lines.join('; ')}; cleanup removed ${cleaned.data.removed} accounts, ${left[0].n} left` };
        }, lab);

    await record('TC-37', 'NFR-02', 'Security headers and sign-in rate limit',
        'Security headers on responses; the eleventh failed sign-in in 15 minutes is refused with HTTP 429',
        async () => {
            const anonymous = client();
            const page = await anonymous('GET', '/api/status');
            const headers = ['content-security-policy', 'x-content-type-options', 'x-frame-options'].filter(h => page.headers.get(h));
            const target = email('ratelimit');
            const codes = [];
            for (let i = 0; i < 11; i += 1) {
                codes.push((await anonymous('POST', '/api/auth/login', { email: target, password: 'wrong-password' })).status);
            }
            return { pass: headers.length === 3 && codes.slice(0, 10).every(code => code === 401) && codes[10] === 429,
                actual: `Headers present: ${headers.join(', ')}; first ten attempts HTTP ${[...new Set(codes.slice(0, 10))].join('/')}; eleventh HTTP ${codes[10]}` };
        });

    await record('TC-38', 'NFR-02', 'Held payment cannot be settled twice or by a non-administrator',
        'A user cannot review an alert; a reviewed hold does not move money again',
        async () => {
            const { middle, target, sent } = await heldPayment('twice');
            const held = await txOf(sent.data.transactionId);
            const byUser = await middle.call('PATCH', `/api/admin/fraud-alerts/${held.alert_id}/status`, { status: 'cleared' });
            const stillHeld = (await txOf(sent.data.transactionId)).status === 'pending';
            await admin('PATCH', `/api/admin/fraud-alerts/${held.alert_id}/status`, { status: 'cleared' });
            const again = await admin('PATCH', `/api/admin/fraud-alerts/${held.alert_id}/status`, { status: 'cleared' });
            const recipient = await balanceOf(target.email);
            return { pass: byUser.status === 403 && stillHeld && again.status === 409 && recipient === 3100,
                actual: `User review HTTP ${byUser.status}, still held: ${stillHeld}; second release HTTP ${again.status}; recipient credited once: ${recipient}` };
        }, enforce);

    await record('TC-39', 'NFR-02', 'Parallel requests cannot get round the checks',
        'Of eight identical transfers sent at once, no more than three go through before the PIN is asked for; eight wrong PINs sent at once lock the PIN',
        async () => {
            const a = await user('para', { deposit: 10000, pin: true });
            const b = await user('parb', { deposit: 500 });
            const body = { recipientEmail: b.email, amount: 300 };
            const burst = await Promise.all(Array.from({ length: 8 }, () => a.call('POST', '/api/wallet/transfer', body)));
            const sent = burst.filter(r => r.status === 200).length;
            const challenged = burst.filter(r => r.status === 428).length;
            const moved = 10000 - (await balanceOf(a.email));
            await Promise.all(Array.from({ length: 8 }, () => a.call('POST', '/api/wallet/transfer', { ...body, pin: '9999' })));
            const after = await a.call('POST', '/api/wallet/transfer', { ...body, pin: PIN });
            return { pass: sent <= 3 && sent + challenged === 8 && moved === sent * 300 && after.status === 423,
                actual: `Eight at once: ${sent} sent, ${challenged} asked for the PIN, ${moved} moved; after eight wrong PINs at once the right PIN gets HTTP ${after.status}` };
        }, enforce);

    await record('TC-40', 'FR-22', 'Held payment of a money request',
        'The request stays open while the payment is held and is marked paid when the payment is released',
        async () => {
            const source = await user('reqs', { deposit: 20000 });
            const payer = await user('reqp');
            const asker = await user('reqa', { deposit: 100 });
            const request = await asker.call('POST', '/api/requests', { email: payer.email, amount: 3000, note: 'held request' });
            await source.call('POST', '/api/wallet/transfer', { recipientEmail: payer.email, amount: 3000 });
            const sent = await payer.call('POST', '/api/wallet/transfer', { recipientEmail: asker.email, amount: 3000, requestId: request.data.id });
            const statusOf = async () => (await db.execute('SELECT status FROM money_requests WHERE id = ?', [request.data.id]))[0][0].status;
            const during = await statusOf();
            const held = await txOf(sent.data.transactionId);
            await admin('PATCH', `/api/admin/fraud-alerts/${held.alert_id}/status`, { status: 'cleared' });
            const after = await statusOf();
            return { pass: sent.data.held === true && during === 'pending' && after === 'paid',
                actual: `Held: ${sent.data.held}; request while held: ${during}; after release: ${after}` };
        }, enforce);
}

function writeResults() {
    const dir = path.join(__dirname, 'results');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const lines = [
        '# SecureWallet version 2 test results',
        '',
        `Run: ${stamp} UTC against ${BASE} (risk mode ${status.riskMode || 'unknown'}, attack lab ${status.attackLab ? 'on' : 'off'}, scoring ${status.scoring || 'unknown'})`,
        '',
        '| ID | Req. | Test description | Expected result | Actual result | Status |',
        '|---|---|---|---|---|---|',
        ...results.map(r => `| ${r.id} | ${r.requirement} | ${r.description} | ${r.expected} | ${r.actual.replace(/\|/g, '/')} | ${r.status} |`),
    ];
    fs.writeFileSync(path.join(dir, 'results-v2.md'), lines.join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'results-v2.json'), JSON.stringify({ run: stamp, base: BASE, status, results }, null, 2));
    const passed = results.filter(r => r.status === 'Pass').length;
    const ran = results.filter(r => r.status !== 'Not run').length;
    const skipped = results.length - ran;
    console.log(`\n${passed} of ${ran} test cases passed${skipped ? `, ${skipped} not run` : ''}. Results saved to tests/results/results-v2.md`);
}

(async () => {
    try {
        const health = await fetch(BASE + '/api').catch(() => null);
        if (!health || !health.ok) {
            console.log(`The website is not reachable at ${BASE}. Start it with npm run dev and try again.`);
            process.exitCode = 1;
            return;
        }
        await suite();
        writeResults();
    } finally {
        await db.end();
        if (results.some(r => r.status === 'Fail')) process.exitCode = 1;
    }
})();
