// SecureWallet front end (a Webmasters project). One script serves every
// page; each page's code runs only when that page's elements are present.

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
    return new Date(value).toLocaleString('en-GB', {
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

function reference(id) {
    return 'SW-' + String(id).padStart(6, '0');
}

function dotLabel(kind, text) {
    const frag = document.createDocumentFragment();
    frag.appendChild(el('span', 'dot ' + kind));
    frag.appendChild(document.createTextNode(text));
    return frag;
}

// Ten-bar meter filled in proportion to a 0-1 score.
function meter(score, tone) {
    const wrap = el('span', 'meter ' + (tone || ''));
    wrap.setAttribute('aria-hidden', 'true');
    const filled = Math.max(1, Math.round(score * 10));
    for (let i = 0; i < 10; i += 1) {
        wrap.appendChild(el('i', i < filled ? 'on' : ''));
    }
    return wrap;
}

// Shows the text name if the logo file has not been added to public/img.
function brandFallback() {
    document.querySelectorAll('.brand-logo').forEach(img => {
        const swap = () => img.replaceWith(el('span', 'brand-fallback', 'Webmasters'));
        if (img.complete && img.naturalWidth === 0) swap();
        else img.addEventListener('error', swap, { once: true });
    });
}
brandFallback();

// Service status for the console panels.
const STATUS_TEXT = {
    operational: ['ok', 'Operational'],
    degraded: ['warn', 'Degraded'],
    down: ['bad', 'Down'],
    unavailable: ['bad', 'Unavailable'],
};

async function loadStatus() {
    let status;
    try {
        status = await api('/api/status');
    } catch (error) {
        status = { wallet: 'down', database: 'down', scoring: 'unavailable' };
    }

    document.querySelectorAll('[data-service]').forEach(node => {
        const [kind, text] = STATUS_TEXT[status[node.dataset.service]] || ['idle', 'Unknown'];
        node.replaceChildren(dotLabel(kind, text));
    });

    const scoring = document.getElementById('scoringStatus');
    if (scoring) {
        const up = status.scoring === 'operational';
        scoring.replaceChildren(dotLabel(up ? 'ok' : 'bad', up ? 'Fraud monitoring on' : 'Scoring unavailable'));
        scoring.title = up
            ? 'Transfers and withdrawals are being scored by the fraud model.'
            : 'The fraud model is not reachable. Transactions still complete and are marked unscored.';
    }

    const time = document.getElementById('statusTime');
    if (time && status.checked_at) {
        time.textContent = new Date(status.checked_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    }

    return status;
}

if (document.querySelector('[data-service], #scoringStatus')) loadStatus();

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
            done: 'Deposit received',
            hint: 'Adds money to your wallet.',
        },
        withdraw: {
            path: '/api/wallet/withdraw',
            button: 'Review withdrawal',
            done: 'Withdrawal made',
            hint: 'Takes money out of your wallet. Withdrawals are checked for fraud.',
        },
        transfer: {
            path: '/api/wallet/transfer',
            button: 'Review transfer',
            done: 'Transfer sent',
            hint: 'Sends money to another SecureWallet user. Transfers are checked for fraud.',
        },
    };

    // Moving this share of the balance or more in one go triggers the warning.
    // In testing, transfers that empty the sender's wallet scored well above
    // the alert threshold while small transfers scored low.
    const LARGE_SHARE = 0.9;

    let action = 'deposit';
    let page = 1;
    let currency = 'USD';
    let balance = 0;
    let pending = null;
    const loaded = new Map();

    const txList = document.getElementById('txList');
    const moreWrap = document.getElementById('moreWrap');
    const moveForm = document.getElementById('moveForm');
    const moveButton = document.getElementById('moveButton');
    const moveMessage = document.getElementById('moveMessage');
    const reviewPanel = document.getElementById('reviewPanel');
    const receipt = document.getElementById('receipt');

    // ---------- toast ----------
    let toastTimer;
    function toast(title, detail, flagged) {
        const node = document.getElementById('toast');
        document.getElementById('toastTitle').textContent = title;
        document.getElementById('toastDetail').textContent = detail;
        node.querySelector('.toast-icon').textContent = flagged ? '!' : '✓';
        node.classList.toggle('flagged', !!flagged);
        node.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => node.classList.remove('show'), 5200);
    }

    // ---------- fraud check state for an outgoing transaction ----------
    function checkState(tx) {
        if (tx.direction !== 'out' || tx.type === 'deposit' || !tx.fraud_check) return null;
        const fc = tx.fraud_check;
        if (fc.scoring_status !== 'scored' || fc.fraud_score === null) {
            return { tone: '', dot: 'idle', label: 'Not scored', long: 'Not scored: the fraud model was unavailable when this was made.' };
        }
        const score = fc.fraud_score;
        if (fc.alert_status === 'confirmed_fraud') {
            return { score, tone: 'fraud', dot: 'bad', label: 'Confirmed fraud', long: 'An analyst confirmed this transaction as fraud.' };
        }
        if (fc.alert_status === 'cleared') {
            return { score, tone: 'low', dot: 'safe', label: 'Reviewed, cleared', long: 'An analyst reviewed this transaction and cleared it.' };
        }
        if (fc.alert_status === 'pending') {
            return { score, tone: 'high', dot: 'ok', label: 'Under review', long: 'Under review: your money has moved and an analyst is checking this transaction.' };
        }
        return { score, tone: 'low', dot: 'safe', label: 'Check passed', long: 'Fraud check passed.' };
    }

    function describe(tx) {
        const other = tx.counterparty && (tx.counterparty.name || tx.counterparty.email);
        if (tx.type === 'deposit') return 'Deposit';
        if (tx.type === 'withdrawal') return 'Withdrawal';
        return tx.direction === 'out' ? `Sent to ${other || 'another user'}` : `Received from ${other || 'another user'}`;
    }

    function renderTx(tx) {
        const li = el('li');
        const item = el('button', 'tx');
        item.type = 'button';
        item.title = 'Open receipt';
        const credit = tx.direction === 'in';

        const icon = el('span', 'tx-icon' + (credit ? ' in' : ''), tx.type === 'deposit' ? '+' : credit ? '↓' : '↑');
        icon.setAttribute('aria-hidden', 'true');
        item.appendChild(icon);
        item.appendChild(el('span', 'tx-title', describe(tx)));
        item.appendChild(el('span', 'tx-amount' + (credit ? ' credit' : ''), `${credit ? '+' : '−'}${formatMoney(tx.amount)}`));
        item.appendChild(el('span', 'tx-meta', `${formatDate(tx.created_at)} · ${reference(tx.id)}`));

        const state = checkState(tx);
        const pill = el('span', 'pill');
        if (state) {
            if (state.score !== undefined) {
                pill.appendChild(meter(state.score, state.tone));
                pill.appendChild(document.createTextNode(' '));
            }
            pill.appendChild(dotLabel(state.dot, state.label));
        }
        item.appendChild(pill);

        item.addEventListener('click', () => openReceipt(tx));
        li.appendChild(item);
        return li;
    }

    // ---------- receipt ----------
    function receiptRow(dl, label, value) {
        const row = el('div', 'row');
        row.appendChild(el('dt', null, label));
        row.appendChild(el('dd', null, value));
        dl.appendChild(row);
    }

    function openReceipt(tx) {
        const credit = tx.direction === 'in';
        document.getElementById('receiptRef').textContent = reference(tx.id);
        document.getElementById('receiptAmount').textContent = `${credit ? '+' : '−'}${tx.currency || currency} ${formatMoney(tx.amount)}`;
        document.getElementById('receiptTitle').textContent = describe(tx);

        const dl = document.getElementById('receiptRows');
        dl.replaceChildren();
        receiptRow(dl, 'Date', formatDate(tx.created_at));
        receiptRow(dl, 'Type', tx.type === 'withdrawal' ? 'Withdrawal' : tx.type === 'deposit' ? 'Deposit' : credit ? 'Transfer received' : 'Transfer sent');
        if (tx.type === 'transfer' && tx.counterparty) {
            receiptRow(dl, credit ? 'From' : 'To', tx.counterparty.email || 'Unknown');
        }
        if (tx.balance_before !== undefined) {
            receiptRow(dl, 'Balance before', formatMoney(tx.balance_before));
            receiptRow(dl, 'Balance after', formatMoney(tx.balance_after));
        }
        receiptRow(dl, 'Status', tx.status === 'completed' ? 'Completed' : tx.status);
        const state = checkState(tx);
        if (state) {
            receiptRow(dl, 'Fraud check', state.score !== undefined ? `${state.label} (risk ${state.score.toFixed(2)})` : state.label);
        }

        if (typeof receipt.showModal === 'function') receipt.showModal();
        else receipt.setAttribute('open', '');
    }

    document.getElementById('receiptClose').addEventListener('click', () => receipt.close());
    document.getElementById('receiptPrint').addEventListener('click', () => window.print());
    receipt.addEventListener('click', (event) => {
        if (event.target === receipt) receipt.close();
    });

    // ---------- balance, history, recipients, banner ----------
    async function loadBalance() {
        const data = await api('/api/wallet/balance');
        currency = data.currency || 'USD';
        balance = Number(data.balance);
        document.getElementById('balance').textContent = formatMoney(data.balance);
        document.getElementById('currency').textContent = currency;
        document.getElementById('walletSerial').textContent = 'Wallet ' + String(data.walletId).padStart(6, '0');
    }

    function refreshRecipientsAndBanner() {
        const all = [...loaded.values()];

        const seen = new Set();
        const recent = document.getElementById('recentRecipients');
        recent.replaceChildren();
        all.filter(tx => tx.type === 'transfer' && tx.direction === 'out' && tx.counterparty && tx.counterparty.email)
            .forEach(tx => {
                const email = tx.counterparty.email;
                if (seen.has(email) || seen.size >= 5) return;
                seen.add(email);
                const chip = el('button', null, tx.counterparty.name || email);
                chip.type = 'button';
                chip.title = email;
                chip.addEventListener('click', () => {
                    document.getElementById('recipientEmail').value = email;
                    document.getElementById('amount').focus();
                });
                recent.appendChild(chip);
            });

        const underReview = all.filter(tx => {
            const state = checkState(tx);
            return state && state.label === 'Under review';
        }).length;
        const banner = document.getElementById('reviewBanner');
        banner.hidden = underReview === 0;
        if (underReview) {
            banner.replaceChildren(dotLabel('ok', underReview === 1
                ? '1 of your transactions is under review. Your money has moved; an analyst is checking it.'
                : `${underReview} of your transactions are under review. Your money has moved; an analyst is checking them.`));
        }
    }

    async function loadHistory(reset) {
        if (reset) {
            page = 1;
            loaded.clear();
            txList.replaceChildren();
        }

        const data = await api(`/api/wallet/history?page=${page}&limit=10`);

        if (data.totalTransactions === 0) {
            txList.replaceChildren(el('li', 'empty', 'No activity yet. Make a deposit to start using your wallet.'));
        } else {
            data.transactions.forEach(tx => {
                loaded.set(tx.id, tx);
                txList.appendChild(renderTx(tx));
            });
        }

        document.getElementById('activityCount').textContent =
            data.totalTransactions === 1 ? '1 transaction' : `${data.totalTransactions} transactions`;

        moreWrap.hidden = page >= data.totalPages;
        refreshRecipientsAndBanner();
    }

    // ---------- move money ----------
    function showForm() {
        reviewPanel.hidden = true;
        moveForm.hidden = false;
        pending = null;
    }

    function selectAction(next) {
        action = next;
        showForm();
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

    document.getElementById('moreButton').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        if (button.disabled) return;
        button.disabled = true;
        page += 1;
        try {
            await loadHistory(false);
        } catch (error) {
            page -= 1;
        } finally {
            button.disabled = false;
        }
    });

    function showReview(amount, recipientEmail) {
        const after = Math.round((balance - amount) * 100) / 100;
        const share = balance > 0 ? amount / balance : 1;

        document.getElementById('reviewTitle').textContent = action === 'transfer'
            ? `Send ${currency} ${formatMoney(amount)}`
            : `Withdraw ${currency} ${formatMoney(amount)}`;

        const dl = document.getElementById('reviewRows');
        dl.replaceChildren();
        if (action === 'transfer') receiptRow(dl, 'To', recipientEmail);
        receiptRow(dl, 'Amount', `${currency} ${formatMoney(amount)}`);
        receiptRow(dl, 'Balance now', formatMoney(balance));
        receiptRow(dl, 'Balance after', formatMoney(after));
        receiptRow(dl, 'Share of balance', `${Math.round(share * 100)}%`);

        const notice = document.getElementById('reviewNotice');
        notice.hidden = share < LARGE_SHARE;
        if (share >= LARGE_SHARE) {
            notice.replaceChildren(
                el('strong', null, `This moves ${Math.round(share * 100)}% of your balance. `),
                document.createTextNode(action === 'transfer'
                    ? 'Transfers that empty a wallet score higher with the fraud model, so this may be held for review. Make sure you know the recipient.'
                    : 'Withdrawals that empty a wallet score higher with the fraud model, so this may be held for review.')
            );
        }

        pending = { amount, recipientEmail };
        moveForm.hidden = true;
        reviewPanel.hidden = false;
        document.getElementById('reviewConfirm').textContent = action === 'transfer' ? 'Confirm and send' : 'Confirm withdrawal';
        document.getElementById('reviewConfirm').focus();
    }

    async function submit(amount, recipientEmail) {
        const act = action;
        const body = act === 'transfer' ? { recipientEmail, amount } : { amount };
        const buttons = [moveButton, document.getElementById('reviewConfirm'), document.getElementById('reviewBack'),
            ...document.querySelectorAll('.segmented button')];
        buttons.forEach(b => { b.disabled = true; });
        const started = performance.now();
        let data;

        try {
            data = await api(ACTIONS[act].path, { method: 'POST', body: JSON.stringify(body) });
        } catch (error) {
            buttons.forEach(b => { b.disabled = false; });
            if (error.status === 401) {
                window.location.href = 'index.html';
                return;
            }
            showForm();
            setMessage(moveMessage, error.status ? error.message : 'Could not reach the server. Check that it is running.', 'error');
            loadBalance().catch(() => {});
            return;
        }

        // The money has moved. From here on nothing may report a failure,
        // or the user could retry and pay twice.
        const seconds = ((performance.now() - started) / 1000).toFixed(2);
        moveForm.reset();
        showForm();
        setMessage(moveMessage, '');
        buttons.forEach(b => { b.disabled = false; });
        document.getElementById('amount').focus();

        let state = null;
        try {
            await Promise.all([loadBalance(), loadHistory(true)]);
            const tx = loaded.get(data.transactionId);
            state = tx ? checkState(tx) : null;
        } catch (error) {
            setMessage(moveMessage, `${ACTIONS[act].done}. Refresh the page to see your updated activity.`, 'success');
        }

        let detail = `${currency} ${formatMoney(amount)} · ${reference(data.transactionId)} · ${seconds}s`;
        if (state && state.score !== undefined) detail += ` · risk ${state.score.toFixed(2)}`;
        if (state && state.label === 'Not scored') detail += ' · not scored';
        const flagged = state && state.label === 'Under review';
        toast(flagged ? `${ACTIONS[act].done}, under review` : ACTIONS[act].done, detail, flagged);
    }

    moveForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (moveButton.disabled) return;

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

        if (action !== 'deposit') {
            // Use the current balance, which may have changed in another tab or
            // through an incoming transfer since the page loaded.
            moveButton.disabled = true;
            try {
                await loadBalance();
            } catch (error) {
                // Fall back to the last known balance; the server checks again.
            } finally {
                moveButton.disabled = false;
            }
        }

        if (action !== 'deposit' && amount > balance) {
            setMessage(moveMessage, `That is more than your balance of ${currency} ${formatMoney(balance)}.`, 'error');
            return;
        }

        setMessage(moveMessage, '');

        if (action === 'deposit') {
            submit(amount);
        } else {
            showReview(amount, recipientEmail);
        }
    });

    document.getElementById('reviewBack').addEventListener('click', () => {
        showForm();
        document.getElementById('amount').focus();
    });

    document.getElementById('reviewConfirm').addEventListener('click', () => {
        if (!pending) return;
        const { amount, recipientEmail } = pending;
        pending = null;
        submit(amount, recipientEmail);
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

    // Plain-language context drawn from the transaction's recorded balances,
    // which the model scores directly. This reads the pattern for the
    // reviewer; it is not a breakdown of how the score was computed.
    function signals(alert, meta) {
        const out = [];
        const amount = Number(alert.amount);
        const before = Number(meta.sender_balance_before);
        const after = Number(meta.sender_balance_after);

        if (Number.isFinite(before) && before > 0) {
            const share = Math.round((amount / before) * 100);
            out.push([share >= 90 ? 'bad' : share >= 50 ? 'warn' : 'idle',
                `Moved ${share}% of the sender's balance in one transaction`]);
        }
        if (Number.isFinite(after) && after === 0) {
            out.push(['bad', 'Sender\'s wallet was left empty']);
        }
        if (meta.type !== 'withdrawal' && meta.receiver_balance_before !== undefined) {
            const rb = Number(meta.receiver_balance_before);
            out.push([rb === 0 ? 'warn' : 'idle', rb === 0
                ? 'Recipient\'s wallet was empty before receiving'
                : `Recipient already held ${formatMoney(rb)}`]);
        }
        if (meta.type === 'withdrawal') {
            out.push(['idle', 'Scored as a cash-out, the other transaction type in which fraud occurs']);
        }
        return out;
    }

    function renderAlert(alert) {
        const meta = parseMeta(alert.metadata);
        const type = meta.type === 'withdrawal' ? 'Withdrawal' : 'Transfer';
        const score = Number(alert.score);
        const item = el('li', `alert ${alert.status}`);
        const tone = alert.status === 'confirmed_fraud' ? 'fraud' : alert.status === 'cleared' ? 'low' : 'high';

        const scoreBox = el('div', 'score');
        scoreBox.appendChild(el('span', 'mono', 'Fraud score'));
        scoreBox.appendChild(el('div', 'figure', score.toFixed(2)));
        scoreBox.appendChild(meter(score, tone));
        item.appendChild(scoreBox);

        const body = el('div');
        const who = alert.sender_name || alert.sender_email || 'Unknown sender';
        body.appendChild(el('h3', null, `${type} of ${alert.currency || 'USD'} ${formatMoney(alert.amount)} by ${who}`));

        const dl = el('dl');
        dl.appendChild(row('From', alert.sender_email || 'Unknown'));
        if (meta.type !== 'withdrawal') dl.appendChild(row('To', alert.receiver_email || 'Unknown'));
        if (meta.sender_balance_before !== undefined) {
            dl.appendChild(row('Sender balance',
                `${formatMoney(meta.sender_balance_before)} before, ${formatMoney(meta.sender_balance_after)} after`));
        }
        dl.appendChild(row('Made', formatDate(alert.transaction_time)));
        dl.appendChild(row('Reference', reference(alert.transaction_id)));
        body.appendChild(dl);

        const found = signals(alert, meta);
        if (found.length) {
            const box = el('div', 'signals');
            box.appendChild(el('span', 'mono', 'Context for this alert'));
            const ul = el('ul');
            found.forEach(([kind, text]) => {
                const li = el('li');
                li.appendChild(dotLabel(kind, text));
                ul.appendChild(li);
            });
            box.appendChild(ul);
            box.appendChild(el('p', 'note', 'Read from the recorded balances, which the model scores. This describes the pattern; it is not a breakdown of the score.'));
            body.appendChild(box);
        }
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
                const stat = document.getElementById(`stat-${key}`);
                if (stat) stat.textContent = value;
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
