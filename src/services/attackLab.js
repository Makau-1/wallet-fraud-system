// Attack lab (version 2).
//
// Runs scripted fraud scenarios against the live system and reports what
// the risk engine did with each step. Every payment in a scenario goes
// through the same payment service as a real user's payment, so the lab
// tests the real detection path rather than a copy of it.
//
// The lab creates its own accounts, with email addresses ending in
// @lab.securewallet, gives them a balance and a backdated payment history,
// and can remove them all again. It is switched off unless ATTACK_LAB=1 is
// set in .env, and only an administrator can use it.

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../config/db');
const payments = require('./payments');
const riskEngine = require('./riskEngine');
const journal = require('./journal');
const audit = require('./audit');
const { ServiceError, withTransaction } = require('./ledger');

const DOMAIN = '@lab.securewallet';

function enabled() {
    return process.env.ATTACK_LAB === '1';
}

const SCENARIOS = [
    { id: 'takeover', title: 'Account takeover', attack: true,
      description: 'A user with a steady history of small payments suddenly sends the whole balance to someone they have never paid.' },
    { id: 'velocity', title: 'Rapid draining', attack: true,
      description: 'An attacker empties an account in a burst of small transfers, each one too small to look unusual on its own.' },
    { id: 'mule_chain', title: 'Money mule chain', attack: true,
      description: 'Stolen money is passed through two mule accounts within minutes and then cashed out.' },
    { id: 'fan_in', title: 'Collector account', attack: true,
      description: 'Several accounts pay the same new account within minutes, which then withdraws the lot.' },
    { id: 'round_trip', title: 'Round-trip transfers', attack: true,
      description: 'Two accounts pass the same money back and forth to inflate their activity.' },
    { id: 'scam_victim', title: 'Phone scam victim', attack: true,
      description: 'A caller talks a user into sending most of their savings to a stranger, coaching them to say it is for an investment.' },
    { id: 'reported_mule', title: 'Reported mule account', attack: true,
      description: 'Several users report an account after being cheated; then another user tries to pay it.' },
    { id: 'new_device_takeover', title: 'Takeover from a new device', attack: true,
      description: 'Someone signs in from a device the account has never used and sends money to a stranger in small amounts.' },
    { id: 'normal', title: 'Normal behaviour', attack: false,
      description: 'A user makes ordinary payments to people they pay regularly. Nothing here should be flagged; anything that is counts as a false positive.' },
];

// ---------- lab accounts ----------

async function createAccount(run, name, balance) {
    const email = `${name.toLowerCase().replace(/\s+/g, '.')}.${run}${DOMAIN}`;
    // The password is random and never returned: lab accounts cannot be signed in to.
    const passwordHash = await bcrypt.hash(crypto.randomBytes(18).toString('hex'), 4);
    return withTransaction(async (connection) => {
        const [user] = await connection.execute(
            "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'user')",
            [name, email, passwordHash]
        );
        const [wallet] = await connection.execute('INSERT INTO wallets (user_id, balance) VALUES (?, ?)', [user.insertId, balance]);
        // The starting balance comes from the lab's own funding account, so
        // the journal stays balanced.
        await journal.post(connection, {
            kind: 'lab_funding',
            memo: `Attack lab account ${email}`,
            lines: [[journal.account.external('lab'), -balance], [journal.account.wallet(wallet.insertId), balance]],
        });
        return { userId: user.insertId, walletId: wallet.insertId, name, email };
    });
}

// Gives an account a past: completed payments dated days ago, so the risk
// engine has a "usual" pattern to compare against.
async function seedHistory(from, payees, amounts) {
    for (let i = 0; i < amounts.length; i += 1) {
        const to = payees[i % payees.length];
        await db.execute(
            `INSERT INTO transactions
                (amount, sender_wallet_id, receiver_wallet_id, status, metadata, scoring_status, created_at)
             VALUES (?, ?, ?, 'completed', ?, 'unscored', DATE_SUB(NOW(), INTERVAL ? DAY))`,
            [amounts[i], from.walletId, to.walletId, JSON.stringify({ type: 'transfer', seeded: true }), amounts.length - i + 1]
        );
    }
}

// ---------- running a step ----------

