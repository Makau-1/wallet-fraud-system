// Administrator routes. Version 3: with ADMIN_2FA=required (the production
// setting), an administrator must have two-factor sign-in turned on and
// must have used it to sign in; until then only the set-up endpoints work.

const db = require('../config/db');

const adminMiddleware = async (req, res, next) => {
    if (!req.session.userId) {
        return res.status(401).json({
            message: 'Authentication required'
        });
    }

    if (req.session.role !== 'admin') {
        return res.status(403).json({
            message: 'Administrator access required'
        });
    }

    if (process.env.ADMIN_2FA === 'required' && !req.session.mfaVerified) {
        try {
            const [rows] = await db.execute('SELECT totp_enabled FROM users WHERE id = ?', [req.session.userId]);
            const enabled = rows.length && Number(rows[0].totp_enabled);
            return res.status(403).json({
                message: enabled
                    ? 'Sign in again with your authenticator code'
                    : 'Turn on two-factor sign-in before using the administrator tools',
                setup2fa: !enabled,
            });
        } catch (error) {
            return res.status(500).json({ message: 'Internal server error' });
        }
    }

    next();
};

module.exports = adminMiddleware;
