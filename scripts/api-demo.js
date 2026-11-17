// Plays a fraud API client: sends a customer's normal payments, then an
// account takeover that empties the account to a stranger, and prints each
// decision with its reasons. A flagged payment also sends a signed
// webhook if the client has a webhook URL (see webhook-receiver.js).
//
//   SECUREWALLET_KEY=swk_live_... node scripts/api-demo.js [http://localhost:3000]
//
// In Windows PowerShell:
//   $env:SECUREWALLET_KEY = "swk_live_..."; node scripts/api-demo.js

const base = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
const key = process.env.SECUREWALLET_KEY;
if (!key) {
    console.error('Set SECUREWALLET_KEY to an API key from the admin "Fraud API clients" page.');
    process.exit(1);
}
const run = Date.now().toString(36);

async function assess(body) {
    const response = await fetch(`${base}/api/v1/assess`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return response.json();
}

(async () => {
    const customer = `demo_${run}`;
    let balance = 20000;
    const steps = [
        ['Rent to the usual landlord', { counterparty_id: 'landlord', amount: 1500 }],
        ['Groceries', { counterparty_id: 'grocer', amount: 600 }],
        ['School fees', { counterparty_id: 'school', amount: 1200 }],
        ['Groceries again', { counterparty_id: 'grocer', amount: 700 }],
        ['Electricity', { counterparty_id: 'kplc', amount: 900 }],
        ['Takeover: the whole balance to a stranger', { counterparty_id: `stranger_${run}`, amount: null }],
    ];
    for (const [label, step] of steps) {
        const payment = { ...step, amount: step.amount ?? balance };
        const result = await assess({ type: 'TRANSFER', account_id: customer, account_balance: balance, counterparty_balance: 0, ...payment });
        console.log(`${label.padEnd(46)} ${String(result.decision).toUpperCase().padEnd(10)} risk ${result.risk}  ${(result.reasons || []).join('; ')}`);
        if (result.decision === 'allow') balance -= payment.amount;
    }
})();
