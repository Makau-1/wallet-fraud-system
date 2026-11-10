// Money services: savings goals, loans, payments and money requests.
// Mounted at /api in server.js. Each route checks for a signed-in user
// itself, so other /api routes such as /api/status stay public.

const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const savings = require('../controllers/savingsController');
const loans = require('../controllers/loanController');
const payments = require('../controllers/paymentController');
const requests = require('../controllers/requestController');

const router = express.Router();
const auth = authMiddleware;

router.get('/savings', auth, savings.list);
router.post('/savings', auth, savings.create);
router.post('/savings/:id/deposit', auth, savings.addMoney);
router.post('/savings/:id/withdraw', auth, savings.withdraw);

router.get('/loans', auth, loans.summary);
router.post('/loans', auth, loans.apply);
router.post('/loans/repay', auth, loans.repay);

router.get('/payments/banks', auth, payments.banks);
router.post('/payments/bank', auth, payments.bankTransfer);
router.post('/payments/bill', auth, payments.pay);

router.get('/requests', auth, requests.list);
router.post('/requests', auth, requests.create);
router.post('/requests/:id/pay', auth, requests.markPaid);
router.post('/requests/:id/decline', auth, requests.decline);
router.post('/requests/:id/cancel', auth, requests.cancel);

module.exports = router;
