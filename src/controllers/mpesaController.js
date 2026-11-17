// M-Pesa deposits (version 3). See services/mpesa.js.

const mpesa = require('../services/mpesa');
const { ServiceError, handle } = require('../services/ledger');

const start = handle('Mpesa', async (req, res) => {
    res.status(201).json(await mpesa.start(req.session.userId, { amount: req.body.amount, phone: req.body.phone }));
});

const status = handle('Mpesa', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ServiceError(400, 'Invalid request');
    res.json(await mpesa.status(req.session.userId, id));
});

const simulate = handle('Mpesa', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ServiceError(400, 'Invalid request');
    await mpesa.simulate(req.session.userId, id, req.body.action);
    res.json(await mpesa.status(req.session.userId, id));
});

// Safaricom calls this. It is public, protected by the secret token in
// the path, and always answers quickly with ResultCode 0 so Safaricom
// does not retry; what was done is recorded on the request.
async function callback(req, res) {
    if (!mpesa.tokenMatches(req.params.token)) return res.status(404).json({ message: 'Not found' });
    try {
        await mpesa.processCallback(req.body);
    } catch (error) {
        console.error('[Mpesa] Callback error:', error.message);
    }
    return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
}

module.exports = { start, status, simulate, callback };
