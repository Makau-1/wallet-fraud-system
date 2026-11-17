// Load test (version 3): many simulated users at once against the running
// system, reporting throughput and response-time percentiles.
//
//   node scripts/load-test.js [users] [seconds] [base url]
//   node scripts/load-test.js 50 30
//
// Each simulated user signs up, deposits, then in a loop checks the
// balance, views history and sends a small transfer to another user, with
// no pause between requests. Transfers carry the PIN, so a payment the
// risk engine challenges still goes through as a customer's would. Results go to tests/results/load-test-<users>-users.md.
// Run it against a test database: it creates accounts ending in
// @test.securewallet (remove them with node tests/run-tests.js --cleanup).

const fs = require('fs');
const os = require('os');
const path = require('path');

const USERS = Number(process.argv[2] || 50);
const SECONDS = Number(process.argv[3] || 30);
const BASE = (process.argv[4] || process.env.TEST_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const RUN = Date.now().toString(36);
const samples = new Map();
const statuses = new Map();

function record(name, ms, status) {
    if (!samples.has(name)) samples.set(name, []);
    samples.get(name).push(ms);
    const key = `${Math.floor(status / 100)}xx`;
    statuses.set(key, (statuses.get(key) || 0) + 1);
}

function client() {
    let cookie = '';
    return async (name, method, url, body) => {
        const started = performance.now();
        const response = await fetch(BASE + url, {
            method,
            headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        const set = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
        if (set.length) {
            const jar = new Map(cookie ? cookie.split('; ').map(c => [c.split('=')[0], c]) : []);
            set.forEach(c => { const pair = c.split(';')[0]; jar.set(pair.split('=')[0], pair); });
            cookie = [...jar.values()].join('; ');
        }
        await response.arrayBuffer();
        record(name, performance.now() - started, response.status);
        return response.status;
    };
}

function pct(sorted, p) {
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

(async () => {
    console.log(`Setting up ${USERS} users against ${BASE}…`);
    const users = [];
    for (let i = 0; i < USERS; i += 1) {
        const call = client();
        const email = `load${i}.${RUN}@test.securewallet`;
        await call('setup: register', 'POST', '/api/auth/register', { name: `Load ${i}`, email, password: 'LoadTest123' });
        await call('setup: sign in', 'POST', '/api/auth/login', { email, password: 'LoadTest123' });
        await call('setup: set PIN', 'POST', '/api/auth/pin', { password: 'LoadTest123', pin: '2468' });
        await call('setup: deposit', 'POST', '/api/wallet/deposit', { amount: 100000 });
        users.push({ call, email });
    }
    samples.clear();
    statuses.clear();

    console.log(`Running for ${SECONDS} seconds…`);
    const end = Date.now() + SECONDS * 1000;
    let requests = 0;
    await Promise.all(users.map(async (u, i) => {
        const to = users[(i + 1) % users.length].email;
        while (Date.now() < end) {
            await u.call('GET balance', 'GET', '/api/wallet/balance');
            await u.call('GET history', 'GET', '/api/wallet/history?page=1&limit=10');
            await u.call('POST transfer', 'POST', '/api/wallet/transfer', { recipientEmail: to, amount: 10, pin: '2468', purpose: 'family_friends' });
            requests += 3;
        }
    }));

    const rows = [...samples.entries()].map(([name, list]) => {
        const sorted = list.sort((a, b) => a - b);
        return { name, n: sorted.length, p50: pct(sorted, 50), p95: pct(sorted, 95), p99: pct(sorted, 99), max: sorted[sorted.length - 1] };
    });
    const lines = [
        '# SecureWallet load test',
        '',
        `${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC · ${USERS} simultaneous users · ${SECONDS} seconds · ${BASE}`,
        '',
        `Load generator machine: ${os.cpus().length} CPU cores, ${Math.round(os.totalmem() / 2 ** 30)} GB memory, Node ${process.version}. When the base URL is localhost, the website, the scoring service, the database and this script share those cores.`,
        '',
        `Requests: ${requests} (${(requests / SECONDS).toFixed(1)} a second). Responses: ${[...statuses.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}.`,
        '',
        '| Request | Count | Median (ms) | 95th (ms) | 99th (ms) | Slowest (ms) |',
        '|---|---|---|---|---|---|',
        ...rows.map(r => `| ${r.name} | ${r.n} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.p99.toFixed(1)} | ${r.max.toFixed(1)} |`),
        '',
        'Each transfer includes the risk assessment (a call to the scoring model plus the behavioural, network and device checks), the double-entry journal entry and the audit record. The simulated users send far faster than any person would, so the velocity check challenges most of their transfers, and each challenged transfer also checks the PIN with bcrypt, which is slow on purpose. The figures are therefore a pessimistic ceiling for the transfer path. Users wait for each reply before sending the next request, so the rate shown is the most the system completed at that level of concurrency.',
    ];
    const dir = path.join(__dirname, '..', 'tests', 'results');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `load-test-${USERS}-users.md`), lines.join('\n') + '\n');
    console.log(lines.join('\n'));
    // Any server error fails the run (and the CI build).
    if (statuses.get('5xx')) {
        console.error(`${statuses.get('5xx')} requests failed with a server error.`);
        process.exitCode = 1;
    }
})();
