// Chamas: group savings (version 3).
//
// A chama is a savings group with a shared pot. The person who creates it
// is its chair and invites members by email. Members contribute from their
// wallets, and everyone can see who has contributed what. Money leaves the
// pot only through a payout that a majority of active members approve
// (the member who proposes it counts as one approval), so no single
// member, including the chair, can empty the pot alone.
//
// The pot is its own account in the double-entry journal (chama:<id>).

const db = require('../config/db');
const events = require('../services/events');
const audit = require('../services/audit');
const {
    ServiceError, checkAmount, withTransaction, walletForUser, debit, credit, handle, round2,
} = require('../services/ledger');

const MAX_MEMBERS = 50;

function required(activeMembers) {
    return Math.max(1, Math.floor(activeMembers / 2) + 1);
}

async function membership(chamaId, userId, connection = db) {
    const [rows] = await connection.execute(
        'SELECT role, status, joined_at FROM chama_members WHERE chama_id = ? AND user_id = ?', [chamaId, userId]);
    return rows[0] || null;
}

async function activeMemberIds(chamaId, connection = db) {
    const [rows] = await connection.execute(
        "SELECT user_id FROM chama_members WHERE chama_id = ? AND status = 'active'", [chamaId]);
    return rows.map(r => r.user_id);
}

const list = handle('Chama', async (req, res) => {
    const [rows] = await db.execute(
        `SELECT c.id, c.name, c.purpose, c.goal_amount, c.contribution_amount, c.balance, m.role, m.status,
                (SELECT COUNT(*) FROM chama_members x WHERE x.chama_id = c.id AND x.status = 'active') AS members,
                (SELECT COUNT(*) FROM chama_payouts p WHERE p.chama_id = c.id AND p.status = 'proposed') AS open_payouts
         FROM chama_members m JOIN chamas c ON c.id = m.chama_id
         WHERE m.user_id = ? AND m.status IN ('active', 'invited')
         ORDER BY m.status = 'invited' DESC, c.created_at DESC`, [req.session.userId]);
    res.json({ chamas: rows });
});

const create = handle('Chama', async (req, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 80) throw new ServiceError(400, 'Give the chama a name of up to 80 characters');
    const purpose = typeof req.body.purpose === 'string' ? req.body.purpose.trim().slice(0, 200) : null;
    const goal = req.body.goalAmount === undefined || req.body.goalAmount === null || req.body.goalAmount === '' ? null : checkAmount(Number(req.body.goalAmount), 100000000);
    const contribution = req.body.contributionAmount === undefined || req.body.contributionAmount === null || req.body.contributionAmount === '' ? null : checkAmount(Number(req.body.contributionAmount));
    const id = await withTransaction(async (connection) => {
        const [created] = await connection.execute(
            'INSERT INTO chamas (name, purpose, goal_amount, contribution_amount, created_by) VALUES (?, ?, ?, ?, ?)',
            [name, purpose || null, goal, contribution, req.session.userId]);
        await connection.execute(
            "INSERT INTO chama_members (chama_id, user_id, role, status, joined_at) VALUES (?, ?, 'chair', 'active', NOW())",
            [created.insertId, req.session.userId]);
        return created.insertId;
    });
    res.status(201).json({ id });
});

