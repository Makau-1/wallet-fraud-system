// Risk engine (version 2).
//
// The machine learning model scores one transaction from its amount and
// balances. That is not enough on its own in a live wallet: the model's
// strongest feature, balance_discrepancy, is always zero here because the
// ledger is consistent, and the model knows nothing about how a user
// normally behaves or how money is moving between accounts.
//
// This engine adds that context. It reads behavioural and network signals
// from the wallet's own transaction history, combines them with the model
// score into one risk score, and maps the score to a response tier.
//
//   risk = 1 - (1 - model score) x (1 - w1) x (1 - w2) ...
//
// Each signal can only raise the risk, the result stays between 0 and 1,
// and every contributing signal is recorded with the transaction so the
// analyst sees exactly why it was raised.

const db = require('../config/db');
const { scoreTransaction } = require('./fraudService');

const ALERT_THRESHOLD = 0.5;   // at or above: challenge (or flag in advisory mode)
const HOLD_THRESHOLD = 0.8;    // at or above: hold for review

// advisory: flagged transactions complete and are reviewed afterwards (v1).
// enforce:  the tier decides: allow, challenge with the PIN, or hold.
function mode() {
    return process.env.RISK_MODE === 'enforce' ? 'enforce' : 'advisory';
}

function tierFor(risk) {
    if (risk === null || risk < ALERT_THRESHOLD) return 'allow';
    return risk >= HOLD_THRESHOLD ? 'hold' : 'challenge';
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const SCORED_TYPES = "('transfer', 'withdrawal', 'bank_transfer')";
const TYPE = "JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.type'))";

// Behavioural signals: how this transaction compares with the sender's own
// recent activity.
async function behaviouralSignals({ senderWalletId, receiverWalletId, amount }) {
    const signals = [];

    // Outgoing scored transactions in the last 10 minutes.
    const [velocityRows] = await db.execute(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE sender_wallet_id = ?
           AND created_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
           AND ${TYPE} IN ${SCORED_TYPES}`,
        [senderWalletId]
    );
    const recent = Number(velocityRows[0].n);
    if (recent >= 6) {
        signals.push({ key: 'velocity', weight: 0.35, label: `${recent} payments out in the last 10 minutes` });
    } else if (recent >= 3) {
        signals.push({ key: 'velocity', weight: 0.2, label: `${recent} payments out in the last 10 minutes` });
    }

    // Amount compared with the sender's usual outgoing amount.
    const [amountRows] = await db.execute(
        `SELECT amount FROM transactions
         WHERE sender_wallet_id = ? AND status = 'completed' AND ${TYPE} IN ${SCORED_TYPES}
         ORDER BY id DESC LIMIT 50`,
        [senderWalletId]
    );
    if (amountRows.length >= 5) {
        const usual = median(amountRows.map(row => Number(row.amount)));
        const ratio = usual > 0 ? amount / usual : 0;
        if (ratio >= 10) {
            signals.push({ key: 'amount_anomaly', weight: 0.4, label: `Amount is ${Math.round(ratio)} times the sender's usual payment` });
        } else if (ratio >= 3) {
            signals.push({ key: 'amount_anomaly', weight: 0.2, label: `Amount is ${ratio.toFixed(1)} times the sender's usual payment` });
        }
    }

    // First payment to this recipient.
    if (receiverWalletId) {
        const [knownRows] = await db.execute(
            `SELECT COUNT(*) AS n FROM transactions
             WHERE sender_wallet_id = ? AND receiver_wallet_id = ? AND status = 'completed'`,
            [senderWalletId, receiverWalletId]
        );
        if (Number(knownRows[0].n) === 0) {
            signals.push({ key: 'new_recipient', weight: 0.15, label: 'First payment to this recipient' });
        }

        // Split payments: one sum sent to the same person in several small
        // parts, so that no single payment looks large.
        const [splitRows] = await db.execute(
            `SELECT COUNT(*) AS n FROM transactions
             WHERE sender_wallet_id = ? AND receiver_wallet_id = ?
               AND created_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)`,
            [senderWalletId, receiverWalletId]
        );
        const parts = Number(splitRows[0].n);
        if (parts >= 3) {
            signals.push({ key: 'split_payments', weight: 0.35, label: `${parts} payments to this recipient in the last 10 minutes` });
        }
    }

    return signals;
}

