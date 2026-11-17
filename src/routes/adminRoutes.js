const express = require('express');
const router = express.Router();

const adminMiddleware = require('../middleware/adminMiddleware');
const fraudAlertController = require('../controllers/fraudAlertController');
const platform = require('../controllers/platformController');
const attackLab = require('../services/attackLab');
const riskEngine = require('../services/riskEngine');
const { handle } = require('../services/ledger');

const admin = adminMiddleware;

// ---------- fraud review (versions 1 to 3) ----------
router.get('/fraud-alerts', admin, fraudAlertController.getFraudAlerts);
router.patch('/fraud-alerts/:id/status', admin, fraudAlertController.updateFraudAlertStatus);
router.post('/fraud-alerts/:id/proposal/reject', admin, fraudAlertController.rejectProposal);
router.get('/fraud-alerts/:id/notes', admin, fraudAlertController.listNotes);
router.post('/fraud-alerts/:id/notes', admin, fraudAlertController.addNote);
router.post('/fraud-alerts/:id/assign', admin, fraudAlertController.assign);

// ---------- version 3 ----------
router.get('/overview', admin, platform.overview);

router.get('/disputes', admin, platform.listDisputes);
router.post('/disputes/:id/decide', admin, platform.decideDispute);
router.post('/disputes/:id/proposal/reject', admin, platform.rejectDisputeProposal);
router.get('/reports', admin, platform.reported);
router.post('/users/:id/freeze', admin, platform.freezeUser);
router.post('/users/:id/restore', admin, platform.restoreUser);

router.get('/network', admin, platform.network);
router.get('/network/findings', admin, platform.networkFindings);

router.get('/models', admin, platform.models);
router.get('/models/drift', admin, platform.drift);
router.post('/models/retrain', admin, platform.retrain);
router.post('/models/promote', admin, platform.modelChange('promote'));
router.post('/models/rollback', admin, platform.modelChange('rollback'));
router.post('/models/discard', admin, platform.modelChange('discard'));

router.get('/ledger', admin, platform.ledger);
router.post('/ledger/reconcile', admin, platform.reconcileNow);
router.get('/ledger/accounts/:account', admin, platform.accountLines);

router.get('/audit', admin, platform.auditLog);
router.post('/audit/verify', admin, platform.verifyAudit);

router.get('/system', admin, platform.system);

router.get('/api-clients', admin, platform.apiClients);
router.post('/api-clients', admin, platform.createApiClient);
router.patch('/api-clients/:id', admin, platform.updateApiClient);
router.post('/api-clients/:id/keys', admin, platform.createKey);
router.delete('/api-clients/:id/keys/:keyId', admin, platform.revokeKey);
router.post('/api-clients/:id/webhook/rotate', admin, platform.rotateSecret);
router.post('/api-clients/:id/webhook/test', admin, platform.testWebhook);
router.get('/api-clients/:id/deliveries', admin, platform.deliveries);

router.get('/survey', admin, platform.surveyResults);

// Attack lab: scripted fraud scenarios run against the live system.
// Switched off unless ATTACK_LAB=1 is set in .env.
router.get('/lab', admin, (req, res) => {
    res.json({ enabled: attackLab.enabled(), mode: riskEngine.mode(), scenarios: attackLab.SCENARIOS });
});

router.post('/lab/run', admin, handle('AttackLab', async (req, res) => {
    res.json(await attackLab.run(req.body.scenario));
}));

router.post('/lab/run-all', admin, platform.labRunAll);

router.post('/lab/cleanup', admin, handle('AttackLab', async (req, res) => {
    res.json({ removed: await attackLab.cleanup() });
}));

module.exports = router;