const detail = handle('Chama', async (req, res) => {
    const chamaId = Number(req.params.id);
    const me = await membership(chamaId, req.session.userId);
    if (!me || me.status === 'left') throw new ServiceError(404, 'Chama not found');
    const [[chama]] = await db.execute('SELECT * FROM chamas WHERE id = ?', [chamaId]);
    const [members] = await db.execute(
        `SELECT u.id, u.name, u.email, m.role, m.status, m.joined_at,
                COALESCE((SELECT SUM(t.amount) FROM transactions t JOIN wallets w ON w.id = t.sender_wallet_id
                   WHERE w.user_id = u.id AND JSON_UNQUOTE(JSON_EXTRACT(t.metadata, '$.type')) = 'chama_contribution'
                     AND JSON_EXTRACT(t.metadata, '$.chama_id') = ?), 0) AS contributed,
                COALESCE((SELECT SUM(p.amount) FROM chama_payouts p WHERE p.chama_id = ? AND p.recipient_id = u.id AND p.status = 'paid'), 0) AS received
         FROM chama_members m JOIN users u ON u.id = m.user_id
         WHERE m.chama_id = ? AND m.status <> 'left' ORDER BY m.role = 'chair' DESC, m.joined_at`,
        [chamaId, chamaId, chamaId]);
    const [payouts] = await db.execute(
        `SELECT p.id, p.amount, p.reason, p.status, p.required_approvals, p.created_at, p.decided_at,
                r.name AS recipient_name, pr.name AS proposed_by_name,
                (SELECT COUNT(*) FROM chama_payout_votes v WHERE v.payout_id = p.id AND v.vote = 'approve') AS approvals,
                (SELECT COUNT(*) FROM chama_payout_votes v WHERE v.payout_id = p.id AND v.vote = 'reject') AS rejections,
                (SELECT v.vote FROM chama_payout_votes v WHERE v.payout_id = p.id AND v.user_id = ?) AS my_vote
         FROM chama_payouts p JOIN users r ON r.id = p.recipient_id JOIN users pr ON pr.id = p.proposed_by
         WHERE p.chama_id = ? ORDER BY p.id DESC LIMIT 30`, [req.session.userId, chamaId]);
    const [activity] = await db.execute(
        `SELECT t.id, t.amount, t.created_at, u.name, JSON_UNQUOTE(JSON_EXTRACT(t.metadata, '$.type')) AS type
         FROM transactions t
         JOIN wallets w ON w.id = COALESCE(t.sender_wallet_id, t.receiver_wallet_id)
         JOIN users u ON u.id = w.user_id
         WHERE JSON_EXTRACT(t.metadata, '$.chama_id') = ?
         ORDER BY t.id DESC LIMIT 20`, [chamaId]);
    res.json({ chama, me, members, payouts, activity, requiredApprovals: required(members.filter(m => m.status === 'active').length) });
});

const invite = handle('Chama', async (req, res) => {
    const chamaId = Number(req.params.id);
    const me = await membership(chamaId, req.session.userId);
    if (!me || me.status !== 'active' || !['chair', 'treasurer'].includes(me.role)) {
        throw new ServiceError(403, 'Only the chair or treasurer can invite members');
    }
    const [users] = await db.execute('SELECT id, name FROM users WHERE LOWER(email) = ?', [String(req.body.email || '').trim().toLowerCase()]);
    if (!users.length) throw new ServiceError(404, 'No SecureWallet account uses that email address');
    const [[count]] = await db.execute("SELECT COUNT(*) AS n FROM chama_members WHERE chama_id = ? AND status <> 'left'", [chamaId]);
    if (Number(count.n) >= MAX_MEMBERS) throw new ServiceError(409, `A chama can have up to ${MAX_MEMBERS} members`);
    const role = req.body.role === 'treasurer' && me.role === 'chair' ? 'treasurer' : 'member';
    try {
        await db.execute(
            "INSERT INTO chama_members (chama_id, user_id, role, status, invited_by) VALUES (?, ?, ?, 'invited', ?)",
            [chamaId, users[0].id, role, req.session.userId]);
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            const [result] = await db.execute(
                "UPDATE chama_members SET status = 'invited', role = ?, invited_by = ? WHERE chama_id = ? AND user_id = ? AND status = 'left'",
                [role, req.session.userId, chamaId, users[0].id]);
            if (!result.affectedRows) throw new ServiceError(409, 'That person is already a member or has been invited');
        } else {
            throw error;
        }
    }
    const [[chama]] = await db.execute('SELECT name FROM chamas WHERE id = ?', [chamaId]);
    events.notify(users[0].id, { kind: 'chama_invite', title: `You are invited to join ${chama.name}`, body: 'Open Chamas to accept.' });
    res.status(201).json({ invited: true });
});

