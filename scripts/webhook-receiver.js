// A webhook receiver for fraud API clients, showing how to check the
// SecureWallet-Signature header. Run it, point the client's webhook URL at
// it, and send a test event from the admin "Fraud API clients" page.
//
//   WEBHOOK_SECRET=whsec_... node scripts/webhook-receiver.js 4000
//
// In Windows PowerShell:
//   $env:WEBHOOK_SECRET = "whsec_..."; node scripts/webhook-receiver.js 4000
//
// The signature is t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">.
// Reject a mismatch, and a timestamp more than five minutes old (replay).

const crypto = require('crypto');
const http = require('http');

const secret = process.env.WEBHOOK_SECRET;
const port = Number(process.argv[2] || 4000);
if (!secret) {
    console.error('Set WEBHOOK_SECRET to the client\'s webhook secret.');
    process.exit(1);
}

function verify(header, body) {
    const parts = Object.fromEntries(String(header || '').split(',').map(p => p.split('=')));
    if (!parts.t || !parts.v1) return 'missing signature';
    if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return 'timestamp too old';
    const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${body}`).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(parts.v1);
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? null : 'signature does not match';
}

http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        const problem = verify(req.headers['securewallet-signature'], body);
        if (problem) {
            console.log(`Rejected ${req.headers['securewallet-event']}: ${problem}`);
            res.writeHead(400);
            return res.end(problem);
        }
        const event = JSON.parse(body);
        console.log(`Verified ${event.type} ${event.id}:`, JSON.stringify(event.data).slice(0, 200));
        res.writeHead(200);
        return res.end('ok');
    });
}).listen(port, () => console.log(`Listening on http://localhost:${port}`));
