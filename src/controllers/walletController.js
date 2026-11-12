const walletModel = require('../models/walletModel');
const userModel = require('../models/userModel');
const db = require('../config/db');

const { amountError } = require('../services/ledger');
const payments = require('../services/payments');


// ==================================================
// GET WALLET BALANCE
// ==================================================

async function getBalance(req, res) {
    try {
        const userId = req.session.userId;

        if (!userId) {
            return res.status(401).json({
                message: 'Authentication required',
            });
        }

        const wallet = await walletModel.getWalletByUserId(userId);

        if (!wallet) {
            return res.status(404).json({
                message: 'Wallet not found',
            });
        }

        return res.status(200).json({
            walletId: wallet.id,
            balance: wallet.balance,
            currency: wallet.currency,
        });
    } catch (error) {
        console.error('[WalletController] Get balance error:', error);

        return res.status(500).json({
            message: 'Failed to retrieve wallet balance',
        });
    }
}


// ==================================================
// DEPOSIT
// Deposits are not scored by the current ML model.
// ==================================================

async function deposit(req, res) {
    try {
        const userId = req.session.userId;
        const { amount } = req.body;

        if (!userId) {
            return res.status(401).json({
                message: 'Authentication required',
            });
        }

        // Positive, at most two decimal places, and within the system limit.
        const amountProblem = amountError(amount);
        if (amountProblem) {
            return res.status(400).json({
                message: amountProblem,
            });
        }

        const wallet = await walletModel.getWalletByUserId(userId);

        if (!wallet) {
            return res.status(404).json({
                message: 'Wallet not found',
            });
        }

        // Credit the wallet and record the deposit in one database
        // transaction, so the balance and the history always agree.
        let result;
        const connection = await db.getConnection();

        try {
            await connection.beginTransaction();

            // Lock the wallet so the recorded before and after balances
            // match the update exactly.
            const [locked] = await connection.execute(
                `SELECT balance FROM wallets WHERE id = ? FOR UPDATE`,
                [wallet.id]
            );
            const balanceBefore = Number(locked[0].balance);
            const balanceAfter = Math.round((balanceBefore + amount) * 100) / 100;

            await connection.execute(
                `UPDATE wallets
                 SET balance = balance + ?
                 WHERE id = ?`,
                [amount, wallet.id]
            );

            [result] = await connection.execute(
                `INSERT INTO transactions
                    (amount, receiver_wallet_id, sender_wallet_id,
                     status, metadata)
                 VALUES (?, ?, NULL, 'completed', ?)`,
                [
                    amount,
                    wallet.id,
                    JSON.stringify({
                        type: 'deposit',
                        receiver_balance_before: balanceBefore,
                        receiver_balance_after: balanceAfter,
                    }),
                ]
            );

            await connection.commit();
        } catch (depositError) {
            await connection.rollback();
            throw depositError;
        } finally {
            connection.release();
        }

        const updatedWallet =
            await walletModel.getWalletByUserId(userId);

        return res.status(200).json({
            message: 'Deposit successful',
            transactionId: result.insertId,
            balance: updatedWallet.balance,
        });
    } catch (error) {
        console.error('[WalletController] Deposit error:', error);

        return res.status(500).json({
            message: 'Deposit failed',
        });
    }
}


// ==================================================
// WITHDRAWAL AND TRANSFER
// Both go through the shared payment service, which assesses
// the risk, applies the PIN challenge or hold in enforce mode,
// and moves the money in one database transaction.
// Withdrawals are scored as CASH_OUT, transfers as TRANSFER.
// ==================================================

async function withdraw(req, res) {
    if (!req.session.userId) {
        return res.status(401).json({ message: 'Authentication required' });
    }
    return payments.respond(res, () => payments.execute({
        userId: req.session.userId,
        kind: 'withdrawal',
        amount: req.body.amount,
        pin: req.body.pin,
    }));
}

async function transfer(req, res) {
    if (!req.session.userId) {
        return res.status(401).json({ message: 'Authentication required' });
    }
    return payments.respond(res, () => payments.execute({
        userId: req.session.userId,
        kind: 'transfer',
        amount: req.body.amount,
        recipientEmail: req.body.recipientEmail,
        pin: req.body.pin,
        // Set when the transfer pays a money request, so that if the
        // transfer is held the request is settled when it is released.
        details: Number.isInteger(req.body.requestId) && req.body.requestId > 0
            ? { request_id: req.body.requestId } : {},
    }));
}

