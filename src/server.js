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

const app = express();

// Middleware
app.use(express.json());

app.use(cors({
    origin: true,
    credentials: true
}));

// Serve frontend files from src/public
app.use(express.static(path.join(__dirname, 'public')));

// Session configuration
if (!process.env.SESSION_SECRET) {
    console.error('SESSION_SECRET is not set in .env. Sessions will not work.');
}

app.use(
    session({
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: 'lax',
            secure: false
        }
    })
);

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/test', testRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin', adminRoutes);

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

    statusCache = { ...status, checked_at: new Date().toISOString() };
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

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});