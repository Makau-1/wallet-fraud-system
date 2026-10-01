const walletModel = require('../models/walletModel');
const userModel = require('../models/userModel');
const db = require('../config/db');

async function getBalance(req, res) {
    try {
        const userId = req.session.userId;

        if (!userId) {
            return res.status(401).json({
                message: 'Authentication required'
            });
        }

        const wallet = await walletModel.getWalletByUserId(userId);

        if (!wallet) {
            return res.status(404).json({
                message: 'Wallet not found'
            });
        }

        return res.status(200).json({
            walletId: wallet.id,
            balance: wallet.balance
        });
    } catch (error) {
        console.error('Get balance error:', error);

        return res.status(500).json({
            message: 'Failed to retrieve wallet balance'
        });
    }
}

async function deposit(req, res) {
    try {
        const userId = req.session.userId;
        const { amount } = req.body;

        if (!userId) {
            return res.status(401).json({
                message: 'Authentication required'
            });
        }

        if (
            typeof amount !== 'number' ||
            !Number.isFinite(amount) ||
            amount <= 0
        ) {
            return res.status(400).json({
                message: 'Amount must be a positive number'
            });
        }

        const wallet = await walletModel.getWalletByUserId(userId);

        if (!wallet) {
            return res.status(404).json({
                message: 'Wallet not found'
            });
        }

        await walletModel.incrementBalance(wallet.id, amount);

        const sql = `
            INSERT INTO transactions
            (amount, receiver_wallet_id, sender_wallet_id, status, metadata)
            VALUES (?, ?, NULL, 'completed', ?)
        `;

        const [result] = await db.execute(sql, [
            amount,
            wallet.id,
            JSON.stringify({ type: 'deposit' })
        ]);

        const updatedWallet = await walletModel.getWalletByUserId(userId);

        return res.status(200).json({
            message: 'Deposit successful',
            transactionId: result.insertId,
            balance: updatedWallet.balance
        });

    } catch (error) {
        console.error('Deposit error:', error);

        return res.status(500).json({
            message: 'Deposit failed'
        });
    }
}

async function withdraw(req, res) {
    const connection = await db.getConnection();

    try {
        const userId = req.session.userId;
        const { amount } = req.body;

        if (!userId) {
            return res.status(401).json({
                message: 'Authentication required'
            });
        }

        if (
            typeof amount !== 'number' ||
            !Number.isFinite(amount) ||
            amount <= 0
        ) {
            return res.status(400).json({
                message: 'Amount must be a positive number'
            });
        }

        const wallet = await walletModel.getWalletByUserId(userId);

        if (!wallet) {
            return res.status(404).json({
                message: 'Wallet not found'
            });
        }

        await connection.beginTransaction();

        const [rows] = await connection.execute(
            `
            SELECT id, balance
            FROM wallets
            WHERE id = ?
            FOR UPDATE
            `,
            [wallet.id]
        );

        if (!rows.length) {
            await connection.rollback();

            return res.status(404).json({
                message: 'Wallet not found'
            });
        }

        const currentBalance = Number(rows[0].balance);

        if (amount > currentBalance) {
            await connection.rollback();

            return res.status(400).json({
                message: 'Insufficient funds'
            });
        }

        await connection.execute(
            `
            UPDATE wallets
            SET balance = balance - ?
            WHERE id = ?
            `,
            [amount, wallet.id]
        );

        const [result] = await connection.execute(
            `
            INSERT INTO transactions
            (amount, receiver_wallet_id, sender_wallet_id, status, metadata)
            VALUES (?, NULL, ?, 'completed', ?)
            `,
            [
                amount,
                wallet.id,
                JSON.stringify({ type: 'withdrawal' })
            ]
        );

        await connection.commit();

        const [updatedRows] = await connection.execute(
            `
            SELECT balance
            FROM wallets
            WHERE id = ?
            `,
            [wallet.id]
        );

        return res.status(200).json({
            message: 'Withdrawal successful',
            transactionId: result.insertId,
            balance: updatedRows[0].balance
        });

    } catch (error) {
        await connection.rollback();

        console.error('Withdrawal error:', error);

        return res.status(500).json({
            message: 'Withdrawal failed'
        });

    } finally {
        connection.release();
    }
}