async function step(trace, { label, actor, kind, amount, to, expect, purpose, context }) {
    // If an earlier step was stopped, this account may hold less than the
    // script planned. The attacker would move whatever arrived, so the step
    // is run with what is there; if next to nothing arrived, the earlier
    // stop has already prevented this step.
    const cutOff = trace.some(s => s.detected && !s.moved);
    if (cutOff) {
        const [rows] = await db.execute('SELECT balance FROM wallets WHERE id = ?', [actor.walletId]);
        const available = Number(rows[0].balance);
        if (available < amount) {
            if (available < amount * 0.2) {
                trace.push({
                    label, actor: actor.name, kind, amount, to: to ? to.name : null, expect,
                    outcome: 'prevented', risk: null, tier: null, moved: false, detected: true,
                    reasons: ['An earlier step was stopped, so the money never reached this account'],
                });
                return trace[trace.length - 1];
            }
            amount = available;
            label += ' (only what got through)';
        }
    }
    const entry = { label, actor: actor.name, kind, amount, to: to ? to.name : null, expect };
    try {
        const result = await payments.execute({
            userId: actor.userId,
            kind,
            amount,
            recipientEmail: to ? to.email : undefined,
            // An attacker who is asked what a payment is for gives an
            // innocent answer; only the coached scam victim answers truthfully.
            purpose: purpose || 'family_friends',
            context: { ...(context || {}), channel: 'lab' },
            details: kind === 'bank_transfer' ? { bank: 'KCB Bank', account_masked: '••••0000' } : {},
        });
        const risk = result.risk || {};
        Object.assign(entry, {
            outcome: risk.action || 'unscored',
            risk: risk.score ?? null,
            modelScore: risk.model_score ?? null,
            tier: risk.tier || null,
            reasons: risk.reasons || [],
            transactionId: result.transactionId,
            moved: !result.held && !result.coolingOff,
        });
        if (result.coolingOff) entry.outcome = 'cooling_off';
    } catch (error) {
        if (error instanceof payments.PurposeChallenge) {
            // The attacker's script did not expect the question, so the
            // payment stops here.
            Object.assign(entry, { outcome: 'purpose_asked', risk: null, tier: null, reasons: ['Asked what the payment is for'], moved: false });
        } else if (error instanceof payments.Challenge) {
            // The attacker does not know the PIN, so the payment stops here.
            Object.assign(entry, {
                outcome: 'challenged',
                risk: error.risk.score,
                modelScore: error.risk.model_score ?? null,
                tier: error.risk.tier,
                reasons: error.risk.reasons,
                moved: false,
            });
        } else if (error instanceof ServiceError) {
            Object.assign(entry, { outcome: 'not_run', risk: null, tier: null, reasons: [error.message], moved: false });
        } else {
            throw error;
        }
    }
    // Anything other than a plain pass counts as the engine reacting.
    entry.detected = ['flagged', 'challenged', 'held', 'cooling_off', 'purpose_asked'].includes(entry.outcome);
    trace.push(entry);
    return entry;
}

// ---------- scenarios ----------

