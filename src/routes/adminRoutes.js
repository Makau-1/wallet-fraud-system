
const express = require('express');
const router = express.Router();

const adminMiddleware = require('../middleware/adminMiddleware');
const fraudAlertController = require('../controllers/fraudAlertController');
const attackLab = require('../services/attackLab');
const riskEngine = require('../services/riskEngine');
const { handle } = require('../services/ledger');

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

// Attack lab: scripted fraud scenarios run against the live system.
// Switched off unless ATTACK_LAB=1 is set in .env.
router.get('/lab', adminMiddleware, (req, res) => {
    res.json({ enabled: attackLab.enabled(), mode: riskEngine.mode(), scenarios: attackLab.SCENARIOS });
});

router.post('/lab/run', adminMiddleware, handle('AttackLab', async (req, res) => {
    res.json(await attackLab.run(req.body.scenario));
}));

router.post('/lab/cleanup', adminMiddleware, handle('AttackLab', async (req, res) => {
    res.json({ removed: await attackLab.cleanup() });
}));

module.exports = router;
