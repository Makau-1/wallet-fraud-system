// Express server entry point

const express = require('express');
const cors = require('cors');
const session = require('express-session');
require('dotenv').config();

const db = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const testRoutes = require('./routes/testRoutes');

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

app.use(
    session({
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false
    })
);

// Authentication routes
app.use('/api/auth', authRoutes);
app.use('/api/test', testRoutes);
// Test route
app.get('/', (req, res) => {
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});