const RUNNERS = {
    async takeover(run, trace) {
        const victim = await createAccount(run, 'Victim Wanjiru', 25000);
        const friend = await createAccount(run, 'Friend Otieno', 500);
        const shop = await createAccount(run, 'Corner Shop', 3000);
        const attacker = await createAccount(run, 'Attacker X', 0);
        await seedHistory(victim, [friend, shop], [300, 450, 250, 600, 350, 400, 500, 300]);
        await step(trace, { label: 'A usual payment to a known shop', actor: victim, kind: 'transfer', amount: 400, to: shop, expect: 'pass' });
        await step(trace, { label: 'Takeover: the whole balance to a stranger', actor: victim, kind: 'transfer', amount: 24600, to: attacker, expect: 'detect' });
    },

    async velocity(run, trace) {
        const victim = await createAccount(run, 'Victim Kamau', 12000);
        const friend = await createAccount(run, 'Friend Achieng', 800);
        const attacker = await createAccount(run, 'Attacker Y', 0);
        await seedHistory(victim, [friend], [900, 1100, 800, 1000, 950, 1050]);
        for (let i = 1; i <= 7; i += 1) {
            await step(trace, {
                label: `Burst transfer ${i} of 7`, actor: victim, kind: 'transfer', amount: 950, to: attacker,
                expect: i >= 4 ? 'detect' : 'either',
            });
        }
    },

    async mule_chain(run, trace) {
        const victim = await createAccount(run, 'Victim Njeri', 18000);
        const mule1 = await createAccount(run, 'Mule One', 200);
        const mule2 = await createAccount(run, 'Mule Two', 150);
        await step(trace, { label: 'Stolen funds sent to the first mule', actor: victim, kind: 'transfer', amount: 15000, to: mule1, expect: 'either' });
        await step(trace, { label: 'First mule passes the money on', actor: mule1, kind: 'transfer', amount: 14500, to: mule2, expect: 'detect' });
        await step(trace, { label: 'Second mule cashes out', actor: mule2, kind: 'withdrawal', amount: 14200, expect: 'detect' });
    },

    async fan_in(run, trace) {
        const collector = await createAccount(run, 'Collector Z', 100);
        const payers = [];
        for (const name of ['Payer Ali', 'Payer Beth', 'Payer Chege', 'Payer Dida']) {
            payers.push(await createAccount(run, name, 9000));
        }
        for (let i = 0; i < payers.length; i += 1) {
            await step(trace, {
                label: `Payer ${i + 1} of 4 pays the collector`, actor: payers[i], kind: 'transfer', amount: 2000, to: collector,
                expect: i === 3 ? 'detect' : 'either',
            });
        }
        await step(trace, { label: 'Collector sends everything to a bank', actor: collector, kind: 'bank_transfer', amount: 7900, expect: 'detect' });
    },

    async round_trip(run, trace) {
        const a = await createAccount(run, 'Account Alpha', 6000);
        const b = await createAccount(run, 'Account Bravo', 6000);
        await seedHistory(a, [b], [200, 300]);
        await seedHistory(b, [a], [250, 200]);
        await step(trace, { label: 'Alpha sends 5,000 to Bravo', actor: a, kind: 'transfer', amount: 5000, to: b, expect: 'either' });
        await step(trace, { label: 'Bravo sends 5,000 straight back', actor: b, kind: 'transfer', amount: 5000, to: a, expect: 'detect' });
        await step(trace, { label: 'Alpha sends it again', actor: a, kind: 'transfer', amount: 5000, to: b, expect: 'detect' });
    },

    async scam_victim(run, trace) {
        const victim = await createAccount(run, 'Victim Akinyi', 40000);
        const grocer = await createAccount(run, 'Mama Mboga', 2000);
        const scammer = await createAccount(run, 'Fake Broker', 0);
        await seedHistory(victim, [grocer], [600, 800, 750, 900, 650, 700]);
        await step(trace, { label: 'Usual shopping payment', actor: victim, kind: 'transfer', amount: 700, to: grocer, expect: 'pass' });
        await step(trace, { label: 'Coached "investment" payment to a stranger', actor: victim, kind: 'transfer', amount: 30000, to: scammer,
            purpose: 'investment', expect: 'detect' });
    },

    async reported_mule(run, trace) {
        const mule = await createAccount(run, 'Quick Loans Agent', 500);
        const reporters = [];
        for (const name of ['Cheated Wambui', 'Cheated Kiprop', 'Cheated Halima']) {
            const r = await createAccount(run, name, 5000);
            await seedHistory(r, [mule], [1500]);
            reporters.push(r);
        }
        for (const r of reporters) {
            await db.execute("INSERT INTO recipient_reports (reporter_id, reported_id, reason) VALUES (?, ?, 'scam')", [r.userId, mule.userId]);
        }
        const next = await createAccount(run, 'Next Target Onyango', 8000);
        const friend = await createAccount(run, 'Friend Nduta', 1000);
        await seedHistory(next, [friend, mule], [400, 500, 450, 600, 500]);
        await step(trace, { label: 'A usual payment to a friend', actor: next, kind: 'transfer', amount: 450, to: friend, expect: 'pass' });
        await step(trace, { label: 'Payment to the account three users reported', actor: next, kind: 'transfer', amount: 2500, to: mule, expect: 'detect' });
    },

    async new_device_takeover(run, trace) {
        const victim = await createAccount(run, 'Victim Mutua', 9000);
        const sister = await createAccount(run, 'Sister Mutua', 1500);
        const attacker = await createAccount(run, 'Attacker Z', 0);
        await seedHistory(victim, [sister], [800, 1200, 900, 1000, 1100, 950]);
        await step(trace, { label: 'Usual payment from the usual phone', actor: victim, kind: 'transfer', amount: 1000, to: sister, expect: 'pass' });
        for (let i = 1; i <= 4; i += 1) {
            await step(trace, { label: `New device: transfer ${i} of 4 to a stranger`, actor: victim, kind: 'transfer', amount: 900, to: attacker,
                context: { newDevice: true }, expect: i >= 2 ? 'detect' : 'either' });
        }
    },

    async normal(run, trace) {
        const user = await createAccount(run, 'Regular Mwende', 30000);
        const landlord = await createAccount(run, 'Landlord Ltd', 50000);
        const friend = await createAccount(run, 'Friend Baraka', 2000);
        await seedHistory(user, [landlord, friend], [1500, 600, 1500, 800, 1500, 700, 1500, 650]);
        await step(trace, { label: 'Rent to the usual landlord', actor: user, kind: 'transfer', amount: 1500, to: landlord, expect: 'pass' });
        await step(trace, { label: 'A usual amount to a friend', actor: user, kind: 'transfer', amount: 700, to: friend, expect: 'pass' });
        await step(trace, { label: 'A small cash withdrawal', actor: user, kind: 'withdrawal', amount: 1000, expect: 'pass' });
    },
};

