// Double-entry journal (version 3).
//
// Every movement of money is recorded as an entry made of lines, and the
// lines of an entry always add up to zero: money is only ever moved from
// one account to another, never created or lost. A wallet's balance must
// equal the sum of the lines on its account, and the reconciliation job
// (services/reconcile.js) checks that it does.
//
// Accounts
//   wallet:<id>       a customer's wallet
//   savings:<id>      a savings goal
//   loan:<id>         a loan (negative while money is owed)
//   held:<id>         a payment on hold or cooling off, by transaction id
//   chama:<id>        a chama's pot
//   external:<name>   money entering or leaving the system: cash, bank,
//                     merchants, mpesa, lab (attack-lab funding), closed
//   equity:opening    balances that existed before the journal started
//
// Entries are append-only and hash-chained (services/chain.js).

const db = require('../config/db');
const { linkHash, nowStamp, lockHead, moveHead } = require('./chain');

const account = {
    wallet: id => `wallet:${id}`,
    savings: id => `savings:${id}`,
    loan: id => `loan:${id}`,
    held: id => `held:${id}`,
    chama: id => `chama:${id}`,
    external: name => `external:${name}`,
    opening: 'equity:opening',
};

function cents(value) {
    return Math.round(Number(value) * 100);
}

function money(value) {
    return (cents(value) / 100).toFixed(2);
}

// The payload is the exact text that is hashed. It holds every column of
// the entry and every line, so the stored columns can be checked against it.
function payloadOf({ createdAt, kind, transactionId, memo, lines }) {
    return JSON.stringify([createdAt, kind, transactionId || null, memo || null,
        lines.map(([acct, amount]) => [acct, money(amount)])]);
}

// Posts one entry inside the caller's database transaction.
//   lines: [[account, amount], ...] with amounts that add up to zero.
async function post(connection, { kind, transactionId = null, memo = null, lines }) {
    const clean = lines.filter(([, amount]) => cents(amount) !== 0);
    if (!clean.length) return null;
    const total = clean.reduce((sum, [, amount]) => sum + cents(amount), 0);
    if (total !== 0) {
        throw new Error(`Unbalanced journal entry (${kind}): lines add up to ${money(total / 100)}`);
    }

    const head = await lockHead(connection, 'journal');
    if (!head.openedAt) {
        throw new Error('The journal has not been opened. Restart the server or run node scripts/migrate.js.');
    }

    const createdAt = nowStamp();
    const payload = payloadOf({ createdAt, kind, transactionId, memo, lines: clean });
    const hash = linkHash(head.lastHash, payload);

    const [result] = await connection.execute(
        `INSERT INTO journal_entries (created_at, kind, transaction_id, memo, payload, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [createdAt, kind, transactionId, memo, payload, head.lastHash, hash]
    );
    const entryId = result.insertId;
    await connection.query(
        'INSERT INTO journal_lines (entry_id, account, amount) VALUES ?',
        [clean.map(([acct, amount]) => [entryId, acct, money(amount)])]
    );
    await moveHead(connection, 'journal', entryId, hash);
    return entryId;
}

// The account on the other side of a single-wallet movement, from the
// type recorded in the transaction's metadata.
function counterFor(meta) {
    switch (meta.type) {
        case 'deposit': return account.external('cash');
        case 'payment': return account.external('merchants');
        case 'mpesa_deposit': return account.external('mpesa');
        case 'savings_deposit':
        case 'savings_release': return account.savings(meta.vault_id);
        case 'loan_disbursement':
        case 'loan_repayment': return account.loan(meta.loan_id);
        case 'chama_contribution':
        case 'chama_payout': return account.chama(meta.chama_id);
        default:
            throw new Error(`No journal account is defined for "${meta.type}"`);
    }
}

// Records the balances that existed before the journal was started, once.
// Must run before the server accepts requests.
async function ensureOpened() {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const head = await lockHead(connection, 'journal');
        if (head.openedAt) {
            await connection.commit();
            return { opened: false };
        }
        const lines = [];
        const [wallets] = await connection.query('SELECT id, balance FROM wallets WHERE balance <> 0');
        wallets.forEach(w => lines.push([account.wallet(w.id), w.balance]));
        const [vaults] = await connection.query('SELECT id, balance FROM savings_vaults WHERE balance <> 0');
        vaults.forEach(v => lines.push([account.savings(v.id), v.balance]));
        const [loans] = await connection.query('SELECT id, amount_repaid - principal AS position FROM loans');
        loans.forEach(l => lines.push([account.loan(l.id), l.position]));
        const [held] = await connection.query(
            "SELECT id, amount FROM transactions WHERE status = 'pending' AND sender_wallet_id IS NOT NULL");
        held.forEach(t => lines.push([account.held(t.id), t.amount]));
        const [chamas] = await connection.query('SELECT id, balance FROM chamas WHERE balance <> 0');
        chamas.forEach(c => lines.push([account.chama(c.id), c.balance]));

        const total = lines.reduce((sum, [, amount]) => sum + cents(amount), 0);
        if (total !== 0) lines.push([account.opening, -total / 100]);

        // Mark the journal open first, so post() accepts the opening entry.
        await connection.execute("UPDATE chain_heads SET opened_at = NOW() WHERE name = 'journal'");
        const entryId = lines.length
            ? await post(connection, { kind: 'opening_balances', memo: 'Balances before the journal started', lines })
            : null;
        await connection.commit();
        return { opened: true, entryId, accounts: lines.length };
    } catch (error) {
        await connection.rollback().catch(() => {});
        throw error;
    } finally {
        connection.release();
    }
}

// Before test or lab accounts are deleted, moves whatever their accounts
// still hold to external:closed, so the journal stays consistent with
// wallets that no longer exist. Runs inside the caller's transaction.
async function closeAccounts(connection, { walletIds = [], chamaIds = [] }, memo) {
    const accounts = [];
    if (walletIds.length) {
        walletIds.forEach(id => accounts.push(account.wallet(id)));
        const [vaults] = await connection.query('SELECT id FROM savings_vaults WHERE wallet_id IN (?)', [walletIds]);
        vaults.forEach(v => accounts.push(account.savings(v.id)));
        const [loans] = await connection.query('SELECT id FROM loans WHERE wallet_id IN (?)', [walletIds]);
        loans.forEach(l => accounts.push(account.loan(l.id)));
        const [txs] = await connection.query(
            `SELECT id FROM transactions WHERE status = 'pending'
               AND (sender_wallet_id IN (?) OR receiver_wallet_id IN (?))`, [walletIds, walletIds]);
        txs.forEach(t => accounts.push(account.held(t.id)));
    }
    chamaIds.forEach(id => accounts.push(account.chama(id)));
    if (!accounts.length) return null;

    const [sums] = await connection.query(
        `SELECT account, SUM(amount) AS total FROM journal_lines
         WHERE account IN (?) GROUP BY account HAVING SUM(amount) <> 0`, [accounts]);
    if (!sums.length) return null;
    const lines = sums.map(row => [row.account, -Number(row.total)]);
    const total = lines.reduce((sum, [, amount]) => sum + cents(amount), 0);
    lines.push([account.external('closed'), -total / 100]);
    return post(connection, { kind: 'close_accounts', memo, lines });
}

module.exports = { account, post, counterFor, ensureOpened, closeAccounts, payloadOf, money, cents };
