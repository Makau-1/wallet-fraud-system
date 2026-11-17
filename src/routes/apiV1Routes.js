// Public fraud API, version 1. Mounted at /api/v1.
// Authenticated with API keys (Authorization: Bearer swk_...), not
// sessions. The specification is served at /api/v1/openapi.json and
// described for people at /developers.html.

const express = require('express');
const fraudApi = require('../services/fraudApi');
const openapi = require('../services/openapi');

const router = express.Router();

function wrap(fn) {
    return async (req, res) => {
        try {
            await fn(req, res);
        } catch (error) {
            if (error.status) return res.status(error.status).json({ error: 'invalid_request', message: error.message });
            console.error('[FraudAPI]', error);
            return res.status(500).json({ error: 'server_error', message: 'Something went wrong' });
        }
    };
}

router.get('/openapi.json', (req, res) => res.json(openapi.spec(req)));

router.post('/assess', fraudApi.authenticate, wrap(async (req, res) => {
    const { replay, assessment } = await fraudApi.assess(req.apiClient, req.body || {});
    if (replay) res.set('Idempotent-Replayed', 'true');
    res.status(replay ? 200 : 201).json(assessment);
}));

router.get('/assessments/:id', fraudApi.authenticate, wrap(async (req, res) => {
    const row = await fraudApi.find(req.apiClient.id, req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found', message: 'Assessment not found' });
    return res.json(fraudApi.present(row));
}));

router.post('/assessments/:id/outcome', fraudApi.authenticate, wrap(async (req, res) => {
    res.json(await fraudApi.setOutcome(req.apiClient.id, req.params.id, req.body.status));
}));

router.post('/assessments/:id/feedback', fraudApi.authenticate, wrap(async (req, res) => {
    res.json(await fraudApi.setLabel(req.apiClient.id, req.params.id, req.body.label));
}));

router.get('/usage', fraudApi.authenticate, wrap(async (req, res) => {
    res.json({ client: req.apiClient.name, ...(await fraudApi.usage(req.apiClient.id)) });
}));

module.exports = router;
