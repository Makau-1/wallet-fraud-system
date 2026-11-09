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