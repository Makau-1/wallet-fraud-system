// Two-factor sign-in with time-based one-time codes (version 3).
//
// Standard TOTP (RFC 6238): a shared secret and the current 30-second time
// step give a 6-digit code, which any authenticator app (Google
// Authenticator, Microsoft Authenticator, Authy) can produce. Codes from
// one step either side are accepted to allow for clock drift, and a code
// cannot be used twice.
//
// The secret is stored encrypted (AES-256-GCM) with a key taken from
// TOTP_ENCRYPTION_KEY, or derived from SESSION_SECRET if that is not set.

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;

function base32Encode(buffer) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
    return out;
}

function base32Decode(text) {
    const clean = String(text).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of clean) {
        const index = ALPHABET.indexOf(ch);
        if (index < 0) throw new Error('Invalid base32 secret');
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

function generateSecret() {
    return base32Encode(crypto.randomBytes(20));
}

function codeAt(secret, step) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
    const offset = hmac[hmac.length - 1] & 15;
    const binary = ((hmac[offset] & 127) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
    return String(binary % 1000000).padStart(6, '0');
}

function currentStep(at = Date.now()) {
    return Math.floor(at / 1000 / STEP);
}

// Returns the matching time step, or null. Rejects steps at or before
// lastStep, so a code that has been used cannot be replayed.
function verify(secret, code, lastStep = null) {
    if (!/^\d{6}$/.test(String(code || ''))) return null;
    const now = currentStep();
    for (const step of [now - 1, now, now + 1]) {
        if (lastStep !== null && step <= Number(lastStep)) continue;
        const expected = Buffer.from(codeAt(secret, step));
        const given = Buffer.from(String(code));
        if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) return step;
    }
    return null;
}

function uri(secret, email) {
    const label = encodeURIComponent(`SecureWallet:${email}`);
    return `otpauth://totp/${label}?secret=${secret}&issuer=SecureWallet&algorithm=SHA1&digits=6&period=${STEP}`;
}

function key() {
    const source = process.env.TOTP_ENCRYPTION_KEY || process.env.SESSION_SECRET || 'securewallet-development-only';
    return crypto.createHash('sha256').update(`totp:${source}`).digest();
}

function encrypt(secret) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

function decrypt(stored) {
    const [version, iv, tag, data] = String(stored).split(':');
    if (version !== 'v1') throw new Error('Unknown secret format');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { generateSecret, codeAt, currentStep, verify, uri, encrypt, decrypt, base32Encode, base32Decode };
