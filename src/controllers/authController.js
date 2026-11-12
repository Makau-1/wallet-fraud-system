const bcrypt = require('bcrypt');
const userModel = require('../models/userModel');
const db = require('../config/db');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

// ==================================================
// REGISTER
// Creates the user and their wallet in one database
// transaction, so a user never exists without a wallet.
// ==================================================

const register = async (req, res) => {
    let connection = null;

    try {
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = typeof req.body.password === 'string' ? req.body.password : '';

        if (!name || !email || !password) {
            return res.status(400).json({
                message: 'Name, email and password are required'
            });
        }

        if (name.length > 255) {
            return res.status(400).json({
                message: 'Name must be 255 characters or fewer'
            });
        }

        if (!EMAIL_PATTERN.test(email)) {
            return res.status(400).json({
                message: 'Enter a valid email address'
            });
        }

        if (password.length < MIN_PASSWORD_LENGTH) {
            return res.status(400).json({
                message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
            });
        }

        // Addresses in this domain belong to the attack lab, whose clean-up
        // deletes them, so nobody may register one.
        if (email.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').endsWith('@lab.securewallet')) {
            return res.status(400).json({
                message: 'That email address cannot be used'
            });
        }

        const existingUser = await userModel.findUserByEmail(email);

        if (existingUser) {
            return res.status(409).json({
                message: 'Email already registered'
            });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        connection = await db.getConnection();
        await connection.beginTransaction();

        const [userResult] = await connection.execute(
            'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
            [name, email, passwordHash]
        );

        await connection.execute(
            'INSERT INTO wallets (user_id, balance) VALUES (?, ?)',
            [userResult.insertId, 0]
        );

        await connection.commit();

        return res.status(201).json({
            id: userResult.insertId,
            name
        });

    } catch (error) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('Registration rollback error:', rollbackError.message);
            }
        }

        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({
                message: 'Email already registered'
            });
        }

        console.error('Registration error:', error.message);

        return res.status(500).json({
            message: 'Internal server error'
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
};

// ==================================================
// LOGIN
// ==================================================

const login = async (req, res) => {
    try {
        const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = typeof req.body.password === 'string' ? req.body.password : '';

        if (!email || !password) {
            return res.status(400).json({
                message: 'Email and password are required'
            });
        }

        const user = await userModel.findUserByEmail(email);

        // The same message is returned for an unknown email and a wrong
        // password, so the response does not reveal which accounts exist.
        if (!user) {
            return res.status(401).json({
                message: 'Invalid email or password'
            });
        }

        const passwordMatch = await bcrypt.compare(
            password,
            user.passwordHash
        );

        if (!passwordMatch) {
            return res.status(401).json({
                message: 'Invalid email or password'
            });
        }

        // Issue a fresh session ID at login to prevent session fixation.
        req.session.regenerate((sessionError) => {
            if (sessionError) {
                console.error('Session regenerate error:', sessionError.message);

                return res.status(500).json({
                    message: 'Internal server error'
                });
            }

            req.session.userId = user.id;
            req.session.role = user.role;

            return res.status(200).json({
                message: 'Login successful',
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    role: user.role
                }
            });
        });

    } catch (error) {
        console.error('Login error:', error.message);

        return res.status(500).json({
            message: 'Internal server error'
        });
    }
};

// ==================================================
// LOGOUT
// ==================================================

const logout = (req, res) => {
    if (!req.session) {
        return res.status(200).json({ message: 'Logged out' });
    }

    req.session.destroy((error) => {
        if (error) {
            console.error('Logout error:', error.message);

            return res.status(500).json({
                message: 'Could not log out'
            });
        }

        res.clearCookie('connect.sid');

        return res.status(200).json({ message: 'Logged out' });
    });
};

// ==================================================
// CURRENT USER
// Used by the pages to check who is signed in.
// ==================================================

const me = async (req, res) => {
    try {
        if (!req.session.userId) {
            return res.status(401).json({
                message: 'Authentication required'
            });
        }

        const [rows] = await db.execute(
            'SELECT id, name, email, role, (pin_hash IS NOT NULL) AS has_pin FROM users WHERE id = ? LIMIT 1',
            [req.session.userId]
        );

        if (rows.length === 0) {
            return res.status(401).json({
                message: 'Authentication required'
            });
        }

        const { has_pin: hasPin, ...user } = rows[0];
        return res.status(200).json({ user: { ...user, hasPin: Boolean(Number(hasPin)) } });

    } catch (error) {
        console.error('Current user error:', error.message);

        return res.status(500).json({
            message: 'Internal server error'
        });
    }
};

// ==================================================
// TRANSACTION PIN
// A 4-digit PIN used to confirm payments the risk engine
// finds unusual. Setting or changing it needs the account
// password, so a stolen session alone cannot set a new PIN.
// The PIN is stored only as a bcrypt hash.
// ==================================================

const setPin = async (req, res) => {
    try {
        if (!req.session.userId) {
            return res.status(401).json({ message: 'Authentication required' });
        }

        const { password, pin, currentPin } = req.body;

        if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
            return res.status(400).json({ message: 'The PIN must be exactly 4 digits' });
        }
        if (/^(\d)\1{3}$/.test(pin) || pin === '1234') {
            return res.status(400).json({ message: 'Choose a PIN that is harder to guess' });
        }

        const [rows] = await db.execute(
            `SELECT password_hash, pin_hash,
                    (pin_locked_until IS NOT NULL AND pin_locked_until > NOW()) AS pin_locked
             FROM users WHERE id = ? LIMIT 1`,
            [req.session.userId]
        );
        const passwordMatch = rows.length > 0 && typeof password === 'string'
            && await bcrypt.compare(password, rows[0].password_hash);
        if (!passwordMatch) {
            return res.status(403).json({ message: 'Your account password is incorrect' });
        }

        // Changing an existing PIN also needs the current PIN. Otherwise
        // someone who had learned the password could simply replace the
        // PIN, and it would protect nothing. A locked PIN cannot be changed.
        if (rows[0].pin_hash) {
            if (Number(rows[0].pin_locked)) {
                return res.status(423).json({ message: 'The PIN is locked after too many wrong attempts. Try again in 15 minutes.' });
            }
            const currentMatch = typeof currentPin === 'string' && /^\d{4}$/.test(currentPin)
                && await bcrypt.compare(currentPin, rows[0].pin_hash);
            if (!currentMatch) {
                return res.status(403).json({ message: 'Your current PIN is incorrect' });
            }
        }

        const pinHash = await bcrypt.hash(pin, 10);
        await db.execute(
            'UPDATE users SET pin_hash = ?, pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?',
            [pinHash, req.session.userId]
        );

        return res.status(200).json({ message: 'Transaction PIN saved' });

    } catch (error) {
        console.error('Set PIN error:', error.message);

        return res.status(500).json({ message: 'Internal server error' });
    }
};

module.exports = {
    register,
    login,
    logout,
    me,
    setPin
};