const respondToInvite = (accept) => handle('Chama', async (req, res) => {
    const chamaId = Number(req.params.id);
    const [result] = await db.execute(
        `UPDATE chama_members SET status = ?, joined_at = IF(?, NOW(), joined_at)
         WHERE chama_id = ? AND user_id = ? AND status = 'invited'`,
        [accept ? 'active' : 'left', accept, chamaId, req.session.userId]);
    if (!result.affectedRows) throw new ServiceError(404, 'There is no invitation to answer');
    res.json({ status: accept ? 'active' : 'declined' });
});

const contribute = handle('Chama', async (req, res) => {
    const chamaId = Number(req.params.id);
    const amount = checkAmount(req.body.amount);
    const wallet = await walletForUser(req.session.userId);
    const outcome = await withTransaction(async (connection) => {
        const me = await membership(chamaId, req.session.userId, connection);
        if (!me || me.status !== 'active') throw new ServiceError(403, 'Only active members can contribute');
        const [rows] = await connection.execute('SELECT id, name, balance FROM chamas WHERE id = ? FOR UPDATE', [chamaId]);
        const moved = await debit(connection, wallet.id, amount, { type: 'chama_contribution', chama_id: chamaId, chama_name: rows[0].name });
        await connection.execute('UPDATE chamas SET balance = balance + ? WHERE id = ?', [amount, chamaId]);
        return { ...moved, pot: round2(Number(rows[0].balance) + amount), name: rows[0].name };
    });
    res.json({ message: `Contributed to ${outcome.name}`, transactionId: outcome.transactionId, balance: outcome.after, pot: outcome.pot });
});

async function settle(connection, payoutId) {
    const [rows] = await connection.execute('SELECT * FROM chama_payouts WHERE id = ? FOR UPDATE', [payoutId]);
    const payout = rows[0];
    if (!payout || payout.status !== 'proposed') return null;
    const [[votes]] = await connection.execute(
        "SELECT SUM(vote = 'approve') AS yes, SUM(vote = 'reject') AS no FROM chama_payout_votes WHERE payout_id = ?", [payoutId]);
    const [[eligible]] = await connection.execute(
        "SELECT COUNT(*) AS n FROM chama_members WHERE chama_id = ? AND status = 'active' AND joined_at <= ?",
        [payout.chama_id, payout.created_at]);
    const active = Number(eligible.n);
    const needed = Number(payout.required_approvals);
    if (Number(votes.yes || 0) >= needed) {
        const [chamaRows] = await connection.execute('SELECT name, balance FROM chamas WHERE id = ? FOR UPDATE', [payout.chama_id]);
        if (Number(chamaRows[0].balance) < Number(payout.amount)) {
            await connection.execute("UPDATE chama_payouts SET status = 'rejected', decided_at = NOW() WHERE id = ?", [payoutId]);
            return { status: 'rejected', reason: 'The pot no longer holds enough' };
        }
        const [wallets] = await connection.execute('SELECT id FROM wallets WHERE user_id = ?', [payout.recipient_id]);
        await connection.execute('UPDATE chamas SET balance = balance - ? WHERE id = ?', [payout.amount, payout.chama_id]);
        const moved = await credit(connection, wallets[0].id, Number(payout.amount), {
            type: 'chama_payout', chama_id: payout.chama_id, chama_name: chamaRows[0].name, payout_id: payoutId,
        });
        await connection.execute("UPDATE chama_payouts SET status = 'paid', transaction_id = ?, decided_at = NOW() WHERE id = ?",
            [moved.transactionId, payoutId]);
        return { status: 'paid', transactionId: moved.transactionId, recipientId: payout.recipient_id, amount: Number(payout.amount), name: chamaRows[0].name };
    }
    // Rejected once approval can no longer be reached.
    if (active - Number(votes.no || 0) < needed) {
        await connection.execute("UPDATE chama_payouts SET status = 'rejected', decided_at = NOW() WHERE id = ?", [payoutId]);
        return { status: 'rejected' };
    }
    return { status: 'proposed', approvals: Number(votes.yes || 0), needed };
}

