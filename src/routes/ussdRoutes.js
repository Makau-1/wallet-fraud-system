// USSD (version 3).
//   POST /api/ussd/callback/:token   Africa's Talking posts here (form data)
//   POST /api/ussd/simulate           the in-app phone simulator (USSD_SIMULATOR=1);
//                                     signed-in users only, as their own phone
// The callback token (USSD_CALLBACK_TOKEN) keeps anyone else from posting
// to the real callback; every money action also needs the user's PIN.

const crypto = require('crypto');
const express = require('express');
const db = require('../config/db');
const ussd = require('../services/ussd');

const router = express.Router();

function tokenMatches(given) {
    const expected = process.env.USSD_CALLBACK_TOKEN;
    if (!expected) return false;
    const a = Buffer.from(String(given || ''));
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function reply(res, body) {
    try {
        const text = await ussd.handle({ phoneNumber: body.phoneNumber, text: body.text });
        res.type('text/plain').send(text);
    } catch (error) {
        console.error('[USSD]', error.message);
        res.type('text/plain').send('END Service unavailable. Try again later.');
    }
}

router.post('/callback/:token', express.urlencoded({ extended: false, limit: '10kb' }), (req, res) => {
    if (!tokenMatches(req.params.token)) return res.status(404).type('text/plain').send('END Not found');
    return reply(res, req.body);
});

// The simulator always dials from the signed-in user's own linked number,
// so it cannot be used to look up other people's names or guess their PINs.
router.post('/simulate', async (req, res) => {
    if (process.env.USSD_SIMULATOR !== '1') {
        return res.status(404).json({ message: 'The USSD simulator is switched off. Set USSD_SIMULATOR=1 in .env.' });
    }
    if (!req.session || !req.session.userId) {
        return res.status(401).type('text/plain').send('END Sign in to use the simulator.');
    }
    try {
        const [rows] = await db.execute('SELECT phone FROM users WHERE id = ?', [req.session.userId]);
        const phone = rows.length ? rows[0].phone : null;
        if (!phone) return res.type('text/plain').send('END Link a phone number under Security first.');
        return reply(res, { phoneNumber: phone, text: (req.body || {}).text });
    } catch (error) {
        console.error('[USSD]', error.message);
        return res.type('text/plain').send('END Service unavailable. Try again later.');
    }
});

router.get('/simulator-phone', async (req, res) => {
    if (!req.session || !req.session.userId) return res.status(401).json({ message: 'Sign in first.' });
    const [rows] = await db.execute('SELECT phone FROM users WHERE id = ?', [req.session.userId]);
    return res.json({ phone: rows.length ? rows[0].phone : null });
});

router.get('/simulator-status', (req, res) => res.json({ enabled: process.env.USSD_SIMULATOR === '1' }));

module.exports = router;
