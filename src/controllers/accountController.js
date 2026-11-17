// The signed-in user's own account (version 3): profile settings, devices,
// two-factor sign-in, freezing the account, notifications, disputes,
// reports and a copy of their data.

const bcrypt = require('bcrypt');
const QRCode = require('qrcode');
const db = require('../config/db');
const sessionStore = require('../config/sessionStore');
const devices = require('../services/devices');
const totp = require('../services/totp');
const audit = require('../services/audit');
const protection = require('../services/protection');
const payments = require('../services/payments');
const { ServiceError, handle } = require('../services/ledger');

// Kenyan mobile numbers in any common form, stored as 2547XXXXXXXX or
// 2541XXXXXXXX.
function normalisePhone(raw) {
    const digits = String(raw || '').replace(/[\s()-]/g, '').replace(/^\+/, '');
    let phone = digits;
    if (/^0[17]\d{8}$/.test(digits)) phone = `254${digits.slice(1)}`;
    else if (/^[17]\d{8}$/.test(digits)) phone = `254${digits}`;
    return /^254[17]\d{8}$/.test(phone) ? phone : null;
}

async function checkPassword(userId, password) {
    const [rows] = await db.execute('SELECT password_hash FROM users WHERE id = ?', [userId]);
    return rows.length > 0 && typeof password === 'string' && bcrypt.compare(password, rows[0].password_hash);
}

const setPhone = handle('Account', async (req, res) => {
    const phone = normalisePhone(req.body.phone);
    if (!phone) throw new ServiceError(400, 'Enter a Kenyan mobile number such as 0712345678');
    if (!await checkPassword(req.session.userId, req.body.password)) {
        throw new ServiceError(403, 'Your account password is incorrect');
    }
    try {
        await db.execute('UPDATE users SET phone = ? WHERE id = ?', [phone, req.session.userId]);
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') throw new ServiceError(409, 'That number is already linked to another account');
        throw error;
    }
    await audit.record({ ...audit.actor(req), action: 'profile.phone', targetType: 'user', targetId: req.session.userId });
    res.json({ phone });
});

const setLanguage = handle('Account', async (req, res) => {
    const language = req.body.language === 'sw' ? 'sw' : req.body.language === 'en' ? 'en' : null;
    if (!language) throw new ServiceError(400, 'Language must be en or sw');
    await db.execute('UPDATE users SET language = ? WHERE id = ?', [language, req.session.userId]);
    res.json({ language });
});

const listDevices = handle('Account', async (req, res) => {
    res.json({ devices: await devices.list(req.session.userId, req.session.deviceId) });
});

const signOutOthers = handle('Account', async (req, res) => {
    res.json({ signedOut: await devices.signOutOthers(req, sessionStore) });
});

const freezeSelf = handle('Account', async (req, res) => {
    const reason = typeof req.body.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim().slice(0, 200) : 'Frozen by the account holder';
    res.json(await protection.freeze(req.session.userId, reason, req));
});

// ---------- notifications ----------

const notifications = handle('Account', async (req, res) => {
    const [rows] = await db.execute(
        'SELECT id, kind, title, body, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30',
        [req.session.userId]);
    const [[unread]] = await db.execute(
        'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [req.session.userId]);
    res.json({ notifications: rows, unread: Number(unread.n) });
});

const markRead = handle('Account', async (req, res) => {
    await db.execute('UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL', [req.session.userId]);
    res.json({ unread: 0 });
});

// ---------- payments: purposes, disputes, cancelling, reports ----------

const purposes = (req, res) => res.json({ purposes: payments.PURPOSES.map(({ key, label, risky }) => ({ key, label, risky: Boolean(risky) })) });

const dispute = handle('Account', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ServiceError(400, 'Invalid payment');
    res.status(201).json(await protection.openDispute(req.session.userId, id, req.body.reason, req));
});

const cancelPayment = handle('Account', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ServiceError(400, 'Invalid payment');
    await payments.cancelCoolingOff(req.session.userId, id);
    res.json({ cancelled: true });
});

const reportReasons = (req, res) => res.json({ reasons: Object.entries(protection.REPORT_REASONS).map(([key, label]) => ({ key, label })) });

const reportAccount = handle('Account', async (req, res) => {
    res.status(201).json(await protection.report(req.session.userId, req.body));
});

// ---------- two-factor sign-in ----------

