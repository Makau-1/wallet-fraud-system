// Savings goals. Money moved into a goal leaves the wallet balance and is
// held in the goal until its unlock date. A goal with no lock (0 days)
// works like flexible savings and can be withdrawn at any time.

const db = require('../config/db');
const {
    ServiceError, round2, checkAmount, withTransaction,
    walletForUser, lockWallet, debit, credit, handle,
} = require('../services/ledger');

const LOCK_OPTIONS = [0, 7, 30, 90, 180, 365];

// Dates are compared and formatted in MySQL so the database's own date
// decides when a goal unlocks, whatever the server or browser time zone.
const COLUMNS = `*,
    DATE_FORMAT(locked_until, '%Y-%m-%d') AS locked_until_s,
    DATE_FORMAT(locked_until, '%e %b %Y') AS locked_until_label,
    (locked_until <= CURDATE()) AS is_unlocked,
    GREATEST(DATEDIFF(locked_until, CURDATE()), 0) AS days_left`;
const MAX_ACTIVE_GOALS = 10;

function shape(vault) {
    return {
        id: vault.id,
        name: vault.name,
        target_amount: vault.target_amount === null ? null : Number(vault.target_amount),
        balance: Number(vault.balance),
        locked_until: vault.locked_until_s,
        unlocked: Boolean(Number(vault.is_unlocked)),
        days_left: Number(vault.days_left),
        status: vault.status,
        created_at: vault.created_at,
        closed_at: vault.closed_at,
    };
}

async function lockVault(connection, vaultId, walletId) {
    const [rows] = await connection.execute(
        `SELECT ${COLUMNS}
         FROM savings_vaults
         WHERE id = ? AND wallet_id = ? AND status = 'active'
         FOR UPDATE`,
        [vaultId, walletId]
    );
    if (!rows.length) throw new ServiceError(404, 'Savings goal not found');
    return rows[0];
}

const list = handle('SavingsController', async (req, res) => {
    const wallet = await walletForUser(req.session.userId);
    const [rows] = await db.execute(
        `SELECT ${COLUMNS} FROM savings_vaults
         WHERE wallet_id = ?
         ORDER BY status = 'active' DESC, created_at DESC
         LIMIT 50`,
        [wallet.id]
    );
    const vaults = rows.map(shape);
    const total = round2(vaults.filter(v => v.status === 'active').reduce((sum, v) => sum + v.balance, 0));
    res.json({ vaults, total, lockOptions: LOCK_OPTIONS });
});

const create = handle('SavingsController', async (req, res) => {
    const wallet = await walletForUser(req.session.userId);
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const lockDays = Number(req.body.lockDays);
    let target = req.body.target;

    if (!name || name.length > 60) {
        throw new ServiceError(400, 'Give the goal a name of up to 60 characters');
    }
    if (!LOCK_OPTIONS.includes(lockDays)) {
        throw new ServiceError(400, 'Choose a lock period from the list');
    }
    target = target === undefined || target === null || target === '' ? null : checkAmount(target);

    // Count and insert with the wallet locked, so parallel requests cannot
    // go past the limit.
    const rows = await withTransaction(async (connection) => {
        await lockWallet(connection, wallet.id);
        const [countRows] = await connection.execute(
            "SELECT COUNT(*) AS n FROM savings_vaults WHERE wallet_id = ? AND status = 'active'",
            [wallet.id]
        );
        if (Number(countRows[0].n) >= MAX_ACTIVE_GOALS) {
            throw new ServiceError(409, `You can have up to ${MAX_ACTIVE_GOALS} active goals`);
        }
        const [result] = await connection.execute(
            `INSERT INTO savings_vaults (wallet_id, name, target_amount, locked_until)
             VALUES (?, ?, ?, DATE_ADD(CURDATE(), INTERVAL ? DAY))`,
            [wallet.id, name, target, lockDays]
        );
        const [created] = await connection.execute(`SELECT ${COLUMNS} FROM savings_vaults WHERE id = ?`, [result.insertId]);
        return created;
    });
    res.status(201).json({ message: 'Savings goal created', vault: shape(rows[0]) });
});

const addMoney = handle('SavingsController', async (req, res) => {
    const wallet = await walletForUser(req.session.userId);
    const amount = checkAmount(req.body.amount);
    const vaultId = Number(req.params.id);

    const outcome = await withTransaction(async (connection) => {
        const vault = await lockVault(connection, vaultId, wallet.id);
        const moved = await debit(connection, wallet.id, amount, {
            type: 'savings_deposit',
            vault_id: vault.id,
            vault_name: vault.name,
        });
        await connection.execute(
            'UPDATE savings_vaults SET balance = balance + ? WHERE id = ?',
            [amount, vault.id]
        );
        return { ...moved, vaultBalance: round2(Number(vault.balance) + amount) };
    });

    res.json({
        message: 'Money moved to savings',
        transactionId: outcome.transactionId,
        balance: outcome.after,
        vaultBalance: outcome.vaultBalance,
    });
});

// Withdraws an amount, or everything if no amount is given. Taking
// everything out closes the goal.
const withdraw = handle('SavingsController', async (req, res) => {
    const wallet = await walletForUser(req.session.userId);
    const vaultId = Number(req.params.id);
    const requested = req.body && req.body.amount !== undefined ? checkAmount(req.body.amount) : null;

    const outcome = await withTransaction(async (connection) => {
        const vault = await lockVault(connection, vaultId, wallet.id);
        if (!Number(vault.is_unlocked)) {
            throw new ServiceError(409, `This goal is locked until ${vault.locked_until_label}`);
        }
        const held = Number(vault.balance);
        const amount = requested === null ? held : requested;
        if (amount > held) throw new ServiceError(400, `This goal holds ${held.toFixed(2)}`);

        let moved = null;
        if (amount > 0) {
            moved = await credit(connection, wallet.id, amount, {
                type: 'savings_release',
                vault_id: vault.id,
                vault_name: vault.name,
            });
        }
        const closes = round2(held - amount) === 0;
        await connection.execute(
            `UPDATE savings_vaults
             SET balance = balance - ?,
                 status = IF(?, 'closed', status),
                 closed_at = IF(?, CURRENT_TIMESTAMP, closed_at)
             WHERE id = ?`,
            [amount, closes, closes, vault.id]
        );
        return { moved, amount, closes };
    });

    res.json({
        message: outcome.closes ? 'Savings withdrawn and goal closed' : 'Savings withdrawn',
        transactionId: outcome.moved ? outcome.moved.transactionId : null,
        amount: outcome.amount,
        closed: outcome.closes,
    });
});

module.exports = { list, create, addMoney, withdraw };
