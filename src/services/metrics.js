// Latency monitoring (version 3).
//
// Records how long each API route, each call to the scoring model and each
// payment takes, and counts responses by status. The admin System page
// shows the median, 95th and 99th percentiles over the last 15 minutes, and
// GET /metrics publishes the same figures in the Prometheus text format for
// an external monitoring tool.
//
// Samples are kept in memory (the last 2,000 per series), so the figures
// describe this process since it started.

const MAX_SAMPLES = 2000;
const series = new Map();   // name -> [{ at, ms }]
const counters = new Map(); // name -> number
const startedAt = Date.now();

function observe(name, ms) {
    if (!series.has(name)) series.set(name, []);
    const list = series.get(name);
    list.push({ at: Date.now(), ms });
    if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES);
}

function count(name, by = 1) {
    counters.set(name, (counters.get(name) || 0) + by);
}

function percentile(sorted, p) {
    if (!sorted.length) return null;
    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, index)];
}

function summarise(windowMs = 15 * 60 * 1000) {
    const since = Date.now() - windowMs;
    const out = [];
    series.forEach((list, name) => {
        const values = list.filter(s => s.at >= since).map(s => s.ms).sort((a, b) => a - b);
        if (!values.length) return;
        const total = values.reduce((a, b) => a + b, 0);
        out.push({
            name,
            count: values.length,
            mean: Math.round((total / values.length) * 10) / 10,
            p50: percentile(values, 50),
            p95: percentile(values, 95),
            p99: percentile(values, 99),
            max: values[values.length - 1],
        });
    });
    out.sort((a, b) => b.count - a.count);
    return out;
}

// Times every API request, grouped by route pattern so that /alerts/1 and
// /alerts/2 count as one route.
function middleware(req, res, next) {
    if (!req.path.startsWith('/api') && req.path !== '/metrics') return next();
    const start = process.hrtime.bigint();
    res.on('finish', () => {
        if (req.path === '/api/events') return;
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        const route = req.route ? `${req.baseUrl}${req.route.path}` : req.baseUrl || req.path.split('/').slice(0, 3).join('/');
        observe(`${req.method} ${route}`, Math.round(ms * 10) / 10);
        count(`http_responses_${Math.floor(res.statusCode / 100)}xx`);
    });
    next();
}

function snapshot() {
    return {
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        memoryMb: Math.round(process.memoryUsage().rss / 1048576),
        counters: Object.fromEntries(counters),
        series: summarise(),
    };
}

// Prometheus text exposition format.
function prometheus(extra = {}) {
    const lines = [];
    const clean = name => name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').toLowerCase();
    lines.push('# TYPE securewallet_uptime_seconds gauge');
    lines.push(`securewallet_uptime_seconds ${Math.round((Date.now() - startedAt) / 1000)}`);
    counters.forEach((value, name) => {
        lines.push(`# TYPE securewallet_${clean(name)}_total counter`);
        lines.push(`securewallet_${clean(name)}_total ${value}`);
    });
    lines.push('# TYPE securewallet_latency_ms summary');
    summarise().forEach(s => {
        const label = `series="${s.name.replace(/"/g, "'")}"`;
        lines.push(`securewallet_latency_ms{${label},quantile="0.5"} ${s.p50}`);
        lines.push(`securewallet_latency_ms{${label},quantile="0.95"} ${s.p95}`);
        lines.push(`securewallet_latency_ms{${label},quantile="0.99"} ${s.p99}`);
        lines.push(`securewallet_latency_ms_count{${label}} ${s.count}`);
    });
    Object.entries(extra).forEach(([name, value]) => {
        lines.push(`# TYPE securewallet_${clean(name)} gauge`);
        lines.push(`securewallet_${clean(name)} ${Number(value) || 0}`);
    });
    return lines.join('\n') + '\n';
}

module.exports = { observe, count, middleware, snapshot, prometheus, summarise };