// Confirmation of payee: the name registered to an email address, shown
// before a transfer is confirmed so the sender can check it is the right
// person. Only signed-in users can look up a name.
async function lookupRecipient(req, res) {
    try {
        const email = typeof req.query.email === 'string' ? req.query.email.trim() : '';
        if (!email) {
            return res.status(400).json({ message: 'Email is required' });
        }
        const recipient = await userModel.findUserByEmail(email);
        if (!recipient || String(recipient.id) === String(req.session.userId)) {
            return res.status(404).json({ message: 'Recipient not found' });
        }
        // Whether the sender has paid this person before, so the review
        // step can point out a first payment.
        const [paid] = await db.execute(
            `SELECT COUNT(*) AS n
             FROM transactions t
             JOIN wallets sw ON sw.id = t.sender_wallet_id
             JOIN wallets rw ON rw.id = t.receiver_wallet_id
             WHERE sw.user_id = ? AND rw.user_id = ? AND t.status = 'completed'`,
            [req.session.userId, recipient.id]
        );
        return res.status(200).json({
            name: recipient.name,
            email: recipient.email,
            paidBefore: Number(paid[0].n) > 0,
        });
    } catch (error) {
        console.error('[WalletController] Recipient lookup error:', error);
        return res.status(500).json({ message: 'Could not look up the recipient' });
    }
}


// ==================================================
// TRANSACTION HISTORY
// ==================================================

async function getHistory(req, res) {
    try {
        const userId = req.session.userId;

        if (!userId) {
            return res.status(401).json({
                message: 'Authentication required',
            });
        }

        const page = Math.max(
            1,
            parseInt(req.query.page, 10) || 1
        );

        const limit = Math.min(
            100,
            Math.max(1, parseInt(req.query.limit, 10) || 20)
        );

        const offset = (page - 1) * limit;

        const wallet = await walletModel.getWalletByUserId(userId);

        if (!wallet) {
            return res.status(404).json({
                message: 'Wallet not found',
            });
        }

        const {
            transactions,
            total,
        } = await walletModel.getTransactionsByWalletId(
            wallet.id,
            limit,
            offset
        );

        // The fraud check belongs to the sender's transaction, so the
        // receiving party does not see its score or review status.
        const visible = transactions.map(tx => {
            let meta = tx.metadata;
            if (typeof meta === 'string') {
                try { meta = JSON.parse(meta); } catch (e) { meta = {}; }
            }

            const item = {
                id: tx.id,
                type: (meta && meta.type) || 'transfer',
                direction: tx.direction,
                amount: tx.amount,
                currency: tx.currency,
                status: tx.status,
                created_at: tx.created_at,
                counterparty: tx.direction === 'out'
                    ? { name: tx.receiver_name, email: tx.receiver_email }
                    : { name: tx.sender_name, email: tx.sender_email },
            };

            // The viewer's own balance before and after, for receipts.
            // Older records made before these were stored have none.
            const side = tx.direction === 'out' ? 'sender' : 'receiver';
            if (meta && meta[`${side}_balance_before`] !== undefined) {
                item.balance_before = Number(meta[`${side}_balance_before`]);
                item.balance_after = Number(meta[`${side}_balance_after`]);
            }

            // Only these types are scored by the fraud model; payments,
            // savings and loan movements are recorded without a score.
            const scoredTypes = ['transfer', 'withdrawal', 'bank_transfer'];
            const details = {};
            ['vault_name', 'bank', 'account_masked', 'kind', 'number', 'account', 'loan_id', 'fee']
                .forEach(key => { if (meta && meta[key] !== undefined) details[key] = meta[key]; });
            if (Object.keys(details).length) item.details = details;

            // What the risk engine did with this payment, for the sender only.
            if (tx.direction === 'out' && meta && meta.risk && meta.risk.action) {
                item.risk_action = meta.risk.action;
            }

            if (tx.direction === 'out' && scoredTypes.includes(item.type)) {
                item.fraud_check = {
                    scoring_status: tx.scoring_status,
                    fraud_score: tx.fraud_score === null ? null : Number(tx.fraud_score),
                    alert_status: tx.alert_status || null,
                };
            }

            return item;
        });

        return res.status(200).json({
            page,
            limit,
            totalTransactions: total,
            totalPages: Math.ceil(total / limit),
            transactions: visible,
        });
    } catch (error) {
        console.error(
            '[WalletController] Get history error:',
            error
        );

        return res.status(500).json({
            message: 'Failed to retrieve transaction history',
        });
    }
}


// ==================================================
// EXPORTS
// ==================================================

module.exports = {
    getBalance,
    deposit,
    withdraw,
    transfer,
    lookupRecipient,
    getHistory,
};