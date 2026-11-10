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

// Formats a YYYY-MM-DD date from the server without time-zone shifts.
function formatDay(value) {
    const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
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

// Line icons drawn for this project, 24x24 with a 1.8 stroke.
const ICONS = {
    send: 'M7 17 17 7M9 7h8v8',
    request: 'M17 7 7 17M15 17H7V9',
    withdraw: 'M3 7h18v10H3zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5M6.5 12h.01M17.5 12h.01',
    deposit: 'M12 5v14M5 12h14',
    bank: 'M3 10 12 4l9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18',
    paybill: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3',
    till: 'M5 8h14l-1.2 12H6.2zM9 8V6.5a3 3 0 0 1 6 0V8',
    airtime: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2',
    savings: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3M12 14.5v2',
    loan: 'M12 3v18M16 7.5c0-1.6-1.8-2.8-4-2.8s-4 1.2-4 2.8 1.8 2.5 4 2.9 4 1.3 4 3-1.8 2.8-4 2.8-4-1.2-4-2.8',
    home: 'M4 11 12 4l8 7v9h-5v-6H9v6H4z',
    shield: 'M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6zM9 12l2 2 4-4',
    statement: 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5',
};

function iconSvg(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', ICONS[name] || ICONS.send);
    svg.appendChild(path);
    return svg;
}

function paintIcons() {
    document.querySelectorAll('[data-icon]').forEach(node => {
        node.replaceChildren(iconSvg(node.dataset.icon));
    });
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
        window.location.href = 'login.html';
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
            window.location.href = 'login.html';
        }
    });
}

// --------------------------------------------------
// Landing page
// --------------------------------------------------