async function run(scenarioId) {
    if (!enabled()) throw new ServiceError(403, 'The attack lab is switched off. Set ATTACK_LAB=1 in .env and restart the server.');
    const scenario = SCENARIOS.find(s => s.id === scenarioId);
    if (!scenario) throw new ServiceError(400, 'Unknown scenario');

    const runId = Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
    const trace = [];
    await RUNNERS[scenario.id](runId, trace);

    const mustDetect = trace.filter(s => s.expect === 'detect');
    const mustPass = trace.filter(s => s.expect === 'pass');
    return {
        scenario: { id: scenario.id, title: scenario.title, attack: scenario.attack },
        mode: riskEngine.mode(),
        steps: trace,
        summary: {
            attackSteps: mustDetect.length,
            detected: mustDetect.filter(s => s.detected).length,
            // What version 1 would have caught: the model score on its own.
            modelAlone: mustDetect.filter(s => s.modelScore !== null && s.modelScore !== undefined
                && s.modelScore >= riskEngine.ALERT_THRESHOLD).length,
            normalSteps: mustPass.length,
            falsePositives: mustPass.filter(s => s.detected).length,
            // In enforce mode, how much of the attempted money was stopped.
            attempted: mustDetect.reduce((sum, s) => sum + s.amount, 0),
            stopped: mustDetect.filter(s => s.detected && !s.moved).reduce((sum, s) => sum + s.amount, 0),
        },
    };
}

// Runs every scenario and returns one evaluation table: for each, how many
// attack steps the engine caught compared with the model on its own, and
// how many ordinary steps it wrongly flagged.
async function runAll(req) {
    if (!enabled()) throw new ServiceError(403, 'The attack lab is switched off. Set ATTACK_LAB=1 in .env and restart the server.');
    const results = [];
    for (const scenario of SCENARIOS) {
        results.push(await run(scenario.id));
    }
    const keys = ['attackSteps', 'detected', 'modelAlone', 'normalSteps', 'falsePositives', 'attempted', 'stopped'];
    const total = Object.fromEntries(keys.map(k => [k, results.reduce((sum, r) => sum + r.summary[k], 0)]));
    if (req) await audit.record({ ...audit.actor(req), action: 'lab.run_all', targetType: 'lab', details: total });
    return {
        mode: riskEngine.mode(),
        ranAt: new Date().toISOString(),
        rows: results.map(r => ({ scenario: r.scenario, summary: r.summary })),
        total,
        results,
    };
}

// Removes every lab account with its transactions and alerts. Whatever
// the accounts still hold is moved out in the journal first, so the books
// stay balanced after the accounts are gone.
async function cleanup() {
    const [wallets] = await db.query(
        `SELECT w.id FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.email LIKE ?`, ['%' + DOMAIN]
    );
    const ids = wallets.map(w => w.id);
    if (ids.length) {
        await withTransaction(async (connection) => {
            await require('./payments').refundHeldToClosing(connection, ids);
            return journal.closeAccounts(connection, { walletIds: ids }, 'Attack lab clean-up');
        });
        await db.query(
            `DELETE fa FROM fraud_alerts fa JOIN transactions t ON t.id = fa.transaction_id
             WHERE t.sender_wallet_id IN (?) OR t.receiver_wallet_id IN (?)`, [ids, ids]);
        await db.query('DELETE FROM transactions WHERE sender_wallet_id IN (?) OR receiver_wallet_id IN (?)', [ids, ids]);
    }
    const [result] = await db.query('DELETE FROM users WHERE email LIKE ?', ['%' + DOMAIN]);
    return result.affectedRows;
}

module.exports = { enabled, SCENARIOS, run, runAll, cleanup };
