// Money services: savings goals, loans, payments and money requests.
// Mounted at /api in server.js. Each route checks for a signed-in user
// itself, so other /api routes such as /api/status stay public.

const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const savings = require('../controllers/savingsController');
const loans = require('../controllers/loanController');
const payments = require('../controllers/paymentController');
const requests = require('../controllers/requestController');
const chamas = require('../controllers/chamaController');
const account = require('../controllers/accountController');
const mpesaController = require('../controllers/mpesaController');
const survey = require('../controllers/surveyController');
const { idempotency } = require('../middleware/idempotency');

const router = express.Router();
const auth = authMiddleware;

router.get('/savings', auth, savings.list);
router.post('/savings', auth, savings.create);
router.post('/savings/:id/deposit', auth, idempotency, savings.addMoney);
router.post('/savings/:id/withdraw', auth, idempotency, savings.withdraw);

router.get('/loans', auth, loans.summary);
router.post('/loans', auth, idempotency, loans.apply);
router.post('/loans/repay', auth, idempotency, loans.repay);

router.get('/payments/banks', auth, payments.banks);
router.post('/payments/bank', auth, idempotency, payments.bankTransfer);
router.post('/payments/bill', auth, idempotency, payments.pay);
router.get('/payments/purposes', auth, account.purposes);

router.get('/requests', auth, requests.list);
router.post('/requests', auth, requests.create);
router.post('/requests/:id/pay', auth, requests.markPaid);
router.post('/requests/:id/decline', auth, requests.decline);
router.post('/requests/:id/cancel', auth, requests.cancel);

// ---------- version 3 ----------

// The signed-in user's account
router.put('/me/phone', auth, account.setPhone);
router.put('/me/language', auth, account.setLanguage);
router.get('/me/devices', auth, account.listDevices);
router.post('/me/devices/sign-out-others', auth, account.signOutOthers);
router.post('/me/freeze', auth, account.freezeSelf);
router.get('/me/export', auth, account.exportData);
router.get('/notifications', auth, account.notifications);
router.post('/notifications/read', auth, account.markRead);

// Reports about other accounts
router.get('/reports/reasons', auth, account.reportReasons);
router.post('/reports', auth, account.reportAccount);

// Chamas (group savings)
router.get('/chamas', auth, chamas.list);
router.post('/chamas', auth, chamas.create);
router.get('/chamas/:id', auth, chamas.detail);
router.post('/chamas/:id/invite', auth, chamas.invite);
router.post('/chamas/:id/accept', auth, chamas.accept);
router.post('/chamas/:id/decline', auth, chamas.decline);
router.post('/chamas/:id/contribute', auth, idempotency, chamas.contribute);
router.post('/chamas/:id/payouts', auth, chamas.proposePayout);
router.post('/chamas/payouts/:payoutId/vote', auth, chamas.vote);

// M-Pesa deposits (STK push)
router.post('/mpesa/stk', auth, idempotency, mpesaController.start);
router.get('/mpesa/requests/:id', auth, mpesaController.status);
router.post('/mpesa/simulator/:id', auth, mpesaController.simulate);

// Usability survey
router.post('/survey/sus', auth, survey.submit);

module.exports = router;
