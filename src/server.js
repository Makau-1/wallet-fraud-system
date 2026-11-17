// Express server entry point

const express = require('express');
const path = require('path');
const cors = require('cors');
const session = require('express-session');
require('dotenv').config();

const db = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const testRoutes = require('./routes/testRoutes');
const walletRoutes = require('./routes/walletRoutes');
const adminRoutes = require('./routes/adminRoutes');
const servicesRoutes = require('./routes/servicesRoutes');
const riskEngine = require('./services/riskEngine');
const attackLab = require('./services/attackLab');
const apiV1Routes = require('./routes/apiV1Routes');
const ussdRoutes = require('./routes/ussdRoutes');
const sessionStore = require('./config/sessionStore');
const authMiddleware = require('./middleware/authMiddleware');
const mpesaController = require('./controllers/mpesaController');
const journal = require('./services/journal');
const reconcile = require('./services/reconcile');
const metrics = require('./services/metrics');
const events = require('./services/events');
const payments = require('./services/payments');
const scoringQueue = require('./services/scoringQueue');
const webhooks = require('./services/webhooks');
const mpesa = require('./services/mpesa');
const { purgeExpired } = require('./middleware/idempotency');

const app = express();
app.disable('x-powered-by');
const PRODUCTION = process.env.NODE_ENV === 'production';

// Behind a reverse proxy (Caddy in docker-compose.prod.yml) the client's
// address and the HTTPS scheme arrive in forwarded headers.
if (PRODUCTION) app.set('trust proxy', 1);

// Response times for the System page and /metrics (version 3).
app.use(metrics.middleware);

// Security headers on every response.
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'");
    if (PRODUCTION) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
});

// Middleware
app.use(express.json({ limit: '50kb' }));
// A request with no JSON body still gets an empty object to read from.
app.use((req, res, next) => { if (!req.body || typeof req.body !== 'object') req.body = {}; next(); });

// The interface is served from this server, so no other origin needs
// access. CORS_ORIGIN can list trusted origins if one is ever needed.
const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map(o => o.trim()).filter(Boolean);
app.use(cors({
    origin: allowedOrigins.length ? allowedOrigins : false,
    credentials: true
}));

// Limits failed sign-in attempts in a 15-minute window: 10 for each
// address and email, and 40 for each address across all emails. A
// successful sign-in clears the count for that email.
const LOGIN_WINDOW = 15 * 60 * 1000;
const loginAttempts = new Map();

function recentAttempts(key, now) {
    const recent = (loginAttempts.get(key) || []).filter(time => now - time < LOGIN_WINDOW);
    if (recent.length) loginAttempts.set(key, recent);
    else loginAttempts.delete(key);
    return recent;
}

function noteAttempt(key, now) {
    const recent = recentAttempts(key, now);
    recent.push(now);
    // Re-insert so the map stays ordered by last use; the oldest go first
    // when it grows too large.
    loginAttempts.delete(key);
    loginAttempts.set(key, recent);
    while (loginAttempts.size > 5000) loginAttempts.delete(loginAttempts.keys().next().value);
}

app.use('/api/auth/login', (req, res, next) => {
    if (req.method !== 'POST') return next();
    // The database compares email addresses without regard to case or
    // accents, so the key is reduced the same way.
    const email = typeof req.body.email === 'string'
        ? req.body.email.trim().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        : '';
    const emailKey = `${req.ip}|${email}`;
    const addressKey = `${req.ip}|*`;
    const now = Date.now();
    if (recentAttempts(emailKey, now).length >= 10 || recentAttempts(addressKey, now).length >= 40) {
        return res.status(429).json({ message: 'Too many sign-in attempts. Try again in 15 minutes.' });
    }
    noteAttempt(emailKey, now);
    noteAttempt(addressKey, now);
    res.on('finish', () => {
        if (res.statusCode !== 200) return;
        // Only failures count: take this attempt back off both counts.
        loginAttempts.delete(emailKey);
        const shared = loginAttempts.get(addressKey);
        if (shared) shared.pop();
    });
    next();
});

// Serve frontend files from src/public
app.use(express.static(path.join(__dirname, 'public')));

// Session configuration
if (!process.env.SESSION_SECRET) {
    console.error('SESSION_SECRET is not set in .env. Sessions will not work.');
}

