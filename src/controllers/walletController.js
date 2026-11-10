const walletModel = require('../models/walletModel');
const userModel = require('../models/userModel');
const db = require('../config/db');

const {
    scoreAndRecordTransaction,
} = require('../services/fraudService');
const { amountError } = require('../services/ledger');


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
// WITHDRAWAL
// Withdrawals are scored as CASH_OUT.
// ==================================================

async function withdraw(req, res) {
    let connection = null;
    let transactionStarted = false;

    console.log('[WalletController] Withdrawal handler reached');

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

        connection = await db.getConnection();

        await connection.beginTransaction();
        transactionStarted = true;

        // Lock the wallet before reading its latest balance.
        const [rows] = await connection.execute(
            `SELECT id, balance
             FROM wallets
             WHERE id = ?
             FOR UPDATE`,
            [wallet.id]
        );

        if (rows.length === 0) {
            await connection.rollback();
            transactionStarted = false;

            return res.status(404).json({
                message: 'Wallet not found',
            });
        }

        const senderBefore = Number(rows[0].balance);

        if (amount > senderBefore) {
            await connection.rollback();
            transactionStarted = false;

            return res.status(400).json({
                message: 'Insufficient funds',
            });
        }

        const senderAfter = senderBefore - amount;

        await connection.execute(
            `UPDATE wallets
             SET balance = balance - ?
             WHERE id = ?`,
            [amount, wallet.id]
        );

        const [result] = await connection.execute(
            `INSERT INTO transactions
                (amount, receiver_wallet_id, sender_wallet_id,
                 status, metadata)
             VALUES (?, NULL, ?, 'completed', ?)`,
            [
                amount,
                wallet.id,
                JSON.stringify({
                    type: 'withdrawal',
                    sender_balance_before: senderBefore,
                    sender_balance_after: senderAfter,
                }),
            ]
        );

        const transactionId = result.insertId;

        // Commit the withdrawal before fraud scoring.
        await connection.commit();
        transactionStarted = false;

        console.log(
            '[WalletController] Withdrawal committed. Transaction ID:',
            transactionId
        );

        // Release the wallet transaction's connection before scoring.
        connection.release();
        connection = null;

        try {
            console.log(
                '[WalletController] Starting withdrawal fraud scoring:',
                transactionId
            );

            const scoringResult = await scoreAndRecordTransaction(
                db,
                transactionId,
                {
                    type: 'CASH_OUT',
                    amount,
                    oldbalanceOrg: senderBefore,
                    newbalanceOrig: senderAfter,
                    oldbalanceDest: 0,
                    newbalanceDest: 0,
                }
            );

            console.log(
                '[WalletController] Withdrawal scoring finished:',
                transactionId,
                scoringResult ? 'scored' : 'unscored'
            );
        } catch (scoringError) {
            console.error(
                '[WalletController] Withdrawal scoring failed:',
                scoringError
            );
        }

        return res.status(200).json({
            message: 'Withdrawal successful',
            transactionId,
            balance: senderAfter,
        });
    } catch (error) {
        if (connection && transactionStarted) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error(
                    '[WalletController] Withdrawal rollback error:',
                    rollbackError
                );
            }
        }

        console.error('[WalletController] Withdrawal error:', error);

        return res.status(500).json({
            message: 'Withdrawal failed',
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
}


// ==================================================
// TRANSFER
// Transfers are scored as TRANSFER.
// ==================================================

async function transfer(req, res) {
    let connection = null;
    let transactionStarted = false;

    console.log('[WalletController] Transfer handler reached');

    try {
        const senderId = req.session.userId;
        const { recipientEmail, amount } = req.body;

        if (!senderId) {
            return res.status(401).json({
                message: 'Authentication required',
            });
        }

        if (
            typeof recipientEmail !== 'string' ||
            !recipientEmail.trim()
        ) {
            return res.status(400).json({
                message: 'Recipient email is required',
            });
        }

        // Positive, at most two decimal places, and within the system limit.
        const amountProblem = amountError(amount);
        if (amountProblem) {
            return res.status(400).json({
                message: amountProblem,
            });
        }

        const recipient = await userModel.findUserByEmail(
            recipientEmail.trim()
        );

        if (!recipient) {
            return res.status(404).json({
                message: 'Recipient not found',
            });
        }

        if (String(recipient.id) === String(senderId)) {
            return res.status(400).json({
                message: 'You cannot transfer money to yourself',
            });
        }

        const senderWallet =
            await walletModel.getWalletByUserId(senderId);

        if (!senderWallet) {
            return res.status(404).json({
                message: 'Sender wallet not found',
            });
        }

        const recipientWallet =
            await walletModel.getWalletByUserId(recipient.id);

        if (!recipientWallet) {
            return res.status(404).json({
                message: 'Recipient wallet not found',
            });
        }

        connection = await db.getConnection();

        await connection.beginTransaction();
        transactionStarted = true;

        // Lock both wallet rows in a consistent order.
        const [lockedRows] = await connection.execute(
            `SELECT id, balance
             FROM wallets
             WHERE id IN (?, ?)
             ORDER BY id
             FOR UPDATE`,
            [
                senderWallet.id,
                recipientWallet.id,
            ]
        );

        const senderRow = lockedRows.find(
            row => String(row.id) === String(senderWallet.id)
        );

        const recipientRow = lockedRows.find(
            row => String(row.id) === String(recipientWallet.id)
        );

        if (!senderRow || !recipientRow) {
            await connection.rollback();
            transactionStarted = false;

            return res.status(404).json({
                message: 'Sender or recipient wallet not found',
            });
        }

        const senderBefore = Number(senderRow.balance);
        const receiverBefore = Number(recipientRow.balance);

        if (amount > senderBefore) {
            await connection.rollback();
            transactionStarted = false;

            return res.status(400).json({
                message: 'Insufficient funds',
            });
        }

        const senderAfter = senderBefore - amount;
        const receiverAfter = receiverBefore + amount;

        await connection.execute(
            `UPDATE wallets
             SET balance = balance - ?
             WHERE id = ?`,
            [amount, senderWallet.id]
        );

        await connection.execute(
            `UPDATE wallets
             SET balance = balance + ?
             WHERE id = ?`,
            [amount, recipientWallet.id]
        );

        const [result] = await connection.execute(
            `INSERT INTO transactions
                (amount, sender_wallet_id, receiver_wallet_id,
                 status, metadata)
             VALUES (?, ?, ?, 'completed', ?)`,
            [
                amount,
                senderWallet.id,
                recipientWallet.id,
                JSON.stringify({
                    type: 'transfer',
                    sender_balance_before: senderBefore,
                    sender_balance_after: senderAfter,
                    receiver_balance_before: receiverBefore,
                    receiver_balance_after: receiverAfter,
                }),
            ]
        );

        const transactionId = result.insertId;

        // Commit the transfer before calling the ML service.
        await connection.commit();
        transactionStarted = false;

        console.log(
            '[WalletController] Transfer committed. Transaction ID:',
            transactionId
        );

        // Release this connection so the scoring service can
        // use a separate connection from the pool.
        connection.release();
        connection = null;

        try {
            console.log(
                '[WalletController] Starting transfer fraud scoring:',
                transactionId
            );

            const scoringResult = await scoreAndRecordTransaction(
                db,
                transactionId,
                {
                    type: 'TRANSFER',
                    amount,
                    oldbalanceOrg: senderBefore,
                    newbalanceOrig: senderAfter,
                    oldbalanceDest: receiverBefore,
                    newbalanceDest: receiverAfter,
                }
            );

            console.log(
                '[WalletController] Transfer scoring finished:',
                transactionId,
                scoringResult ? 'scored' : 'unscored'
            );
        } catch (scoringError) {
            console.error(
                '[WalletController] Transfer scoring failed:',
                scoringError
            );
        }

        return res.status(200).json({
            message: 'Transfer successful',
            transactionId,
            recipient: recipient.email,
            balance: senderAfter,
        });
    } catch (error) {
        if (connection && transactionStarted) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error(
                    '[WalletController] Transfer rollback error:',
                    rollbackError
                );
            }
        }

        console.error('[WalletController] Transfer error:', error);

        return res.status(500).json({
            message: 'Transfer failed',
        });
    } finally {
        if (connection) {
            connection.release();
        }
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
    getHistory,
};