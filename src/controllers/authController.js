const bcrypt = require('bcrypt');
const userModel = require('../models/userModel');
const db = require('../config/db');
const devices = require('../services/devices');
const totp = require('../services/totp');
const audit = require('../services/audit');
const payments = require('../services/payments');

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

        const [[security]] = await db.execute(
            'SELECT totp_enabled FROM users WHERE id = ?', [user.id]);

        // With two-factor sign-in on, the password only starts the sign-in:
        // the session waits for a code from the authenticator app (202).
        if (Number(security.totp_enabled)) {
            return req.session.regenerate((sessionError) => {
                if (sessionError) {
                    console.error('Session regenerate error:', sessionError.message);
                    return res.status(500).json({ message: 'Internal server error' });
                }
                req.session.pendingMfa = { userId: user.id, role: user.role, attempts: 0, at: Date.now() };
                return res.status(202).json({ message: 'Enter the code from your authenticator app', mfaRequired: true });
            });
        }

        return completeSignIn(req, res, user, { mfa: false });

    } catch (error) {
        console.error('Login error:', error.message);

        return res.status(500).json({
            message: 'Internal server error'
        });
    }
};

// Finishes a sign-in: a fresh session ID (prevents session fixation), the
// device check, and an audit record.
function completeSignIn(req, res, user, { mfa }) {
    req.session.regenerate(async (sessionError) => {
        if (sessionError) {
            console.error('Session regenerate error:', sessionError.message);
            return res.status(500).json({ message: 'Internal server error' });
        }
        req.session.userId = user.id;
        req.session.role = user.role;
        req.session.mfaVerified = Boolean(mfa);
        let device = { isNew: false };
        try {
            device = await devices.onSignIn(req, res, user);
        } catch (error) {
            console.error('Device check error:', error.message);
        }
        await audit.record({ actorId: user.id, actorRole: user.role, ip: req.ip, action: 'auth.login',
            targetType: 'user', targetId: user.id, details: { mfa: Boolean(mfa), newDevice: device.isNew } });
        req.session.save(() => res.status(200).json({
            message: 'Login successful',
            user: { id: user.id, name: user.name, email: user.email, role: user.role },
            newDevice: device.isNew,
        }));
    });
}

// ==================================================
// SECOND STEP OF A TWO-FACTOR SIGN-IN
// Five wrong codes end the attempt; the sign-in must start again. Across
// sign-ins, an account gets at most ten wrong codes in 15 minutes.
// Attempts are counted in this process before anything is awaited, so
// requests sent in parallel cannot all see a count of zero.
// ==================================================

const MFA_WINDOW = 15 * 60 * 1000;
const mfaAttempts = new Map(); // "<user id>:<sign-in time>" -> attempts this sign-in
const mfaFailures = new Map(); // user id -> times of recent wrong codes

function recentMfaFailures(userId, now) {
    const list = (mfaFailures.get(userId) || []).filter(t => now - t < MFA_WINDOW);
    if (list.length) mfaFailures.set(userId, list); else mfaFailures.delete(userId);
    return list;
}

const verifyMfa = async (req, res) => {
    const pending = req.session.pendingMfa;
    if (!pending || Date.now() - pending.at > 5 * 60 * 1000) {
        delete req.session.pendingMfa;
        return res.status(401).json({ message: 'Your sign-in has expired. Sign in again.' });
    }
    const now = Date.now();
    const key = `${pending.userId}:${pending.at}`;
    const attempt = (mfaAttempts.get(key) || 0) + 1;
    mfaAttempts.set(key, attempt);
    if (mfaAttempts.size > 5000) mfaAttempts.delete(mfaAttempts.keys().next().value);
    if (attempt > 5 || recentMfaFailures(pending.userId, now).length >= 10) {
        delete req.session.pendingMfa;
        return res.status(429).json({ message: 'Too many wrong codes. Wait 15 minutes, then sign in again.' });
    }
    try {
        const [rows] = await db.execute(
            'SELECT id, name, email, role, totp_secret, totp_last_step FROM users WHERE id = ?', [pending.userId]);
        if (!rows.length) return res.status(401).json({ message: 'Sign in again.' });
        const user = rows[0];
        const step = totp.verify(totp.decrypt(user.totp_secret), req.body.code, user.totp_last_step);
        if (step === null) {
            const failures = recentMfaFailures(user.id, now);
            failures.push(now);
            mfaFailures.set(user.id, failures);
            audit.record({ actorId: user.id, actorRole: user.role, ip: req.ip, action: 'auth.mfa_failed', targetType: 'user', targetId: user.id });
            return res.status(401).json({ message: `That code is not right. ${Math.max(0, 5 - attempt)} attempts left.` });
        }
        // The step is stored only if it is newer than the last one used, so
        // two parallel requests with the same code cannot both sign in.
        const [updated] = await db.execute(
            'UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)', [step, user.id, step]);
        if (!updated.affectedRows) return res.status(401).json({ message: 'That code has already been used. Wait for the next one.' });
        mfaAttempts.delete(key);
        return completeSignIn(req, res, user, { mfa: true });
    } catch (error) {
        console.error('MFA error:', error.message);
        return res.status(500).json({ message: 'Internal server error' });
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
            `SELECT id, name, email, role, phone, language, frozen_at, frozen_reason, totp_enabled,
                    (pin_hash IS NOT NULL) AS has_pin FROM users WHERE id = ? LIMIT 1`,
            [req.session.userId]
        );

        if (rows.length === 0) {
            return res.status(401).json({
                message: 'Authentication required'
            });
        }

        const { has_pin: hasPin, totp_enabled: totpEnabled, frozen_at: frozenAt, frozen_reason: frozenReason, ...user } = rows[0];
        const adminNeeds2fa = user.role === 'admin' && process.env.ADMIN_2FA === 'required' && !Number(totpEnabled);
        return res.status(200).json({
            user: {
                ...user,
                hasPin: Boolean(Number(hasPin)),
                totpEnabled: Boolean(Number(totpEnabled)),
                frozen: Boolean(frozenAt),
                frozenReason: frozenReason || null,
                newDevice: Boolean(req.session.newDevice),
                mustSetUp2fa: adminNeeds2fa,
            },
        });

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
            // Checked the same way as a payment's PIN, so wrong guesses here
            // count towards the same lock.
            try {
                await payments.checkPinFor(req.session.userId, typeof currentPin === 'string' ? currentPin : '');
            } catch (error) {
                if (error.status) {
                    return res.status(error.status).json({ message: error.status === 403 ? `Your current PIN is incorrect. ${error.message.replace(/^Incorrect PIN\. /, '')}` : error.message });
                }
                throw error;
            }
        }

        const pinHash = await bcrypt.hash(pin, 10);
        await db.execute(
            'UPDATE users SET pin_hash = ?, pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?',
            [pinHash, req.session.userId]
        );
        await audit.record({ ...audit.actor(req), action: rows[0].pin_hash ? 'pin.change' : 'pin.set',
            targetType: 'user', targetId: req.session.userId });

        return res.status(200).json({ message: 'Transaction PIN saved' });

    } catch (error) {
        console.error('Set PIN error:', error.message);

        return res.status(500).json({ message: 'Internal server error' });
    }
};

module.exports = {
    register,
    login,
    verifyMfa,
    logout,
    me,
    setPin
};