app.use(
    session({
        secret: process.env.SESSION_SECRET,
        store: sessionStore,
        resave: false,
        saveUninitialized: false,
        // Signed out after two hours without activity.
        rolling: true,
        cookie: {
            httpOnly: true,
            sameSite: 'lax',
            secure: PRODUCTION,
            maxAge: 2 * 60 * 60 * 1000
        }
    })
);

// Public fraud API (API keys, not sessions) and Safaricom's M-Pesa callback
// (version 3).
app.use('/api/v1', apiV1Routes);
app.post('/api/mpesa/callback/:token', mpesaController.callback);
app.use('/api/ussd', ussdRoutes);

// Live updates for the signed-in user (version 3).
app.get('/api/events', authMiddleware, events.stream);

// Prometheus metrics: an administrator's session, or the bearer token in
// METRICS_TOKEN for a monitoring tool.
app.get('/metrics', async (req, res) => {
    const token = process.env.METRICS_TOKEN;
    const bearer = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!(req.session.role === 'admin' || (token && bearer === token))) {
        return res.status(401).type('text/plain').send('Unauthorised\n');
    }
    let backlog = 0;
    try { backlog = await scoringQueue.backlog(); } catch (error) { backlog = -1; }
    return res.type('text/plain; version=0.0.4').send(metrics.prometheus({
        unscored_backlog: backlog,
        sse_streams: events.connectionCount().streams,
    }));
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/test', testRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', servicesRoutes);

// API health-check route
app.get('/api', (req, res) => {
    res.json({
        message: 'Wallet Fraud System API is running'
    });
});

// Service status shown on the console panels of the interface.
// Reports only whether each part is reachable, never any data.
// Cached for 10 seconds so repeated page loads do not hit the database
// and the scoring service on every request.
let statusCache = null;
let statusCachedAt = 0;

app.get('/api/status', async (req, res) => {
    if (statusCache && Date.now() - statusCachedAt < 10000) {
        return res.json(statusCache);
    }

    const mlUrl = (process.env.ML_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
    const status = { wallet: 'operational', database: 'down', scoring: 'unavailable' };

    try {
        await Promise.race([
            db.query('SELECT 1'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
        ]);
        status.database = 'operational';
    } catch (error) {
        status.wallet = 'degraded';
    }

    try {
        const response = await fetch(`${mlUrl}/health`, { signal: AbortSignal.timeout(1500) });
        if (response.ok) status.scoring = 'operational';
    } catch (error) {
        // Left as unavailable: transfers still complete and are marked unscored.
    }

    statusCache = {
        ...status,
        riskMode: riskEngine.mode(),
        attackLab: attackLab.enabled(),
        mpesaMode: mpesa.mode(),
        ussdSimulator: process.env.USSD_SIMULATOR === '1',
        checked_at: new Date().toISOString(),
    };
    statusCachedAt = Date.now();
    res.json(statusCache);
});

// Test MySQL connection
db.query('SELECT 1')
    .then(() => {
        console.log('MySQL database connected successfully');
    })
    .catch((error) => {
        console.error('MySQL connection failed:', error.message);
    });

// Background work (version 3), all in this process.
function startWorkers() {
    scoringQueue.start();
    webhooks.start();
    const every = (ms, fn, name) => {
        const timer = setInterval(() => fn().catch(error => console.error(`[${name}]`, error.message)), ms);
        timer.unref();
    };
    every(15000, payments.releaseDueCoolingOff, 'CoolingOff');
    every(30000, mpesa.expireStale, 'Mpesa');
    every(60 * 60 * 1000, purgeExpired, 'Idempotency');
    reconcile.schedule(result => events.toAdmins('reconciliation.finished', { id: result.id, ok: result.ok }));
}

// Start server. The journal records any balances that existed before it
// was introduced before the first request is accepted.
const PORT = process.env.PORT || 3000;

journal.ensureOpened()
    .then((opened) => {
        if (opened.opened) console.log(`Journal opened with the balances of ${opened.accounts} accounts`);
    })
    .catch((error) => {
        console.error('Journal not ready:', error.message, '- run node scripts/migrate.js');
    })
    .finally(() => {
        if (process.env.NO_WORKERS !== '1') startWorkers();
        app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    });

module.exports = app;