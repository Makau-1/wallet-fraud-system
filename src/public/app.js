// SecureWallet front end. One script serves every page; each page's
// code runs only when that page's elements are present.

// --------------------------------------------------
// Shared helpers
// --------------------------------------------------

async function api(path, options = {}) {
    const response = await fetch(path, {
        credentials: 'same-origin',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        ...options,
    });

    let data = {};
    try {
        data = await response.json();
    } catch (error) {
        data = {};
    }

    if (!response.ok) {
        const error = new Error(data.message || `Request failed (${response.status})`);
        error.status = response.status;
        throw error;
    }

    return data;
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
}

function setMessage(node, text, kind) {
    node.textContent = text || '';
    node.className = 'message' + (kind ? ' ' + kind : '');
}

function formatMoney(value) {
    return Number(value).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function formatDate(value) {
    const date = new Date(value);
    return date.toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function parseMeta(meta) {
    if (!meta) return {};
    if (typeof meta === 'object') return meta;
    try {
        return JSON.parse(meta);
    } catch (error) {
        return {};
    }
}

// Ten-bar meter filled in proportion to a 0–1 score.
function meter(score) {
    const wrap = el('span', 'meter');
    wrap.setAttribute('aria-hidden', 'true');
    const filled = Math.max(1, Math.round(score * 10));
    for (let i = 0; i < 10; i += 1) {
        wrap.appendChild(el('i', i < filled ? 'on' : ''));
    }
    return wrap;
}

// Sends signed-in users to the right page, or signed-out users to sign in.
async function requireUser(role) {
    try {
        const { user } = await api('/api/auth/me');
        if (role && user.role !== role) {
            window.location.href = user.role === 'admin' ? 'admin.html' : 'dashboard.html';
            return null;
        }
        return user;
    } catch (error) {
        window.location.href = 'index.html';
        return null;
    }
}

function wireLogout() {
    const button = document.getElementById('logoutButton');
    if (!button) return;
    button.addEventListener('click', async () => {
        button.disabled = true;
        try {
            await api('/api/auth/logout', { method: 'POST' });
        } finally {
            window.location.href = 'index.html';
        }
    });
}

// --------------------------------------------------
// Sign in
// --------------------------------------------------

const loginForm = document.getElementById('loginForm');

if (loginForm) {
    const message = document.getElementById('message');
    const params = new URLSearchParams(window.location.search);

    if (params.get('registered') === '1') {
        setMessage(message, 'Account created. Sign in to open your wallet.', 'success');
    }

    loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();

        const button = document.getElementById('loginButton');
        const email = document.getElementById('email').value.trim();
        const password = document.getElementById('password').value;

        if (!email || !password) {
            setMessage(message, 'Enter your email address and password.', 'error');
            return;
        }

        setMessage(message, '');
        button.disabled = true;
        button.textContent = 'Signing in…';

        try {
            const data = await api('/api/auth/login', {
                method: 'POST',
                body: JSON.stringify({ email, password }),
            });

            window.location.href = data.user.role === 'admin' ? 'admin.html' : 'dashboard.html';
        } catch (error) {
            setMessage(message, error.status ? error.message : 'Could not reach the server. Check that it is running.', 'error');
            button.disabled = false;
            button.textContent = 'Sign in';
        }
    });
}

// --------------------------------------------------
// Create an account
// --------------------------------------------------

const registerForm = document.getElementById('registerForm');

if (registerForm) {
    const message = document.getElementById('message');

    registerForm.addEventListener('submit', async (event) => {
        event.preventDefault();

        const button = document.getElementById('registerButton');
        const name = document.getElementById('name').value.trim();
        const email = document.getElementById('email').value.trim();
        const password = document.getElementById('password').value;

        if (!name || !email || !password) {
            setMessage(message, 'Fill in your name, email address and password.', 'error');
            return;
        }

        if (password.length < 8) {
            setMessage(message, 'Use a password of at least 8 characters.', 'error');
            return;
        }

        setMessage(message, '');
        button.disabled = true;
        button.textContent = 'Creating account…';

        try {
            await api('/api/auth/register', {
                method: 'POST',
                body: JSON.stringify({ name, email, password }),
            });

            window.location.href = 'index.html?registered=1';
        } catch (error) {
            setMessage(message, error.status ? error.message : 'Could not reach the server. Check that it is running.', 'error');
            button.disabled = false;
            button.textContent = 'Create account';
        }
    });
}

