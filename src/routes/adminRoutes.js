
const express = require('express');
const router = express.Router();

const adminMiddleware = require('../middleware/adminMiddleware');
const fraudAlertController = require('../controllers/fraudAlertController');

router.get(
    '/fraud-alerts',
    adminMiddleware,
    fraudAlertController.getFraudAlerts
);

router.patch(
    '/fraud-alerts/:id/status',
    adminMiddleware,
    fraudAlertController.updateFraudAlertStatus
);

module.exports = router;
