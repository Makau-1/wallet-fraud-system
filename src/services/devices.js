// Devices (version 3).
//
// Each browser gets a long-lived random device cookie. The server stores
// only a hash of it, with a readable label such as "Chrome on Windows".
// Signing in from a device the account has not used before:
//   - tells the user straight away (a notification on their other devices)
//   - adds a "new device" risk signal to payments made from it during its
//     first 24 hours, the window in which a stolen password is usually used
// Users see their devices under Security and can sign out every other one.

const crypto = require('crypto');
const db = require('../config/db');
const events = require('./events');
const audit = require('./audit');

const COOKIE = 'sw_device';
const NEW_DEVICE_HOURS = 24;

function hash(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function readCookie(req, name) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) return decodeURIComponent(rest.join('='));
    }
    return null;
}

// A short description of the browser and operating system.
function label(userAgent = '') {
    const ua = String(userAgent);
    const browser = /Edg\//.test(ua) ? 'Edge'
        : /OPR\//.test(ua) ? 'Opera'
            : /Firefox\//.test(ua) ? 'Firefox'
                : /Chrome\//.test(ua) ? 'Chrome'
                    : /Safari\//.test(ua) ? 'Safari'
                        : /node|undici|curl|python/i.test(ua) ? 'Script' : 'Browser';
    const os = /Windows/.test(ua) ? 'Windows'
        : /Android/.test(ua) ? 'Android'
            : /iPhone|iPad|iOS/.test(ua) ? 'iOS'
                : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
                    : /Linux/.test(ua) ? 'Linux' : 'an unknown system';
    return `${browser} on ${os}`;
}

// Called after a successful sign-in, once the session holds the user.
async function onSignIn(req, res, user) {
    let token = readCookie(req, COOKIE);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
        token = crypto.randomBytes(32).toString('hex');
    }
    res.cookie(COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 2 * 365 * 24 * 60 * 60 * 1000,
    });
    const deviceHash = hash(token);
    const name = label(req.headers['user-agent']);

    const [[known]] = await db.execute('SELECT COUNT(*) AS n FROM user_devices WHERE user_id = ?', [user.id]);
    const [existing] = await db.execute(
        'SELECT id, first_seen, (first_seen >= DATE_SUB(NOW(), INTERVAL ? HOUR)) AS fresh FROM user_devices WHERE user_id = ? AND device_hash = ?',
        [NEW_DEVICE_HOURS, user.id, deviceHash]);

    let deviceId;
    let isNew = false;
    let fresh = false;
    if (existing.length) {
        deviceId = existing[0].id;
        fresh = Boolean(Number(existing[0].fresh));
        await db.execute('UPDATE user_devices SET last_seen = NOW(), last_ip = ?, session_id = ?, label = ? WHERE id = ?',
            [req.ip, req.sessionID, name, deviceId]);
    } else {
        const [created] = await db.execute(
            'INSERT INTO user_devices (user_id, device_hash, label, last_ip, session_id) VALUES (?, ?, ?, ?, ?)',
            [user.id, deviceHash, name, req.ip, req.sessionID]);
        deviceId = created.insertId;
        // The first device an account ever uses is not "new": it is the
        // one the account was created on.
        isNew = Number(known.n) > 0;
        fresh = isNew;
    }
    req.session.deviceId = deviceId;
    req.session.newDevice = fresh && Number(known.n) > 0;

    if (isNew) {
        events.notify(user.id, {
            kind: 'new_device',
            title: `New sign-in from ${name}`,
            body: 'If this was not you, freeze your account under Security and change your password.',
        });
        audit.record({ actorId: user.id, actorRole: user.role, ip: req.ip, action: 'auth.new_device',
            targetType: 'device', targetId: deviceId, details: { label: name } });
    }
    return { deviceId, isNew };
}

// The new-device flag lasts 24 hours from the device's first sign-in.
async function isNewDevice(req) {
    if (!req.session.newDevice || !req.session.deviceId) return false;
    const [rows] = await db.execute(
        'SELECT (first_seen >= DATE_SUB(NOW(), INTERVAL ? HOUR)) AS fresh FROM user_devices WHERE id = ?',
        [NEW_DEVICE_HOURS, req.session.deviceId]);
    const fresh = rows.length && Boolean(Number(rows[0].fresh));
    if (!fresh) req.session.newDevice = false;
    return fresh;
}

async function list(userId, currentDeviceId) {
    const [rows] = await db.execute(
        'SELECT id, label, first_seen, last_seen, last_ip FROM user_devices WHERE user_id = ? ORDER BY last_seen DESC',
        [userId]);
    return rows.map(r => ({ ...r, current: String(r.id) === String(currentDeviceId) }));
}

// Signs out every session on the user's other devices.
async function signOutOthers(req, store) {
    const [rows] = await db.execute(
        'SELECT id, session_id FROM user_devices WHERE user_id = ? AND id <> ? AND session_id IS NOT NULL',
        [req.session.userId, req.session.deviceId || 0]);
    await Promise.all(rows.map(r => new Promise(resolve => store.destroy(r.session_id, () => resolve()))));
    await db.execute('UPDATE user_devices SET session_id = NULL WHERE user_id = ? AND id <> ?',
        [req.session.userId, req.session.deviceId || 0]);
    await audit.record({ ...audit.actor(req), action: 'auth.sign_out_others', targetType: 'user', targetId: req.session.userId,
        details: { sessions: rows.length } });
    return rows.length;
}

module.exports = { onSignIn, isNewDevice, list, signOutOthers, label };
