// Risk engine (versions 2 and 3).
//
// The machine learning model scores one transaction from its amount and
// balances. That is not enough on its own in a live wallet: the model's
// strongest feature, balance_discrepancy, is always zero here because the
// ledger is consistent, and the model knows nothing about how a user
// normally behaves or how money is moving between accounts.
//
// This engine adds that context. It reads behavioural and network signals
// from a transaction history, combines them with the model score into one
// risk score, and maps the score to a response tier.
//
//   risk = 1 - (1 - model score) x (1 - w1) x (1 - w2) ...
//
// Each signal can only raise the risk, the result stays between 0 and 1,
// and every contributing signal is recorded so the analyst sees exactly why
// it was raised.
//
// Version 3: the history is read through a provider, so the same signals
// run on the wallet's own transactions (walletHistory) and on the events
// that clients of the fraud API send (apiHistory in services/fraudApi.js).
// Callers can add their own signals, such as a new device or a recipient
// other users have reported.

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

function combine(base, signals) {
    return 1 - signals.reduce((keep, signal) => keep * (1 - signal.weight), 1 - base);
}

const SCORED_TYPES = "('transfer', 'withdrawal', 'bank_transfer')";
const TYPE = "JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.type'))";

// History provider for the wallet: reads the transactions table.
function walletHistory(senderWalletId, receiverWalletId) {
    const one = async (sql, params) => Number((await db.execute(sql, params))[0][0].n);
    return {
        outgoingCountSince: minutes => one(
            `SELECT COUNT(*) AS n FROM transactions
             WHERE sender_wallet_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
               AND ${TYPE} IN ${SCORED_TYPES}`, [senderWalletId, minutes]),
        recentOutgoingAmounts: async limit => (await db.execute(
            `SELECT amount FROM transactions
             WHERE sender_wallet_id = ? AND status = 'completed' AND ${TYPE} IN ${SCORED_TYPES}
             ORDER BY id DESC LIMIT ${Number(limit)}`, [senderWalletId]))[0].map(r => Number(r.amount)),
        paidBefore: () => one(
            `SELECT COUNT(*) AS n FROM transactions
             WHERE sender_wallet_id = ? AND receiver_wallet_id = ? AND status = 'completed'`,
            [senderWalletId, receiverWalletId]),
        toCounterpartySince: minutes => one(
            `SELECT COUNT(*) AS n FROM transactions
             WHERE sender_wallet_id = ? AND receiver_wallet_id = ?
               AND created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)`, [senderWalletId, receiverWalletId, minutes]),
        inflowSince: async minutes => Number((await db.execute(
            `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
             WHERE receiver_wallet_id = ? AND sender_wallet_id IS NOT NULL AND status = 'completed'
               AND created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)`, [senderWalletId, minutes]))[0][0].total),
        counterpartySendersSince: minutes => one(
            `SELECT COUNT(DISTINCT sender_wallet_id) AS n FROM transactions
             WHERE receiver_wallet_id = ? AND sender_wallet_id IS NOT NULL AND sender_wallet_id <> ?
               AND created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)`, [receiverWalletId, senderWalletId, minutes]),
        counterpartySendersBefore: minutes => one(
            `SELECT COUNT(DISTINCT sender_wallet_id) AS n FROM transactions
             WHERE receiver_wallet_id = ? AND sender_wallet_id IS NOT NULL
               AND created_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)`, [receiverWalletId, minutes]),
        returnedSince: (hours, low, high) => one(
            `SELECT COUNT(*) AS n FROM transactions
             WHERE sender_wallet_id = ? AND receiver_wallet_id = ?
               AND created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR) AND amount BETWEEN ? AND ?`,
            [receiverWalletId, senderWalletId, hours, low, high]),
    };
}

// Behavioural signals: how this transaction compares with the sender's own
// recent activity.
async function behaviouralSignals(history, { amount, hasCounterparty }) {
    const signals = [];

    const recent = await history.outgoingCountSince(10);
    if (recent >= 6) {
        signals.push({ key: 'velocity', weight: 0.35, label: `${recent} payments out in the last 10 minutes` });
    } else if (recent >= 3) {
        signals.push({ key: 'velocity', weight: 0.2, label: `${recent} payments out in the last 10 minutes` });
    }

    const amounts = await history.recentOutgoingAmounts(50);
    if (amounts.length >= 5) {
        const usual = median(amounts);
        const ratio = usual > 0 ? amount / usual : 0;
        if (ratio >= 10) {
            signals.push({ key: 'amount_anomaly', weight: 0.4, label: `Amount is ${Math.round(ratio)} times the sender's usual payment` });
        } else if (ratio >= 3) {
            signals.push({ key: 'amount_anomaly', weight: 0.2, label: `Amount is ${ratio.toFixed(1)} times the sender's usual payment` });
        }
    }

    if (hasCounterparty) {
        if (await history.paidBefore() === 0) {
            signals.push({ key: 'new_recipient', weight: 0.15, label: 'First payment to this recipient' });
        }
        // Split payments: one sum sent to the same person in several small
        // parts, so that no single payment looks large.
        const parts = await history.toCounterpartySince(10);
        if (parts >= 3) {
            signals.push({ key: 'split_payments', weight: 0.35, label: `${parts} payments to this recipient in the last 10 minutes` });
        }
    }
    return signals;
}