const setup2fa = handle('Account', async (req, res) => {
    const [rows] = await db.execute('SELECT email, totp_enabled FROM users WHERE id = ?', [req.session.userId]);
    if (Number(rows[0].totp_enabled)) throw new ServiceError(409, 'Two-factor sign-in is already on');
    const secret = totp.generateSecret();
    req.session.pendingTotpSecret = secret;
    const uri = totp.uri(secret, rows[0].email);
    const svg = await QRCode.toString(uri, { type: 'svg', margin: 1, color: { dark: '#201e1fff', light: '#ffffffff' } });
    res.json({ secret, uri, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` });
});

const enable2fa = handle('Account', async (req, res) => {
    const secret = req.session.pendingTotpSecret;
    if (!secret) throw new ServiceError(409, 'Start the set-up again');
    // The password is asked for, so someone holding only a stolen session
    // cannot turn two-step sign-in on with their own app and lock the
    // owner out.
    if (!await checkPassword(req.session.userId, req.body.password)) throw new ServiceError(403, 'Your account password is incorrect');
    const step = totp.verify(secret, req.body.code);
    if (step === null) throw new ServiceError(400, 'That code is not right. Check the time on your phone and try again.');
    await db.execute('UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_last_step = ? WHERE id = ?',
        [totp.encrypt(secret), step, req.session.userId]);
    delete req.session.pendingTotpSecret;
    req.session.mfaVerified = true;
    await audit.record({ ...audit.actor(req), action: '2fa.enable', targetType: 'user', targetId: req.session.userId });
    res.json({ totpEnabled: true });
});

const disable2fa = handle('Account', async (req, res) => {
    if (process.env.ADMIN_2FA === 'required' && req.session.role === 'admin') {
        throw new ServiceError(403, 'Administrators must keep two-factor sign-in on');
    }
    if (!await checkPassword(req.session.userId, req.body.password)) throw new ServiceError(403, 'Your account password is incorrect');
    const [rows] = await db.execute('SELECT totp_secret, totp_last_step FROM users WHERE id = ? AND totp_enabled = 1', [req.session.userId]);
    if (!rows.length) throw new ServiceError(409, 'Two-factor sign-in is not on');
    if (totp.verify(totp.decrypt(rows[0].totp_secret), req.body.code, rows[0].totp_last_step) === null) {
        throw new ServiceError(400, 'That code is not right');
    }
    await db.execute('UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_last_step = NULL WHERE id = ?', [req.session.userId]);
    await audit.record({ ...audit.actor(req), action: '2fa.disable', targetType: 'user', targetId: req.session.userId });
    res.json({ totpEnabled: false });
});

// ---------- a copy of the user's data ----------
// The Kenya Data Protection Act, 2019 gives people the right to access the
// personal data held about them. This returns it as one JSON file. Other
// users' reports about this account are summarised as a count, so the
// people who reported it are not identified.

const exportData = handle('Account', async (req, res) => {
    const userId = req.session.userId;
    const [[profile]] = await db.execute(
        'SELECT id, name, email, phone, language, role, created_at, frozen_at, frozen_reason, (pin_hash IS NOT NULL) AS has_pin, totp_enabled FROM users WHERE id = ?',
        [userId]);
    const [[wallet]] = await db.execute('SELECT id, balance, currency, created_at FROM wallets WHERE user_id = ?', [userId]);
    const [transactions] = await db.execute(
        `SELECT t.id, t.amount, t.currency, t.status, t.created_at,
                JSON_UNQUOTE(JSON_EXTRACT(t.metadata, '$.type')) AS type,
                IF(t.sender_wallet_id = ?, 'out', 'in') AS direction
         FROM transactions t WHERE t.sender_wallet_id = ? OR (t.receiver_wallet_id = ? AND t.status = 'completed')
         ORDER BY t.id`, [wallet.id, wallet.id, wallet.id]);
    const [deviceRows] = await db.execute('SELECT label, first_seen, last_seen, last_ip FROM user_devices WHERE user_id = ?', [userId]);
    const [notes] = await db.execute('SELECT kind, title, body, created_at, read_at FROM notifications WHERE user_id = ?', [userId]);
    const [savings] = await db.execute('SELECT name, target_amount, balance, locked_until, status, created_at FROM savings_vaults WHERE wallet_id = ?', [wallet.id]);
    const [loans] = await db.execute('SELECT principal, fee, amount_due, amount_repaid, status, due_date, created_at FROM loans WHERE wallet_id = ?', [wallet.id]);
    const [myReports] = await db.execute(
        'SELECT u.email AS reported_account, r.reason, r.created_at FROM recipient_reports r JOIN users u ON u.id = r.reported_id WHERE r.reporter_id = ?', [userId]);
    const [[aboutMe]] = await db.execute('SELECT COUNT(*) AS n FROM recipient_reports WHERE reported_id = ?', [userId]);
    const [myDisputes] = await db.execute('SELECT transaction_id, reason, status, created_at, decided_at FROM disputes WHERE user_id = ?', [userId]);
    const [chamas] = await db.execute(
        'SELECT c.name, m.role, m.status, m.joined_at FROM chama_members m JOIN chamas c ON c.id = m.chama_id WHERE m.user_id = ?', [userId]);

    await audit.record({ ...audit.actor(req), action: 'privacy.export', targetType: 'user', targetId: userId });
    res.set('Content-Disposition', `attachment; filename="securewallet-my-data-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({
        exported_at: new Date().toISOString(),
        note: 'Your personal data held by SecureWallet, a simulated wallet. Passwords and PINs are stored only as one-way hashes, and the two-step sign-in secret is stored encrypted; none of them is included.',
        profile: { ...profile, has_pin: Boolean(Number(profile.has_pin)), totp_enabled: Boolean(Number(profile.totp_enabled)) },
        wallet, transactions, savings, loans, chamas, devices: deviceRows, notifications: notes,
        reports_you_made: myReports, reports_about_you: Number(aboutMe.n), disputes: myDisputes,
    });
});

module.exports = {
    normalisePhone, setPhone, setLanguage, listDevices, signOutOthers, freezeSelf, notifications, markRead,
    purposes, dispute, cancelPayment, reportReasons, reportAccount, setup2fa, enable2fa, disable2fa, exportData,
};