const proposePayout = handle('Chama', async (req, res) => {
    const chamaId = Number(req.params.id);
    const amount = checkAmount(req.body.amount);
    const recipientId = Number(req.body.recipientId);
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 200) : null;
    const result = await withTransaction(async (connection) => {
        const me = await membership(chamaId, req.session.userId, connection);
        if (!me || me.status !== 'active') throw new ServiceError(403, 'Only active members can propose a payout');
        const recipient = await membership(chamaId, recipientId, connection);
        if (!recipient || recipient.status !== 'active') throw new ServiceError(400, 'The payout must go to an active member');
        const [[chama]] = await connection.execute('SELECT balance FROM chamas WHERE id = ? FOR UPDATE', [chamaId]);
        if (amount > Number(chama.balance)) throw new ServiceError(400, `The pot holds ${Number(chama.balance).toFixed(2)}`);
        const needed = required((await activeMemberIds(chamaId, connection)).length);
        const [created] = await connection.execute(
            'INSERT INTO chama_payouts (chama_id, amount, recipient_id, reason, required_approvals, proposed_by) VALUES (?, ?, ?, ?, ?, ?)',
            [chamaId, amount, recipientId, reason, needed, req.session.userId]);
        await connection.execute("INSERT INTO chama_payout_votes (payout_id, user_id, vote) VALUES (?, ?, 'approve')", [created.insertId, req.session.userId]);
        const outcome = await settle(connection, created.insertId);
        return { id: created.insertId, needed, ...outcome };
    });
    const members = await activeMemberIds(chamaId);
    members.filter(id => String(id) !== String(req.session.userId)).forEach(id => events.notify(id, {
        kind: 'chama_payout', title: `A payout of KES ${amount.toFixed(2)} needs your vote`, body: reason || null,
    }));
    if (result.status === 'paid') {
        events.notify(result.recipientId, { kind: 'chama_paid', title: `You received KES ${result.amount.toFixed(2)} from ${result.name}` });
    }
    await audit.record({ ...audit.actor(req), action: 'chama.payout_propose', targetType: 'chama', targetId: chamaId, details: { payoutId: result.id, amount } });
    res.status(201).json(result);
});

const vote = handle('Chama', async (req, res) => {
    const payoutId = Number(req.params.payoutId);
    const choice = req.body.vote === 'approve' ? 'approve' : req.body.vote === 'reject' ? 'reject' : null;
    if (!choice) throw new ServiceError(400, 'Vote approve or reject');
    const result = await withTransaction(async (connection) => {
        const [rows] = await connection.execute('SELECT chama_id, status, created_at FROM chama_payouts WHERE id = ? FOR UPDATE', [payoutId]);
        if (!rows.length) throw new ServiceError(404, 'Payout not found');
        if (rows[0].status !== 'proposed') throw new ServiceError(409, 'This payout has already been decided');
        const me = await membership(rows[0].chama_id, req.session.userId, connection);
        if (!me || me.status !== 'active') throw new ServiceError(403, 'Only active members can vote');
        // Only members who had already joined when the payout was proposed
        // may vote on it, so accounts invited afterwards cannot tip it.
        if (!me.joined_at || new Date(me.joined_at) > new Date(rows[0].created_at)) {
            throw new ServiceError(403, 'Only members who had joined when this payout was proposed can vote on it');
        }
        try {
            await connection.execute('INSERT INTO chama_payout_votes (payout_id, user_id, vote) VALUES (?, ?, ?)', [payoutId, req.session.userId, choice]);
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') throw new ServiceError(409, 'You have already voted on this payout');
            throw error;
        }
        return settle(connection, payoutId);
    });
    if (result.status === 'paid') {
        events.notify(result.recipientId, { kind: 'chama_paid', title: `You received KES ${result.amount.toFixed(2)} from ${result.name}` });
    }
    res.json(result);
});

module.exports = { list, create, detail, invite, accept: respondToInvite(true), decline: respondToInvite(false), contribute, proposePayout, vote, required };