// --------------------------------------------------
// Wallet dashboard
// --------------------------------------------------

if (document.body.dataset.page === 'dashboard') {
    wireLogout();

    const ACTIONS = {
        deposit: {
            path: '/api/wallet/deposit',
            button: 'Deposit money',
            done: 'Deposited',
            hint: 'Adds money to your wallet.',
        },
        withdraw: {
            path: '/api/wallet/withdraw',
            button: 'Withdraw money',
            done: 'Withdrew',
            hint: 'Takes money out of your wallet. Withdrawals are checked for fraud.',
        },
        transfer: {
            path: '/api/wallet/transfer',
            button: 'Send money',
            done: 'Sent',
            hint: 'Sends money to another SecureWallet user. Transfers are checked for fraud.',
        },
    };

    let action = 'deposit';
    let page = 1;
    let currency = 'USD';

    const txList = document.getElementById('txList');
    const moreWrap = document.getElementById('moreWrap');
    const moveForm = document.getElementById('moveForm');
    const moveButton = document.getElementById('moveButton');
    const moveMessage = document.getElementById('moveMessage');

    function describe(tx) {
        const other = tx.counterparty && (tx.counterparty.name || tx.counterparty.email);
        if (tx.type === 'deposit') return 'Deposit';
        if (tx.type === 'withdrawal') return 'Withdrawal';
        return tx.direction === 'out' ? `Sent to ${other || 'another user'}` : `Received from ${other || 'another user'}`;
    }

    function fraudCheck(tx) {
        const check = el('div', 'check');

        if (tx.direction !== 'out' || tx.type === 'deposit' || !tx.fraud_check) {
            return null;
        }

        const fc = tx.fraud_check;

        if (fc.scoring_status !== 'scored' || fc.fraud_score === null) {
            check.appendChild(el('span', 'label', 'Fraud check unavailable when this was made'));
            return check;
        }

        const score = fc.fraud_score;
        let text;

        if (fc.alert_status === 'confirmed_fraud') {
            check.classList.add('fraud');
            text = 'Confirmed as fraud';
        } else if (fc.alert_status === 'cleared') {
            check.classList.add('low');
            text = 'Reviewed and cleared';
        } else if (fc.alert_status === 'pending' || score >= 0.5) {
            check.classList.add('high');
            text = 'Flagged for review';
        } else {
            check.classList.add('low');
            text = 'Fraud check passed';
        }

        check.appendChild(meter(score));
        check.appendChild(el('span', 'label', `${text} (risk ${score.toFixed(2)})`));
        return check;
    }

    function renderTx(tx) {
        const item = el('li', 'tx');
        const credit = tx.direction === 'in';

        item.appendChild(el('div', 'tx-title', describe(tx)));
        item.appendChild(el('div', 'tx-amount' + (credit ? ' credit' : ''),
            `${credit ? '+' : '−'}${formatMoney(tx.amount)}`));

        const meta = el('div', 'tx-meta', formatDate(tx.created_at));
        item.appendChild(meta);
        item.appendChild(el('div'));

        const check = fraudCheck(tx);
        if (check) {
            check.style.gridColumn = '1 / -1';
            item.appendChild(check);
        }

        return item;
    }

    async function loadBalance() {
        const data = await api('/api/wallet/balance');
        currency = data.currency || 'USD';
        document.getElementById('balance').textContent = formatMoney(data.balance);
        document.getElementById('currency').textContent = currency;
        document.getElementById('walletSerial').textContent = 'No. ' + String(data.walletId).padStart(6, '0');
    }

    async function loadHistory(reset) {
        if (reset) {
            page = 1;
            txList.replaceChildren();
        }

        const data = await api(`/api/wallet/history?page=${page}&limit=10`);

        if (data.totalTransactions === 0) {
            txList.replaceChildren(el('li', 'empty', 'No activity yet. Make a deposit to start using your wallet.'));
        } else {
            data.transactions.forEach(tx => txList.appendChild(renderTx(tx)));
        }

        document.getElementById('activityCount').textContent =
            data.totalTransactions === 1 ? '1 transaction' : `${data.totalTransactions} transactions`;

        moreWrap.hidden = page >= data.totalPages;
    }

    function selectAction(next) {
        action = next;
        document.querySelectorAll('.segmented button').forEach(button => {
            button.setAttribute('aria-selected', String(button.dataset.action === next));
        });
        document.getElementById('recipientField').hidden = next !== 'transfer';
        moveForm.setAttribute('aria-labelledby', `tab-${next}`);
        moveButton.textContent = ACTIONS[next].button;
        document.getElementById('actionHint').textContent = ACTIONS[next].hint;
        setMessage(moveMessage, '');
    }

    document.querySelectorAll('.segmented button').forEach(button => {
        button.addEventListener('click', () => selectAction(button.dataset.action));
    });

    document.getElementById('moreButton').addEventListener('click', async () => {
        page += 1;
        await loadHistory(false);
    });

    moveForm.addEventListener('submit', async (event) => {
        event.preventDefault();

        const rawAmount = document.getElementById('amount').value.trim();
        const amount = Number(rawAmount);
        const recipientEmail = document.getElementById('recipientEmail').value.trim();

        if (!/^\d+(\.\d{1,2})?$/.test(rawAmount)) {
            setMessage(moveMessage, 'Enter an amount with at most two decimal places, for example 150 or 99.50.', 'error');
            return;
        }

        if (!Number.isFinite(amount) || amount <= 0) {
            setMessage(moveMessage, 'Enter an amount greater than 0.', 'error');
            return;
        }

        if (action === 'transfer' && !recipientEmail) {
            setMessage(moveMessage, "Enter the recipient's email address.", 'error');
            return;
        }

        const body = action === 'transfer' ? { recipientEmail, amount } : { amount };

        moveButton.disabled = true;
        setMessage(moveMessage, action === 'deposit' ? 'Processing…' : 'Processing and checking for fraud…');

        try {
            await api(ACTIONS[action].path, { method: 'POST', body: JSON.stringify(body) });
            const target = action === 'transfer' ? ` to ${recipientEmail}` : '';
            setMessage(moveMessage, `${ACTIONS[action].done} ${currency} ${formatMoney(amount)}${target}.`, 'success');
            moveForm.reset();
            await Promise.all([loadBalance(), loadHistory(true)]);
        } catch (error) {
            if (error.status === 401) {
                window.location.href = 'index.html';
                return;
            }
            setMessage(moveMessage, error.status ? error.message : 'Could not reach the server. Check that it is running.', 'error');
        } finally {
            moveButton.disabled = false;
        }
    });

    (async () => {
        const user = await requireUser('user');
        if (!user) return;
        document.getElementById('userName').textContent = user.name;
        document.getElementById('holderName').textContent = user.name;
        try {
            await Promise.all([loadBalance(), loadHistory(true)]);
        } catch (error) {
            txList.replaceChildren(el('li', 'empty', 'Could not load your wallet. Refresh the page to try again.'));
        }
    })();
}