async function transfer(req, res) {
    const connection = await db.getConnection();

    try {
        const senderId = req.session.userId;
        const { recipientEmail, amount } = req.body;

        if (!senderId) {
            return res.status(401).json({
                message: 'Authentication required'
            });
        }

        if (
            typeof recipientEmail !== 'string' ||
            !recipientEmail.trim()
        ) {
            return res.status(400).json({
                message: 'Recipient email is required'
            });
        }

        if (
            typeof amount !== 'number' ||
            !Number.isFinite(amount) ||
            amount <= 0
        ) {
            return res.status(400).json({
                message: 'Amount must be a positive number'
            });
        }

        // Find recipient by email
        const recipient = await userModel.findUserByEmail(
            recipientEmail.trim()
        );

        if (!recipient) {
            return res.status(404).json({
                message: 'Recipient not found'
            });
        }

        // Prevent transferring to yourself
        if (recipient.id === senderId) {
            return res.status(400).json({
                message: 'You cannot transfer money to yourself'
            });
        }

        // Find sender wallet
        const senderWallet = await walletModel.getWalletByUserId(senderId);

        if (!senderWallet) {
            return res.status(404).json({
                message: 'Sender wallet not found'
            });
        }

        // Find recipient wallet
        const recipientWallet = await walletModel.getWalletByUserId(recipient.id);

        if (!recipientWallet) {
            return res.status(404).json({
                message: 'Recipient wallet not found'
            });
        }

        await connection.beginTransaction();

        // Lock sender wallet and get latest balance
        const [senderRows] = await connection.execute(
            `
            SELECT id, balance
            FROM wallets
            WHERE id = ?
            FOR UPDATE
            `,
            [senderWallet.id]
        );

        if (!senderRows.length) {
            await connection.rollback();

            return res.status(404).json({
                message: 'Sender wallet not found'
            });
        }

        const senderBalance = Number(senderRows[0].balance);

        if (amount > senderBalance) {
            await connection.rollback();

            return res.status(400).json({
                message: 'Insufficient funds'
            });
        }

        // Deduct money from sender
        await connection.execute(
            `
            UPDATE wallets
            SET balance = balance - ?
            WHERE id = ?
            `,
            [amount, senderWallet.id]
        );

        // Add money to recipient
        await connection.execute(
            `
            UPDATE wallets
            SET balance = balance + ?
            WHERE id = ?
            `,
            [amount, recipientWallet.id]
        );

        // Record transaction
        const [result] = await connection.execute(
            `
            INSERT INTO transactions
            (
                amount,
                sender_wallet_id,
                receiver_wallet_id,
                status,
                metadata
            )
            VALUES (?, ?, ?, 'completed', ?)
            `,
            [
                amount,
                senderWallet.id,
                recipientWallet.id,
                JSON.stringify({ type: 'transfer' })
            ]
        );

        await connection.commit();

        // Get updated balance
        const [updatedSenderRows] = await connection.execute(
            `
            SELECT balance
            FROM wallets
            WHERE id = ?
            `,
            [senderWallet.id]
        );

        return res.status(200).json({
            message: 'Transfer successful',
            transactionId: result.insertId,
            recipient: recipient.email,
            balance: updatedSenderRows[0].balance
        });

    } catch (error) {
        await connection.rollback();

        console.error('Transfer error:', error);

        return res.status(500).json({
            message: 'Transfer failed'
        });

    } finally {
        connection.release();
    }
}

async function getHistory(req, res) {
    try {
        const userId = req.session.userId;

        if (!userId) {
            return res.status(401).json({
                message: 'Authentication required'
            });
        }

        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.max(1, parseInt(req.query.limit, 10) || 20);
        const offset = (page - 1) * limit;

        const wallet = await walletModel.getWalletByUserId(userId);

        if (!wallet) {
            return res.status(404).json({
                message: 'Wallet not found'
            });
        }

        const { transactions, total } = await walletModel.getTransactionsByWalletId(
            wallet.id,
            limit,
            offset
        );

        return res.status(200).json({
            page,
            limit,
            totalTransactions: total,
            totalPages: Math.ceil(total / limit),
            transactions
        });

    } catch (error) {
        console.error('Get history error:', error);

        return res.status(500).json({
            message: 'Failed to retrieve transaction history'
        });
    }
}

module.exports = {
    getBalance,
    deposit,
    withdraw,
    transfer,
    getHistory
};