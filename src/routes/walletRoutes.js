const express = require('express');
const walletController = require('../controllers/walletController');
const account = require('../controllers/accountController');
const authMiddleware = require('../middleware/authMiddleware');
const { idempotency } = require('../middleware/idempotency');

const router = express.Router();
const auth = authMiddleware;

router.get('/balance', auth, walletController.getBalance);

// Money-moving requests accept an Idempotency-Key header (version 3).
router.post('/deposit', auth, idempotency, walletController.deposit);
router.post('/withdraw', auth, idempotency, walletController.withdraw);
router.post('/transfer', auth, idempotency, walletController.transfer);

router.get('/history', auth, walletController.getHistory);
router.get('/recipient', auth, walletController.lookupRecipient);

// "This wasn't me", and cancelling a payment that is cooling off (version 3)
router.post('/transactions/:id/dispute', auth, account.dispute);
router.post('/transactions/:id/cancel', auth, account.cancelPayment);

module.exports = router;
