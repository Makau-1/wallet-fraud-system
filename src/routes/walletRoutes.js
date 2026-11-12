const express = require('express');
const walletController = require('../controllers/walletController');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/balance', authMiddleware, walletController.getBalance);

router.post('/deposit', authMiddleware, walletController.deposit);

router.post('/withdraw', authMiddleware, walletController.withdraw);

router.post('/transfer', authMiddleware, walletController.transfer);

router.get('/history', authMiddleware, walletController.getHistory);

router.get('/recipient', authMiddleware, walletController.lookupRecipient);

module.exports = router;