// Network signals: how money is moving between accounts around this
// transaction. These are the patterns of money-mule activity.
async function networkSignals(history, { amount, hasCounterparty }) {
    const signals = [];

    const justReceived = await history.inflowSince(15);
    if (justReceived > 0 && amount >= 0.8 * justReceived) {
        signals.push({ key: 'pass_through', weight: 0.4, label: 'Money received in the last 15 minutes is being passed straight on' });
    }

    if (hasCounterparty) {
        const senders = await history.counterpartySendersSince(60);
        if (senders >= 3) {
            // An established account, such as a landlord or a shop, is paid
            // by many people as a matter of course. The signal is for an
            // account with little history that suddenly starts collecting.
            if (await history.counterpartySendersBefore(60) < 3) {
                signals.push({ key: 'fan_in', weight: 0.45, label: `Recipient has little history but has collected from ${senders} other accounts in the last hour` });
            }
        }
        if (await history.returnedSince(24, amount * 0.8, amount * 1.2) > 0) {
            signals.push({ key: 'round_trip', weight: 0.3, label: 'A similar amount came from this recipient in the last 24 hours' });
        }
    }
    return signals;
}

// Scores and assesses one outgoing transaction before it is committed.
//   modelType: 'TRANSFER' or 'CASH_OUT'
//   history:   a provider such as walletHistory(...)
//   extraSignals: signals the caller already knows (device, reports, purpose)
async function assessWith({ modelType, amount, senderBefore, receiverBefore, hasCounterparty, history, extraSignals = [] }) {
    const features = {
        type: modelType,
        amount,
        oldbalanceOrg: senderBefore,
        newbalanceOrig: Math.round((senderBefore - amount) * 100) / 100,
        oldbalanceDest: hasCounterparty ? receiverBefore : 0,
        newbalanceDest: hasCounterparty ? Math.round((receiverBefore + amount) * 100) / 100 : 0,
    };
    const [model, behaviour, network] = await Promise.all([
        scoreTransaction(features),
        behaviouralSignals(history, { amount, hasCounterparty }),
        networkSignals(history, { amount, hasCounterparty }),
    ]);

    const signals = [...behaviour, ...network, ...extraSignals];

    // If the model is unavailable the transaction is recorded as unscored,
    // as in version 1, and is never blocked for that reason alone. The
    // signals do not need the model, so they still apply: the wallet keeps
    // some protection while the model is down. The retry queue scores the
    // transaction later (services/scoringQueue.js).
    if (!model) {
        const signalRisk = combine(0, signals);
        return {
            scored: false,
            modelScore: null,
            risk: Math.round(signalRisk * 1e6) / 1e6,
            tier: tierFor(signalRisk),
            signals,
            contributions: [],
            baseValue: null,
            modelVersion: null,
            shadow: null,
            features,
            mode: mode(),
        };
    }

    const modelScore = Math.min(1, Math.max(0, model.fraud_score));
    const risk = combine(modelScore, signals);

    return {
        scored: true,
        modelScore: Math.round(modelScore * 1e6) / 1e6,
        risk: Math.round(risk * 1e6) / 1e6,
        tier: tierFor(risk),
        signals,
        contributions: Array.isArray(model.contributions) ? model.contributions : [],
        baseValue: typeof model.base_value === 'number' ? model.base_value : null,
        modelVersion: model.model_version || null,
        // The challenger model's score, when one is being tried in shadow.
        shadow: model.shadow && typeof model.shadow.fraud_score === 'number'
            ? { score: Math.round(model.shadow.fraud_score * 1e6) / 1e6, version: model.shadow.model_version || null }
            : null,
        features,
        mode: mode(),
    };
}

// The wallet's assessment (unchanged interface from version 2).
async function assess({ modelType, amount, senderWalletId, receiverWalletId, senderBefore, receiverBefore, extraSignals = [] }) {
    return assessWith({
        modelType,
        amount,
        senderBefore,
        receiverBefore,
        hasCounterparty: Boolean(receiverWalletId),
        history: walletHistory(senderWalletId, receiverWalletId),
        extraSignals,
    });
}

module.exports = {
    assess, assessWith, walletHistory, combine, mode, tierFor, ALERT_THRESHOLD, HOLD_THRESHOLD,
};