// Network signals: how money is moving between accounts around this
// transaction. These are the patterns of money-mule activity.
async function networkSignals({ senderWalletId, receiverWalletId, amount }) {
    const signals = [];

    // Pass-through: money received from other users minutes ago is being
    // sent straight on.
    const [inflowRows] = await db.execute(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
         WHERE receiver_wallet_id = ? AND sender_wallet_id IS NOT NULL
           AND status = 'completed'
           AND created_at >= DATE_SUB(NOW(), INTERVAL 15 MINUTE)`,
        [senderWalletId]
    );
    const justReceived = Number(inflowRows[0].total);
    if (justReceived > 0 && amount >= 0.8 * justReceived) {
        signals.push({ key: 'pass_through', weight: 0.4, label: 'Money received in the last 15 minutes is being passed straight on' });
    }

    if (receiverWalletId) {
        // Fan-in: the recipient is collecting from several senders.
        const [fanRows] = await db.execute(
            `SELECT COUNT(DISTINCT sender_wallet_id) AS n FROM transactions
             WHERE receiver_wallet_id = ? AND sender_wallet_id IS NOT NULL
               AND sender_wallet_id <> ?
               AND created_at >= DATE_SUB(NOW(), INTERVAL 60 MINUTE)`,
            [receiverWalletId, senderWalletId]
        );
        const senders = Number(fanRows[0].n);
        if (senders >= 3) {
            // An established account, such as a landlord or a shop, is paid
            // by many people as a matter of course. The signal is for an
            // account with little history that suddenly starts collecting.
            const [pastRows] = await db.execute(
                `SELECT COUNT(DISTINCT sender_wallet_id) AS n FROM transactions
                 WHERE receiver_wallet_id = ? AND sender_wallet_id IS NOT NULL
                   AND created_at < DATE_SUB(NOW(), INTERVAL 60 MINUTE)`,
                [receiverWalletId]
            );
            if (Number(pastRows[0].n) < 3) {
                signals.push({ key: 'fan_in', weight: 0.45, label: `Recipient has little history but has collected from ${senders} other accounts in the last hour` });
            }
        }

        // Round trip: the recipient sent a similar amount to the sender in
        // the last day, so the money is going in a circle.
        const [cycleRows] = await db.execute(
            `SELECT COUNT(*) AS n FROM transactions
             WHERE sender_wallet_id = ? AND receiver_wallet_id = ?
               AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
               AND amount BETWEEN ? AND ?`,
            [receiverWalletId, senderWalletId, amount * 0.8, amount * 1.2]
        );
        if (Number(cycleRows[0].n) > 0) {
            signals.push({ key: 'round_trip', weight: 0.3, label: 'A similar amount came from this recipient in the last 24 hours' });
        }
    }

    return signals;
}

// Assesses one outgoing transaction before it is committed.
//   type: 'TRANSFER' or 'CASH_OUT' for the model
//   balances are the current ones; the after-balances are projected.
async function assess({ modelType, amount, senderWalletId, receiverWalletId, senderBefore, receiverBefore }) {
    const [model, behaviour, network] = await Promise.all([
        scoreTransaction({
            type: modelType,
            amount,
            oldbalanceOrg: senderBefore,
            newbalanceOrig: Math.round((senderBefore - amount) * 100) / 100,
            oldbalanceDest: receiverWalletId ? receiverBefore : 0,
            newbalanceDest: receiverWalletId ? Math.round((receiverBefore + amount) * 100) / 100 : 0,
        }),
        behaviouralSignals({ senderWalletId, receiverWalletId, amount }),
        networkSignals({ senderWalletId, receiverWalletId, amount }),
    ]);

    const signals = [...behaviour, ...network];

    // If the model is unavailable the transaction is recorded as unscored,
    // as in version 1, and is never blocked for that reason alone. The
    // behavioural and network signals do not need the model, so they still
    // apply: the wallet keeps some protection while the model is down.
    if (!model) {
        const signalRisk = 1 - signals.reduce((keep, signal) => keep * (1 - signal.weight), 1);
        return {
            scored: false,
            modelScore: null,
            risk: Math.round(signalRisk * 1e6) / 1e6,
            tier: tierFor(signalRisk),
            signals,
            contributions: [],
            baseValue: null,
            mode: mode(),
        };
    }

    const modelScore = Math.min(1, Math.max(0, model.fraud_score));
    const risk = 1 - signals.reduce((keep, signal) => keep * (1 - signal.weight), 1 - modelScore);

    return {
        scored: true,
        modelScore: Math.round(modelScore * 1e6) / 1e6,
        risk: Math.round(risk * 1e6) / 1e6,
        tier: tierFor(risk),
        signals,
        contributions: Array.isArray(model.contributions) ? model.contributions : [],
        baseValue: typeof model.base_value === 'number' ? model.base_value : null,
        mode: mode(),
    };
}

module.exports = { assess, mode, tierFor, ALERT_THRESHOLD, HOLD_THRESHOLD };
