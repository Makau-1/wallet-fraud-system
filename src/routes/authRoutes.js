const express = require('express');
const authController = require('../controllers/authController');
const account = require('../controllers/accountController');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/mfa', authController.verifyMfa);
router.post('/logout', authController.logout);
router.get('/me', authController.me);
router.post('/pin', authController.setPin);

// Two-factor sign-in (version 3)
router.post('/2fa/setup', authMiddleware, account.setup2fa);
router.post('/2fa/enable', authMiddleware, account.enable2fa);
router.post('/2fa/disable', authMiddleware, account.disable2fa);

module.exports = router;