// --------------------------------------------------
// Fraud review (administrator)
// --------------------------------------------------

if (document.body.dataset.page === 'admin') {
    wireLogout();

    let status = 'pending';
    const list = document.getElementById('alertList');
    const adminMessage = document.getElementById('adminMessage');

    const EMPTY = {
        pending: 'No alerts are waiting for review. New ones appear here when the model flags a transfer or withdrawal.',
        confirmed_fraud: 'No alerts have been confirmed as fraud yet.',
        cleared: 'No alerts have been dismissed yet.',
    };

    function row(label, value) {
        const frag = document.createDocumentFragment();
        frag.appendChild(el('dt', null, label));
        frag.appendChild(el('dd', null, value));
        return frag;
    }

    function renderAlert(alert) {
        const meta = parseMeta(alert.metadata);
        const type = meta.type === 'withdrawal' ? 'Withdrawal' : 'Transfer';
        const score = Number(alert.score);
        const item = el('li', `alert ${alert.status}`);

        const scoreBox = el('div', 'score');
        scoreBox.appendChild(el('div', 'figure', score.toFixed(2)));
        const check = el('div', 'check ' + (alert.status === 'confirmed_fraud' ? 'fraud' : alert.status === 'cleared' ? 'low' : 'high'));
        check.appendChild(meter(score));
        scoreBox.appendChild(check);
        scoreBox.appendChild(el('div', 'caption', 'Fraud score'));
        item.appendChild(scoreBox);

        const body = el('div');
        const who = alert.sender_name || alert.sender_email || 'Unknown sender';
        body.appendChild(el('h3', null, `${type} of ${alert.currency || 'USD'} ${formatMoney(alert.amount)} by ${who}`));

        const dl = el('dl');
        dl.appendChild(row('From', alert.sender_email || 'Unknown'));
        if (meta.type !== 'withdrawal') {
            dl.appendChild(row('To', alert.receiver_email || 'Unknown'));
        }
        if (meta.sender_balance_before !== undefined) {
            dl.appendChild(row('Sender balance',
                `${formatMoney(meta.sender_balance_before)} before, ${formatMoney(meta.sender_balance_after)} after`));
        }
        dl.appendChild(row('Made', formatDate(alert.transaction_time)));
        dl.appendChild(row('Transaction', `#${alert.transaction_id}`));
        body.appendChild(dl);
        item.appendChild(body);

        if (alert.status === 'pending') {
            const actions = el('div', 'actions');
            const confirmButton = el('button', 'danger', 'Confirm fraud');
            const dismissButton = el('button', 'quiet', 'Dismiss');
            confirmButton.type = 'button';
            dismissButton.type = 'button';
            confirmButton.addEventListener('click', () => decide(alert.id, 'confirmed_fraud', [confirmButton, dismissButton]));
            dismissButton.addEventListener('click', () => decide(alert.id, 'cleared', [confirmButton, dismissButton]));
            actions.append(confirmButton, dismissButton);
            item.appendChild(actions);
        } else {
            const decision = el('div', 'decision');
            decision.appendChild(el('strong', null, alert.status === 'confirmed_fraud' ? 'Confirmed fraud' : 'Dismissed'));
            decision.appendChild(document.createTextNode(
                `by ${alert.reviewed_by_name || 'an administrator'}${alert.reviewed_at ? ', ' + formatDate(alert.reviewed_at) : ''}`));
            item.appendChild(decision);
        }

        return item;
    }

    async function load() {
        try {
            const data = await api(`/api/admin/fraud-alerts?status=${status}`);
            Object.entries(data.counts).forEach(([key, value]) => {
                const counter = document.getElementById(`count-${key}`);
                if (counter) counter.textContent = value;
            });
            if (data.alerts.length === 0) {
                list.replaceChildren(el('li', 'empty', EMPTY[status]));
            } else {
                list.replaceChildren(...data.alerts.map(renderAlert));
            }
        } catch (error) {
            if (error.status === 401 || error.status === 403) {
                window.location.href = 'index.html';
                return;
            }
            list.replaceChildren(el('li', 'empty', 'Could not load alerts. Refresh the page to try again.'));
        }
    }

    async function decide(id, decision, buttons) {
        buttons.forEach(button => { button.disabled = true; });
        try {
            await api(`/api/admin/fraud-alerts/${id}/status`, {
                method: 'PATCH',
                body: JSON.stringify({ status: decision }),
            });
            setMessage(adminMessage, decision === 'confirmed_fraud'
                ? `Alert #${id} confirmed as fraud.`
                : `Alert #${id} dismissed.`, 'success');
            await load();
        } catch (error) {
            setMessage(adminMessage, error.message, 'error');
            buttons.forEach(button => { button.disabled = false; });
        }
    }

    document.querySelectorAll('.tabs button').forEach(button => {
        button.addEventListener('click', () => {
            status = button.dataset.status;
            document.querySelectorAll('.tabs button').forEach(b => {
                b.setAttribute('aria-selected', String(b === button));
            });
            setMessage(adminMessage, '');
            load();
        });
    });

    (async () => {
        const user = await requireUser('admin');
        if (!user) return;
        document.getElementById('userName').textContent = user.name;
        await load();
    })();
}