if (document.body.dataset.page === 'landing') {
    paintIcons();
    // Someone already signed in gets a direct way back to their wallet.
    api('/api/auth/me').then(({ user }) => {
        const target = user.role === 'admin' ? 'admin.html' : 'dashboard.html';
        const label = user.role === 'admin' ? 'Open fraud review' : 'Open my wallet';
        ['landingActions', 'heroActions', 'footerActions'].forEach(id => {
            const box = document.getElementById(id);
            if (!box) return;
            const link = el('a', 'button' + (id === 'landingActions' ? '' : ' big'), label);
            link.href = target;
            box.replaceChildren(link);
        });
    }).catch(() => {
        // Not signed in: keep the sign-in and sign-up buttons.
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

            window.location.href = 'login.html?registered=1';
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
    paintIcons();

    // Fraud-scored actions get a review step with the balance warning.
    // Payments get a plain review step. Deposits and requests go straight
    // through.
    const ACTIONS = {
        transfer: {
            title: 'Send money', fields: ['recipientEmail'], review: 'scored',
            hint: 'Sends money to another SecureWallet user. Transfers are checked for fraud.',
            done: 'Transfer sent',
            send: v => api('/api/wallet/transfer', { method: 'POST', body: JSON.stringify({ recipientEmail: v.recipientEmail, amount: v.amount }) }),
            summary: v => [['To', v.recipientEmail]],
            heading: v => `Send ${money(v.amount)}`,
        },
        request: {
            title: 'Request money', fields: ['recipientEmail', 'note'], review: null,
            hint: 'Asks another user to send you money. They can pay or decline.',
            done: 'Request sent',
            send: v => api('/api/requests', { method: 'POST', body: JSON.stringify({ email: v.recipientEmail, amount: v.amount, note: v.note }) }),
        },
        withdraw: {
            title: 'Withdraw cash', fields: [], review: 'scored',
            hint: 'Takes money out of your wallet. Withdrawals are checked for fraud.',
            done: 'Withdrawal made',
            send: v => api('/api/wallet/withdraw', { method: 'POST', body: JSON.stringify({ amount: v.amount }) }),
            summary: () => [],
            heading: v => `Withdraw ${money(v.amount)}`,
        },
        deposit: {
            title: 'Deposit', fields: [], review: null,
            hint: 'Adds money to your wallet.',
            done: 'Deposit received',
            send: v => api('/api/wallet/deposit', { method: 'POST', body: JSON.stringify({ amount: v.amount }) }),
        },
        bank: {
            title: 'Send to a bank', fields: ['bank', 'accountNumber'], review: 'scored',
            hint: 'Moves money from your wallet to a bank account. Bank transfers are checked for fraud like withdrawals.',
            done: 'Bank transfer sent',
            send: v => api('/api/payments/bank', { method: 'POST', body: JSON.stringify({ bank: v.bank, accountNumber: v.accountNumber, amount: v.amount }) }),
            summary: v => [['Bank', v.bank], ['Account', '••••' + v.accountNumber.slice(-4)]],
            heading: v => `Send ${money(v.amount)} to ${v.bank}`,
        },
        paybill: {
            title: 'Pay bill', fields: ['number', 'account'], review: 'payment', numberLabel: 'Business number', numberPlaceholder: 'For example, 888880',
            hint: 'Pays a business, such as a utility or school, using its business number.',
            done: 'Bill paid',
            send: v => api('/api/payments/bill', { method: 'POST', body: JSON.stringify({ kind: 'paybill', number: v.number, account: v.account, amount: v.amount }) }),
            summary: v => [['Business number', v.number], ['Account', v.account]],
            heading: v => `Pay ${money(v.amount)}`,
        },
        till: {
            title: 'Buy goods', fields: ['number'], review: 'payment', numberLabel: 'Till number', numberPlaceholder: 'For example, 123456',
            hint: 'Pays a shop using its till number.',
            done: 'Payment made',
            send: v => api('/api/payments/bill', { method: 'POST', body: JSON.stringify({ kind: 'till', number: v.number, amount: v.amount }) }),
            summary: v => [['Till number', v.number]],
            heading: v => `Pay ${money(v.amount)}`,
        },
        airtime: {
            title: 'Buy airtime', fields: ['number'], review: 'payment', numberLabel: 'Phone number', numberPlaceholder: '0712345678',
            hint: 'Buys airtime for any Kenyan phone number, up to 10,000 at a time.',
            done: 'Airtime bought',
            send: v => api('/api/payments/bill', { method: 'POST', body: JSON.stringify({ kind: 'airtime', number: v.number, amount: v.amount }) }),
            summary: v => [['Phone number', v.number]],
            heading: v => `Buy ${money(v.amount)} airtime`,
        },
    };

    // Moving this share of the balance or more in one go triggers the warning.
    // In testing, transfers that empty the sender's wallet scored well above
    // the alert threshold while small transfers scored low.
    const LARGE_SHARE = 0.9;
    const SCORED_TYPES = ['transfer', 'withdrawal', 'bank_transfer'];

    let action = null;
    let page = 1;
    let currency = 'USD';
    let balance = 0;
    let pending = null;
    let payingRequest = null;
    let loanInfo = null;
    const loaded = new Map();

    const $ = id => document.getElementById(id);
    const txList = $('txList');
    const actionForm = $('actionForm');
    const actionGrid = $('actionGrid');
    const moveButton = $('moveButton');
    const moveMessage = $('moveMessage');
    const reviewPanel = $('reviewPanel');
    const receipt = $('receipt');

    function money(value) {
        return `${currency} ${formatMoney(value)}`;
    }

    function handleAuth(error) {
        if (error.status === 401) {
            window.location.href = 'login.html';
            return true;
        }
        return false;
    }

    function failText(error) {
        return error.status ? error.message : 'Could not reach the server. Check that it is running.';
    }

    // ---------- toast ----------
    let toastTimer;
    function toast(title, detail, flagged) {
        const node = $('toast');
        $('toastTitle').textContent = title;
        $('toastDetail').textContent = detail || '';
        node.querySelector('.toast-icon').textContent = flagged ? '!' : '✓';
        node.classList.toggle('flagged', !!flagged);
        node.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => node.classList.remove('show'), 5200);
    }

    // ---------- views ----------
    const VIEWS = ['home', 'savings', 'loans', 'requests'];
    const VIEW_TITLES = { home: 'My wallet', savings: 'Savings goals', loans: 'Loans', requests: 'Requests' };

    function showView() {
        const view = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home';
        document.querySelectorAll('[data-view-panel]').forEach(panel => {
            panel.hidden = panel.dataset.viewPanel !== view;
        });
        document.querySelectorAll('[data-view]').forEach(link => {
            if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
            else link.removeAttribute('aria-current');
        });
        $('viewHeading').textContent = VIEW_TITLES[view];
        document.title = `SecureWallet | ${VIEW_TITLES[view]}`;
        if (view === 'savings') loadSavings().catch(() => {});
        if (view === 'loans') loadLoans().catch(() => {});
        if (view === 'requests') loadRequests().catch(() => {});
        window.scrollTo(0, 0);
    }
    window.addEventListener('hashchange', showView);

    // ---------- fraud check state for an outgoing transaction ----------
    function checkState(tx) {
        if (tx.direction !== 'out' || !SCORED_TYPES.includes(tx.type) || !tx.fraud_check) return null;
        const fc = tx.fraud_check;
        if (fc.scoring_status !== 'scored' || fc.fraud_score === null) {
            return { tone: '', dot: 'idle', label: 'Not scored', long: 'Not scored: the fraud model was unavailable when this was made.' };
        }
        const score = fc.fraud_score;
        if (fc.alert_status === 'confirmed_fraud') return { score, tone: 'fraud', dot: 'bad', label: 'Confirmed fraud' };
        if (fc.alert_status === 'cleared') return { score, tone: 'low', dot: 'safe', label: 'Reviewed, cleared' };
        if (fc.alert_status === 'pending') return { score, tone: 'high', dot: 'ok', label: 'Under review' };
        return { score, tone: 'low', dot: 'safe', label: 'Check passed' };
    }

    const KIND_LABEL = { paybill: 'Pay bill', till: 'Buy goods', airtime: 'Airtime' };

    function describe(tx) {
        const d = tx.details || {};
        const other = tx.counterparty && (tx.counterparty.name || tx.counterparty.email);
        switch (tx.type) {
            case 'deposit': return 'Deposit';
            case 'withdrawal': return 'Cash withdrawal';
            case 'bank_transfer': return `To ${d.bank || 'bank'} ${d.account_masked || ''}`.trim();
            case 'payment':
                if (d.kind === 'paybill') return `Pay bill ${d.number}${d.account ? ', account ' + d.account : ''}`;
                if (d.kind === 'till') return `Buy goods, till ${d.number}`;
                if (d.kind === 'airtime') return `Airtime for ${d.number}`;
                return 'Payment';
            case 'savings_deposit': return `Saved to ${d.vault_name || 'a goal'}`;
            case 'savings_release': return `From savings: ${d.vault_name || 'a goal'}`;
            case 'loan_disbursement': return 'Loan received';
            case 'loan_repayment': return 'Loan repayment';
            default:
                return tx.direction === 'out' ? `Sent to ${other || 'another user'}` : `Received from ${other || 'another user'}`;
        }
    }

    function typeLabel(tx) {
        const labels = {
            deposit: 'Deposit', withdrawal: 'Withdrawal', bank_transfer: 'Bank transfer',
            savings_deposit: 'Savings', savings_release: 'Savings', loan_disbursement: 'Loan', loan_repayment: 'Loan repayment',
        };
        if (tx.type === 'payment') return KIND_LABEL[(tx.details || {}).kind] || 'Payment';
        if (labels[tx.type]) return labels[tx.type];
        return tx.direction === 'in' ? 'Transfer received' : 'Transfer sent';
    }

    const TX_ICON = {
        deposit: 'deposit', withdrawal: 'withdraw', bank_transfer: 'bank', payment: 'paybill',
        savings_deposit: 'savings', savings_release: 'savings', loan_disbursement: 'loan', loan_repayment: 'loan',
    };

    function txIcon(tx) {
        if (tx.type === 'payment') {
            const kind = (tx.details || {}).kind;
            return kind === 'till' ? 'till' : kind === 'airtime' ? 'airtime' : 'paybill';
        }
        return TX_ICON[tx.type] || (tx.direction === 'in' ? 'request' : 'send');
    }

    function renderTx(tx) {
        const li = el('li');
        const item = el('button', 'tx');
        item.type = 'button';
        item.title = 'Open receipt';
        const credit = tx.direction === 'in';

        const icon = el('span', 'tx-icon' + (credit ? ' in' : ''));
        icon.setAttribute('aria-hidden', 'true');
        icon.appendChild(iconSvg(txIcon(tx)));
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
        } else {
            pill.textContent = typeLabel(tx);
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
        const d = tx.details || {};
        $('receiptRef').textContent = reference(tx.id);
        $('receiptAmount').textContent = `${credit ? '+' : '−'}${tx.currency || currency} ${formatMoney(tx.amount)}`;
        $('receiptTitle').textContent = describe(tx);

        const dl = $('receiptRows');
        dl.replaceChildren();
        receiptRow(dl, 'Date', formatDate(tx.created_at));
        receiptRow(dl, 'Type', typeLabel(tx));
        if (tx.type === 'transfer' && tx.counterparty) receiptRow(dl, credit ? 'From' : 'To', tx.counterparty.email || 'Unknown');
        if (d.bank) receiptRow(dl, 'Bank account', `${d.bank} ${d.account_masked || ''}`.trim());
        if (d.kind === 'paybill') { receiptRow(dl, 'Business number', d.number); receiptRow(dl, 'Account', d.account || ''); }
        if (d.kind === 'till') receiptRow(dl, 'Till number', d.number);
        if (d.kind === 'airtime') receiptRow(dl, 'Phone number', d.number);
        if (d.vault_name) receiptRow(dl, 'Savings goal', d.vault_name);
        if (d.fee !== undefined) receiptRow(dl, 'Loan fee', formatMoney(d.fee));
        if (tx.balance_before !== undefined) {
            receiptRow(dl, 'Balance before', formatMoney(tx.balance_before));
            receiptRow(dl, 'Balance after', formatMoney(tx.balance_after));
        }
        receiptRow(dl, 'Status', tx.status === 'completed' ? 'Completed' : tx.status);
        const state = checkState(tx);
        if (state) {
            receiptRow(dl, 'Fraud check', state.score !== undefined ? `${state.label} (risk ${state.score.toFixed(2)})` : state.label);
        } else if (tx.direction === 'out') {
            receiptRow(dl, 'Fraud check', 'Not applicable to this type');
        }

        if (typeof receipt.showModal === 'function') receipt.showModal();
        else receipt.setAttribute('open', '');
    }

    $('receiptClose').addEventListener('click', () => receipt.close());
    $('receiptPrint').addEventListener('click', () => window.print());
    receipt.addEventListener('click', (event) => {
        if (event.target === receipt) receipt.close();
    });

    // ---------- balance, history, recipients, banner ----------
    async function loadBalance() {
        const data = await api('/api/wallet/balance');
        currency = data.currency || 'USD';
        balance = Number(data.balance);
        $('balance').textContent = formatMoney(data.balance);
        $('currency').textContent = currency;
        document.querySelectorAll('[data-currency]').forEach(node => { node.textContent = currency; });
        $('walletSerial').textContent = 'Wallet ' + String(data.walletId).padStart(6, '0');
    }

    function refreshRecipientsAndBanner() {
        const all = [...loaded.values()];
        const seen = new Set();
        const recent = $('recentRecipients');
        recent.replaceChildren();
        all.filter(tx => tx.type === 'transfer' && tx.counterparty && tx.counterparty.email)
            .forEach(tx => {
                const address = tx.counterparty.email;
                if (seen.has(address) || seen.size >= 5) return;
                seen.add(address);
                const chip = el('button', null, tx.counterparty.name || address);
                chip.type = 'button';
                chip.title = address;
                chip.addEventListener('click', () => {
                    $('recipientEmail').value = address;
                    $('amount').focus();
                });
                recent.appendChild(chip);
            });

        const underReview = all.filter(tx => {
            const state = checkState(tx);
            return state && state.label === 'Under review';
        }).length;
        const banner = $('reviewBanner');
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
        $('activityCount').textContent = data.totalTransactions === 1 ? '1 transaction' : `${data.totalTransactions} transactions`;
        $('moreWrap').hidden = page >= data.totalPages;
        refreshRecipientsAndBanner();
    }

    // Savings total and loan owed shown under the balance.
    async function loadStrip() {
        const [savings, loans] = await Promise.all([api('/api/savings'), api('/api/loans')]);
        $('stripSavings').textContent = formatMoney(savings.total);
        $('stripLoan').textContent = formatMoney(loans.active ? loans.active.outstanding : 0);
    }

    async function refreshHome() {
        await Promise.all([loadBalance(), loadHistory(true), loadStrip(), loadRequests()]);
    }

    $('moreButton').addEventListener('click', async (event) => {
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

    // ---------- statement ----------
    function csvCell(value) {
        const text = value === undefined || value === null ? '' : String(value);
        // Prefix values a spreadsheet would treat as formulas.
        const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
        return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    }

    $('statementButton').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = 'Preparing…';
        try {
            const rows = [];
            for (let p = 1; p <= 10; p += 1) {
                const data = await api(`/api/wallet/history?page=${p}&limit=100`);
                rows.push(...data.transactions);
                if (p >= data.totalPages) break;
            }
            const lines = [['Reference', 'Date', 'Description', 'Type', 'Money in', 'Money out', 'Balance after', 'Fraud check']];
            rows.forEach(tx => {
                const state = checkState(tx);
                lines.push([
                    reference(tx.id),
                    new Date(tx.created_at).toISOString().replace('T', ' ').slice(0, 16),
                    describe(tx),
                    typeLabel(tx),
                    tx.direction === 'in' ? Number(tx.amount).toFixed(2) : '',
                    tx.direction === 'out' ? Number(tx.amount).toFixed(2) : '',
                    tx.balance_after !== undefined ? Number(tx.balance_after).toFixed(2) : '',
                    state ? state.label : '',
                ]);
            });
            const csv = lines.map(line => line.map(csvCell).join(',')).join('\r\n');
            const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `securewallet-statement-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(link.href), 1000);
            toast('Statement downloaded', `${rows.length} transactions`);
        } catch (error) {
            if (!handleAuth(error)) toast('Could not prepare the statement', failText(error), true);
        } finally {
            button.disabled = false;
            button.textContent = 'Download statement';
        }
    });

    // ---------- actions: grid, form, review, submit ----------
    function showGrid() {
        actionGrid.hidden = false;
        actionForm.hidden = true;
        reviewPanel.hidden = true;
        pending = null;
        payingRequest = null;
        action = null;
    }

    function showForm() {
        actionGrid.hidden = true;
        reviewPanel.hidden = true;
        actionForm.hidden = false;
        pending = null;
    }

    function openAction(name, preset) {
        const config = ACTIONS[name];
        action = name;
        payingRequest = null;
        actionForm.reset();
        $('recipientEmail').readOnly = false;
        $('amount').readOnly = false;
        setMessage(moveMessage, '');
        $('formTitle').textContent = config.title;
        actionForm.querySelectorAll('[data-field]').forEach(field => {
            field.hidden = !config.fields.includes(field.dataset.field);
        });
        $('recipientLabel').textContent = name === 'request' ? 'Ask' : "Recipient's email";
        $('recentRecipients').hidden = false;
        if (config.numberLabel) {
            $('numberLabel').textContent = config.numberLabel;
            $('number').placeholder = config.numberPlaceholder;
            $('number').inputMode = name === 'airtime' ? 'tel' : 'numeric';
        }
        $('actionHint').textContent = config.hint;
        moveButton.textContent = config.review ? 'Continue' : config.title;
        if (preset) {
            Object.entries(preset).forEach(([key, value]) => { if ($(key)) $(key).value = value; });
        }
        showForm();
        const first = actionForm.querySelector('.field:not([hidden]) input, .field:not([hidden]) select') || $('amount');
        first.focus();
    }

    document.querySelectorAll('.action[data-action]').forEach(button => {
        button.addEventListener('click', () => openAction(button.dataset.action));
    });
    $('formBack').addEventListener('click', showGrid);

    function readForm() {
        const raw = $('amount').value.trim();
        return {
            raw,
            amount: Number(raw),
            recipientEmail: $('recipientEmail').value.trim(),
            bank: $('bank').value,
            accountNumber: $('accountNumber').value.replace(/\s+/g, ''),
            number: $('number').value.replace(/\s+/g, ''),
            account: $('account').value.trim(),
            note: $('note').value.trim(),
        };
    }

    function validate(v) {
        if (!/^\d+(\.\d{1,2})?$/.test(v.raw) || !(v.amount > 0)) return 'Enter an amount greater than 0 with at most two decimal places, for example 150 or 99.50.';
        if ((action === 'transfer' || action === 'request') && !v.recipientEmail) return "Enter the other person's email address.";
        if (action === 'bank' && !/^\d{6,16}$/.test(v.accountNumber)) return 'Enter a bank account number of 6 to 16 digits.';
        if ((action === 'paybill' || action === 'till') && !/^\d{5,7}$/.test(v.number)) return `Enter a ${action === 'paybill' ? 'business' : 'till'} number of 5 to 7 digits.`;
        if (action === 'paybill' && !v.account) return 'Enter the account number for this bill.';
        if (action === 'airtime' && !/^(?:\+?254|0)[17]\d{8}$/.test(v.number)) return 'Enter a Kenyan phone number such as 0712345678.';
        if (action === 'airtime' && v.amount > 10000) return 'Airtime is limited to 10,000 at a time.';
        return null;
    }

    function showReview(v) {
        const config = ACTIONS[action];
        const after = Math.round((balance - v.amount) * 100) / 100;
        const share = balance > 0 ? v.amount / balance : 1;

        $('reviewTitle').textContent = config.heading(v);
        const dl = $('reviewRows');
        dl.replaceChildren();
        config.summary(v).forEach(([label, value]) => receiptRow(dl, label, value));
        if (payingRequest) receiptRow(dl, 'Paying request', payingRequest.note || reference(payingRequest.id).replace('SW', 'RQ'));
        receiptRow(dl, 'Amount', money(v.amount));
        receiptRow(dl, 'Balance now', formatMoney(balance));
        receiptRow(dl, 'Balance after', formatMoney(after));
        if (config.review === 'scored') receiptRow(dl, 'Share of balance', `${Math.round(share * 100)}%`);

        const notice = $('reviewNotice');
        const warn = config.review === 'scored' && share >= LARGE_SHARE;
        notice.hidden = !warn;
        if (warn) {
            notice.replaceChildren(
                el('strong', null, `This moves ${Math.round(share * 100)}% of your balance. `),
                document.createTextNode(action === 'transfer'
                    ? 'Transfers that empty a wallet score higher with the fraud model, so this may be held for review. Make sure you know the recipient.'
                    : 'Payments out that empty a wallet score higher with the fraud model, so this may be held for review.')
            );
        }

        pending = v;
        actionForm.hidden = true;
        reviewPanel.hidden = false;
        $('reviewConfirm').textContent = 'Confirm';
        $('reviewConfirm').focus();
    }

    async function submit(v) {
        const act = action;
        const config = ACTIONS[act];
        const request = payingRequest;
        const buttons = [moveButton, $('reviewConfirm'), $('reviewBack'), $('formBack'), ...document.querySelectorAll('.action')];
        buttons.forEach(b => { b.disabled = true; });
        const started = performance.now();
        let data;

        try {
            data = await config.send(v);
        } catch (error) {
            buttons.forEach(b => { b.disabled = false; });
            if (handleAuth(error)) return;
            showForm();
            setMessage(moveMessage, failText(error), 'error');
            loadBalance().catch(() => {});
            return;
        }

        // The money has moved. From here on nothing may report a failure,
        // or the user could retry and pay twice.
        const seconds = ((performance.now() - started) / 1000).toFixed(2);
        buttons.forEach(b => { b.disabled = false; });
        showGrid();

        let requestLinked = true;
        if (request && data.transactionId) {
            try {
                await api(`/api/requests/${request.id}/pay`, { method: 'POST', body: JSON.stringify({ transactionId: data.transactionId }) });
            } catch (error) {
                requestLinked = false;
            }
        }

        let state = null;
        try {
            await refreshHome();
            const tx = data.transactionId ? loaded.get(data.transactionId) : null;
            state = tx ? checkState(tx) : null;
        } catch (error) {
            // Shown below as a plain success; a refresh will show the activity.
        }

        let detail = `${money(v.amount)} · ${data.transactionId ? reference(data.transactionId) + ' · ' : ''}${seconds}s`;
        if (state && state.score !== undefined) detail += ` · risk ${state.score.toFixed(2)}`;
        if (state && state.label === 'Not scored') detail += ' · not scored';
        const flagged = state && state.label === 'Under review';
        if (request && !requestLinked) {
            toast('Transfer sent, but the request is still open', `${detail} · decline it in Requests so you are not asked twice`, true);
            return;
        }
        const title = request ? 'Request paid' : config.done;
        toast(flagged ? `${title}, under review` : title, detail, flagged);
    }

    actionForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (moveButton.disabled || !action) return;

        const v = readForm();
        const problem = validate(v);
        if (problem) {
            setMessage(moveMessage, problem, 'error');
            return;
        }

        const config = ACTIONS[action];
        if (config.review) {
            // Use the current balance, which may have changed elsewhere.
            moveButton.disabled = true;
            try {
                await loadBalance();
            } catch (error) {
                // Fall back to the last known balance; the server checks again.
            } finally {
                moveButton.disabled = false;
            }
            if (v.amount > balance) {
                setMessage(moveMessage, `That is more than your balance of ${money(balance)}.`, 'error');
                return;
            }
        }

        setMessage(moveMessage, '');
        if (config.review) showReview(v);
        else submit(v);
    });

    $('reviewBack').addEventListener('click', () => {
        showForm();
        $('amount').focus();
    });

    $('reviewConfirm').addEventListener('click', () => {
        if (!pending) return;
        const v = pending;
        pending = null;
        submit(v);
    });

    // ---------- requests ----------
    function requestItem(r, actions) {
        const li = el('li', 'req');
        const who = r.other.name || r.other.email;
        li.appendChild(el('span', 'req-title', r.direction === 'incoming' ? `${who} asked you` : `You asked ${who}`));
        li.appendChild(el('span', 'req-amount', formatMoney(r.amount)));
        const statusText = { pending: 'Waiting', paid: 'Paid', declined: 'Declined', cancelled: 'Cancelled' }[r.status];
        li.appendChild(el('span', 'req-meta', `${r.note ? r.note + ' · ' : ''}${formatDate(r.created_at)} · ${statusText}`));
        const box = el('span', 'req-actions');
        actions.forEach(([label, className, fn]) => {
            const button = el('button', className, label);
            button.type = 'button';
            button.addEventListener('click', () => fn(button));
            box.appendChild(button);
        });
        li.appendChild(box);
        return li;
    }

    function payRequest(r) {
        location.hash = '#home';
        openAction('transfer', { recipientEmail: r.other.email, amount: Number(r.amount).toFixed(2) });
        payingRequest = r;
        $('formTitle').textContent = `Pay ${r.other.name || r.other.email}`;
        $('recentRecipients').hidden = true;
        // The transfer must match the request exactly, so these are fixed.
        $('recipientEmail').readOnly = true;
        $('amount').readOnly = true;
        $('actionHint').textContent = `Pays ${r.other.email}'s request${r.note ? ' for "' + r.note + '"' : ''}. Transfers are checked for fraud.`;
    }

    async function respond(r, verb, button) {
        button.disabled = true;
        try {
            await api(`/api/requests/${r.id}/${verb}`, { method: 'POST' });
            toast(verb === 'decline' ? 'Request declined' : 'Request cancelled', `${formatMoney(r.amount)} · ${r.other.email}`);
            await loadRequests();
        } catch (error) {
            button.disabled = false;
            if (!handleAuth(error)) toast('Could not update the request', failText(error), true);
        }
    }

    async function loadRequests() {
        const data = await api('/api/requests');
        const incoming = data.requests.filter(r => r.direction === 'incoming');
        const outgoing = data.requests.filter(r => r.direction === 'outgoing');
        const pendingIn = incoming.filter(r => r.status === 'pending');

        const badge = $('navRequestCount');
        badge.hidden = pendingIn.length === 0;
        badge.textContent = pendingIn.length;

        $('incomingRequests').hidden = pendingIn.length === 0;
        $('incomingList').replaceChildren(...pendingIn.slice(0, 3).map(r => requestItem(r, [
            ['Pay', '', () => payRequest(r)],
            ['Decline', 'quiet', b => respond(r, 'decline', b)],
        ])));

        const incomingItems = incoming.map(r => requestItem(r, r.status === 'pending' ? [
            ['Pay', '', () => payRequest(r)],
            ['Decline', 'quiet', b => respond(r, 'decline', b)],
        ] : []));
        $('reqIncoming').replaceChildren(...(incomingItems.length ? incomingItems : [el('li', 'empty', 'Nobody has asked you for money.')]));

        const outgoingItems = outgoing.map(r => requestItem(r, r.status === 'pending' ? [
            ['Cancel', 'quiet', b => respond(r, 'cancel', b)],
        ] : []));
        $('reqOutgoing').replaceChildren(...(outgoingItems.length ? outgoingItems : [el('li', 'empty', 'You have not asked anyone for money yet.')]));
    }

    $('requestForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const message = $('reqMessage');
        const raw = $('reqAmount').value.trim();
        const emailValue = $('reqEmail').value.trim();
        if (!emailValue) return setMessage(message, "Enter the other person's email address.", 'error');
        if (!/^\d+(\.\d{1,2})?$/.test(raw) || !(Number(raw) > 0)) return setMessage(message, 'Enter an amount greater than 0.', 'error');
        const button = event.submitter || event.target.querySelector('button[type=submit]');
        button.disabled = true;
        try {
            await api('/api/requests', { method: 'POST', body: JSON.stringify({ email: emailValue, amount: Number(raw), note: $('reqNote').value.trim() }) });
            event.target.reset();
            setMessage(message, '');
            toast('Request sent', `${money(Number(raw))} · ${emailValue}`);
            await loadRequests();
        } catch (error) {
            if (!handleAuth(error)) setMessage(message, failText(error), 'error');
        } finally {
            button.disabled = false;
        }
    });

    // ---------- savings ----------
    function lockText(goal) {
        if (goal.status === 'closed') return dotLabel('idle', `Closed ${goal.closed_at ? formatDate(goal.closed_at).split(',')[0] : ''}`.trim());
        if (goal.unlocked) return dotLabel('safe', 'Unlocked, withdraw any time');
        const days = goal.days_left;
        return dotLabel('ok', `Locked until ${formatDay(goal.locked_until)} · ${days} day${days === 1 ? '' : 's'} left`);
    }

    function goalCard(goal) {
        const li = el('li', 'console goal' + (goal.status === 'closed' ? ' closed' : ''));
        li.appendChild(el('h3', null, goal.name));
        const amount = el('div', 'goal-amount', formatMoney(goal.balance));
        if (goal.target_amount) amount.appendChild(el('small', null, `of ${formatMoney(goal.target_amount)}`));
        li.appendChild(amount);
        if (goal.target_amount) {
            const bar = el('div', 'progress' + (goal.balance >= goal.target_amount ? ' safe' : ''));
            const fill = el('i');
            fill.style.width = `${Math.min(100, (goal.balance / goal.target_amount) * 100)}%`;
            bar.appendChild(fill);
            li.appendChild(bar);
        }
        const lock = el('div', 'mono goal-lock');
        lock.appendChild(lockText(goal));
        li.appendChild(lock);

        if (goal.status === 'active') {
            const form = el('form', 'inline-form');
            form.noValidate = true;
            const input = el('input');
            input.type = 'number';
            input.inputMode = 'decimal';
            input.min = '0.01';
            input.step = '0.01';
            input.placeholder = 'Amount';
            input.setAttribute('aria-label', `Amount to add to ${goal.name}`);
            const add = el('button', null, 'Add money');
            add.type = 'submit';
            const take = el('button', 'quiet', goal.unlocked ? 'Withdraw all' : 'Locked');
            take.type = 'button';
            take.disabled = !goal.unlocked;
            const note = el('p', 'message');
            note.setAttribute('role', 'status');
            note.setAttribute('aria-live', 'polite');
            form.append(input, add, take);
            li.append(form, note);

            form.addEventListener('submit', async (event) => {
                event.preventDefault();
                const raw = input.value.trim();
                if (!/^\d+(\.\d{1,2})?$/.test(raw) || !(Number(raw) > 0)) return setMessage(note, 'Enter an amount greater than 0.', 'error');
                add.disabled = true;
                try {
                    await api(`/api/savings/${goal.id}/deposit`, { method: 'POST', body: JSON.stringify({ amount: Number(raw) }) });
                    toast('Moved to savings', `${money(Number(raw))} · ${goal.name}`);
                    await Promise.all([loadSavings(), loadBalance(), loadStrip(), loadHistory(true)]);
                } catch (error) {
                    add.disabled = false;
                    if (!handleAuth(error)) setMessage(note, failText(error), 'error');
                }
            });

            take.addEventListener('click', async () => {
                take.disabled = true;
                try {
                    const result = await api(`/api/savings/${goal.id}/withdraw`, { method: 'POST', body: JSON.stringify({}) });
                    toast(result.closed ? 'Goal withdrawn and closed' : 'Savings withdrawn', `${money(result.amount)} back in your wallet`);
                    await Promise.all([loadSavings(), loadBalance(), loadStrip(), loadHistory(true)]);
                } catch (error) {
                    take.disabled = false;
                    if (!handleAuth(error)) setMessage(note, failText(error), 'error');
                }
            });
        }
        return li;
    }

    async function loadSavings() {
        const data = await api('/api/savings');
        $('savingsTotal').textContent = formatMoney(data.total);
        $('goalList').replaceChildren(...(data.vaults.length
            ? data.vaults.map(goalCard)
            : [el('li', 'empty', 'No goals yet. Create one to start saving.')]));
    }

    $('goalForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const message = $('goalMessage');
        const name = $('goalName').value.trim();
        const rawTarget = $('goalTarget').value.trim();
        if (!name) return setMessage(message, 'Give the goal a name.', 'error');
        if (rawTarget && (!/^\d+(\.\d{1,2})?$/.test(rawTarget) || !(Number(rawTarget) > 0))) return setMessage(message, 'Enter a target greater than 0, or leave it empty.', 'error');
        const button = event.target.querySelector('button[type=submit]');
        button.disabled = true;
        try {
            await api('/api/savings', { method: 'POST', body: JSON.stringify({
                name, target: rawTarget ? Number(rawTarget) : null, lockDays: Number($('goalLock').value),
            }) });
            event.target.reset();
            $('goalLock').value = '30';
            setMessage(message, '');
            toast('Goal created', name);
            await loadSavings();
        } catch (error) {
            if (!handleAuth(error)) setMessage(message, failText(error), 'error');
        } finally {
            button.disabled = false;
        }
    });

    // ---------- loans ----------
    function calcRows(amount) {
        const dl = $('loanCalc');
        dl.replaceChildren();
        if (!loanInfo || !(amount > 0)) return;
        const fee = Math.round(amount * loanInfo.feeRate * 100) / 100;
        const due = new Date();
        due.setDate(due.getDate() + loanInfo.termDays);
        receiptRow(dl, `Fee (${(loanInfo.feeRate * 100).toFixed(1)}%)`, formatMoney(fee));
        receiptRow(dl, 'You repay', formatMoney(amount + fee));
        receiptRow(dl, 'Due by', due.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }));
    }

    async function loadLoans() {
        const data = await api('/api/loans');
        loanInfo = data;
        $('loanLimit').textContent = formatMoney(data.eligible ? data.limit : 0);
        $('loanTerms').textContent = `${(data.feeRate * 100).toFixed(1)}% fee · ${data.termDays} days`;
        $('loanReason').textContent = data.eligible
            ? `Borrow from ${formatMoney(data.minLoan)} up to your limit. The limit is 30% of what you received in the last 30 days.`
            : data.reason;
        $('loanForm').hidden = !data.eligible;

        const active = data.active;
        $('activeLoan').hidden = !active;
        if (active) {
            $('loanOutstanding').textContent = formatMoney(active.outstanding);
            const due = formatDay(active.due_date);
            $('loanDue').replaceChildren(dotLabel(active.overdue ? 'bad' : 'ok', active.overdue ? `Overdue since ${due}` : `Due ${due}`));
            $('loanProgress').style.width = `${Math.min(100, (active.amount_repaid / active.amount_due) * 100)}%`;
            $('loanProgressText').textContent = `${formatMoney(active.amount_repaid)} repaid of ${formatMoney(active.amount_due)} (borrowed ${formatMoney(active.principal)} plus ${formatMoney(active.fee)} fee).`;
        }
        $('stripLoan').textContent = formatMoney(active ? active.outstanding : 0);

        const items = data.history.map(loan => {
            const li = el('li');
            li.appendChild(el('span', null, `${formatDate(loan.created_at).split(',')[0]} · borrowed ${formatMoney(loan.principal)}`));
            li.appendChild(el('span', 'mono', loan.status === 'repaid' ? 'Repaid' : loan.overdue ? 'Overdue' : `${formatMoney(loan.outstanding)} owed`));
            return li;
        });
        $('loanHistory').replaceChildren(...(items.length ? items : [el('li', 'empty', 'You have not borrowed yet.')]));
    }

    $('loanAmount').addEventListener('input', () => calcRows(Number($('loanAmount').value)));

    $('loanForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const message = $('loanMessage');
        const raw = $('loanAmount').value.trim();
        const amount = Number(raw);
        if (!/^\d+(\.\d{1,2})?$/.test(raw) || !(amount > 0)) return setMessage(message, 'Enter the amount you want to borrow.', 'error');
        if (loanInfo && amount < loanInfo.minLoan) return setMessage(message, `The smallest loan is ${formatMoney(loanInfo.minLoan)}.`, 'error');
        if (loanInfo && amount > loanInfo.limit) return setMessage(message, `Your limit is ${formatMoney(loanInfo.limit)}.`, 'error');
        const button = $('loanButton');
        button.disabled = true;
        try {
            const result = await api('/api/loans', { method: 'POST', body: JSON.stringify({ amount }) });
            event.target.reset();
            calcRows(0);
            setMessage(message, '');
            toast('Loan sent to your wallet', `${money(amount)} · repay ${formatMoney(result.loan.amount_due)}`);
            await Promise.all([loadLoans(), loadBalance(), loadHistory(true)]);
        } catch (error) {
            if (!handleAuth(error)) setMessage(message, failText(error), 'error');
        } finally {
            button.disabled = false;
        }
    });

    async function repay(amount, button) {
        const message = $('repayMessage');
        button.disabled = true;
        try {
            const result = await api('/api/loans/repay', { method: 'POST', body: JSON.stringify({ amount }) });
            $('repayForm').reset();
            setMessage(message, '');
            toast(result.loan.status === 'repaid' ? 'Loan fully repaid' : 'Repayment received', `${money(amount)} · ${formatMoney(result.loan.outstanding)} left`);
            await Promise.all([loadLoans(), loadBalance(), loadHistory(true)]);
        } catch (error) {
            if (!handleAuth(error)) setMessage(message, failText(error), 'error');
        } finally {
            button.disabled = false;
        }
    }

    $('repayForm').addEventListener('submit', (event) => {
        event.preventDefault();
        const raw = $('repayAmount').value.trim();
        if (!/^\d+(\.\d{1,2})?$/.test(raw) || !(Number(raw) > 0)) return setMessage($('repayMessage'), 'Enter an amount to repay.', 'error');
        repay(Number(raw), event.target.querySelector('button[type=submit]'));
    });

    $('repayAll').addEventListener('click', (event) => {
        if (loanInfo && loanInfo.active) repay(loanInfo.active.outstanding, event.currentTarget);
    });

    // ---------- start ----------
    (async () => {
        const user = await requireUser('user');
        if (!user) return;
        $('userName').textContent = user.name;
        $('holderName').textContent = user.name;
        showView();
        try {
            const banks = await api('/api/payments/banks');
            $('bank').replaceChildren(...banks.banks.map(name => {
                const option = el('option', null, name);
                option.value = name;
                return option;
            }));
        } catch (error) {
            // The bank form will report the problem when used.
        }
        try {
            await refreshHome();
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
        const cashOut = meta.type === 'withdrawal' || meta.type === 'bank_transfer';
        if (!cashOut && meta.receiver_balance_before !== undefined) {
            const rb = Number(meta.receiver_balance_before);
            out.push([rb === 0 ? 'warn' : 'idle', rb === 0
                ? 'Recipient\'s wallet was empty before receiving'
                : `Recipient already held ${formatMoney(rb)}`]);
        }
        if (cashOut) {
            out.push(['idle', meta.type === 'bank_transfer'
                ? 'Money left the wallet system to a bank account, scored as a cash-out'
                : 'Scored as a cash-out, the other transaction type in which fraud occurs']);
        }
        return out;
    }

    function renderAlert(alert) {
        const meta = parseMeta(alert.metadata);
        const type = meta.type === 'withdrawal' ? 'Withdrawal'
            : meta.type === 'bank_transfer' ? `Bank transfer to ${meta.bank || 'a bank'} ${meta.account_masked || ''}`.trim()
            : 'Transfer';
        const cashOut = meta.type === 'withdrawal' || meta.type === 'bank_transfer';
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
        if (!cashOut) dl.appendChild(row('To', alert.receiver_email || 'Unknown'));
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
                window.location.href = 'login.html';
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
