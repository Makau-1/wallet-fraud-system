// SecureWallet operations console (administrator), versions 1 to 3.
// Uses the shared helpers in app.js (api, el, formatMoney, dotLabel ...).

(function () {
    if (document.body.dataset.page !== 'admin') return;
    wireLogout();
    paintIcons();

    const $ = id => document.getElementById(id);
    const adminMessage = $('adminMessage');
    let riskMode = 'advisory';
    let twoPersonThreshold = 10000;
    let meId = null;

    // ---------- small helpers ----------
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

    function kes(value) { return `KES ${formatMoney(value)}`; }

    function button(label, className, onClick) {
        const b = el('button', className || '', label);
        b.type = 'button';
        if (onClick) b.addEventListener('click', () => onClick(b));
        return b;
    }

    function table(node, headers, rows) {
        const head = el('tr');
        headers.forEach(h => head.appendChild(el('th', typeof h === 'object' ? h.className : null, typeof h === 'object' ? h.label : h)));
        node.replaceChildren(head, ...rows.map(cells => {
            const tr = el('tr');
            cells.forEach(cell => {
                if (cell instanceof Node) { const td = el('td'); td.appendChild(cell); tr.appendChild(td); return; }
                if (cell && typeof cell === 'object') { tr.appendChild(el('td', cell.className, cell.text)); return; }
                tr.appendChild(el('td', null, cell === null || cell === undefined ? '' : String(cell)));
            });
            return tr;
        }));
        if (!rows.length) {
            const tr = el('tr');
            const td = el('td', 'empty', 'Nothing to show yet.');
            td.colSpan = headers.length;
            tr.appendChild(td);
            node.appendChild(tr);
        }
    }

    function tile(label, value, note, tone) {
        const box = el('div', 'console stat');
        const head = el('span', 'mono');
        if (tone) head.appendChild(el('span', `dot ${tone}`));
        head.appendChild(document.createTextNode(label));
        box.appendChild(head);
        box.appendChild(el('div', 'num', value));
        if (note) box.appendChild(el('span', 'hint stat-note', note));
        return box;
    }

    async function call(path, options) {
        try {
            return await api(path, options);
        } catch (error) {
            if (error.status === 401) { window.location.href = 'login.html'; throw error; }
            if (error.status === 403 && error.data && error.data.setup2fa) { showGate(); throw error; }
            throw error;
        }
    }

    function fail(error) {
        if (error && error.status !== 401) setMessage(adminMessage, error.message || 'Something went wrong', 'error');
    }

    // ---------- sections ----------
    const SECTIONS = ['overview', 'alerts', 'cases', 'network', 'models', 'lab', 'ledger', 'audit', 'system', 'api', 'survey'];
    const LOADERS = {};

    function showSection() {
        const name = SECTIONS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
        document.querySelectorAll('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== name; });
        document.querySelectorAll('.ops-nav a').forEach(a => {
            if (a.dataset.section === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
        });
        setMessage(adminMessage, '');
        if (LOADERS[name]) LOADERS[name]().catch(fail);
        window.scrollTo(0, 0);
    }
    window.addEventListener('hashchange', showSection);

    function paintMode() {
        document.querySelectorAll('[data-mode-badge]').forEach(b => {
            b.textContent = riskMode === 'enforce' ? 'Enforcing' : 'Advisory';
            b.className = 'badge' + (riskMode === 'enforce' ? ' hold' : '');
        });
        $('reviewIntro').textContent = riskMode === 'enforce'
            ? `Payments whose risk score reached the alert threshold. Payments marked on hold have left the sender but have not been paid out: confirming fraud returns the money, releasing sends it on. Held payments of ${kes(twoPersonThreshold)} or more need two administrators.`
            : 'Payments whose risk score reached the alert threshold. In advisory mode the money has already moved; your decision records whether the transaction was fraud.';
        $('twoPersonLabel').textContent = kes(twoPersonThreshold);
    }

    // ================= OVERVIEW =================
    LOADERS.overview = async () => {
        const d = await call('/api/admin/overview');
        riskMode = d.riskMode;
        paintMode();
        $('kpis').replaceChildren(
            tile('Payments today', String(d.today.payments), kes(d.today.volume)),
            tile('Alerts waiting', String(d.alerts.waiting), d.alerts.awaitingSecondApproval ? `${d.alerts.awaitingSecondApproval} need a second approval` : 'In the review queue', d.alerts.waiting ? 'ok' : 'safe'),
            tile('Money held or cooling off', kes(d.held.amount), `${d.held.count} payments`, d.held.count ? 'warn' : null),
            tile('Money stopped', kes(d.stopped.amount), `${d.stopped.count} payments refunded or cancelled`, 'safe'),
            tile('Alerts cleared by analysts', d.alerts.clearedShare === null ? 'n/a' : `${d.alerts.clearedShare}%`, 'Share of decided alerts that were false alarms'),
            tile('Average time to review', d.averageReviewMinutes === null ? 'n/a' : `${d.averageReviewMinutes} min`, 'Last 30 days'),
            tile('Open disputes', String(d.openDisputes), `${d.frozenAccounts} accounts frozen`, d.openDisputes ? 'warn' : null),
            tile('Model latency (p95)', d.modelLatency ? `${d.modelLatency.p95} ms` : 'n/a', d.modelLatency ? `median ${d.modelLatency.p50} ms, ${d.modelLatency.n} calls` : 'No calls in 15 minutes'),
        );
        drawBars($('alertsChart'), d.daily);
        const rec = d.reconciliation;
        const rows = [
            ['Risk engine', riskMode === 'enforce' ? ['safe', 'Enforcing: PIN challenge and holds'] : ['idle', 'Advisory: flag only']],
            ['Books', rec ? (rec.ok ? ['safe', `Reconciled ${formatDate(rec.at)}`] : ['bad', `Last reconciliation found problems (${formatDate(rec.at)})`]) : ['idle', 'Not reconciled yet']],
            ['Unscored payments waiting', d.unscoredBacklog ? ['warn', `${d.unscoredBacklog} to score when the model returns`] : ['safe', 'None']],
        ];
        $('healthRows').replaceChildren(...rows.map(([label, [tone, text]]) => {
            const li = el('li');
            li.appendChild(el('span', null, label));
            const value = el('span', 'mono');
            value.appendChild(dotLabel(tone, text));
            li.appendChild(value);
            return li;
        }));
        const status = await api('/api/status').catch(() => ({}));
        const li = el('li');
        li.appendChild(el('span', null, 'Scoring model'));
        const value = el('span', 'mono');
        value.appendChild(dotLabel(status.scoring === 'operational' ? 'safe' : 'bad', status.scoring === 'operational' ? 'Operational' : 'Unavailable'));
        li.appendChild(value);
        $('healthRows').prepend(li);
    };

    // A single-series bar chart: one hue, values labelled, a title on each
    // bar for hover, and the same numbers in a hidden table for screen readers.
    function drawBars(box, data) {
        const days = [];
        for (let i = 13; i >= 0; i -= 1) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            days.push(d.toISOString().slice(0, 10));
        }
        const byDay = new Map(data.map(r => [String(r.day).slice(0, 10), r]));
        const values = days.map(day => ({ day, alerts: (byDay.get(day) || {}).alerts || 0, confirmed: (byDay.get(day) || {}).confirmed || 0 }));
        const max = Math.max(1, ...values.map(v => v.alerts));
        const W = 560; const H = 180; const pad = 24; const barW = (W - pad) / values.length;
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', `0 0 ${W} ${H + 24}`);
        svg.setAttribute('class', 'bars');
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', 'Alerts raised per day over the last 14 days');
        const base = document.createElementNS(ns, 'line');
        base.setAttribute('x1', pad); base.setAttribute('x2', W); base.setAttribute('y1', H); base.setAttribute('y2', H);
        base.setAttribute('class', 'axis');
        svg.appendChild(base);
        values.forEach((v, i) => {
            const h = (v.alerts / max) * (H - 24);
            const x = pad + i * barW + 3;
            const g = document.createElementNS(ns, 'g');
            const rect = document.createElementNS(ns, 'rect');
            rect.setAttribute('x', x); rect.setAttribute('y', H - h); rect.setAttribute('width', Math.max(4, barW - 6)); rect.setAttribute('height', Math.max(0, h));
            rect.setAttribute('rx', 3);
            rect.setAttribute('class', 'bar');
            const title = document.createElementNS(ns, 'title');
            title.textContent = `${v.day}: ${v.alerts} alerts, ${v.confirmed} confirmed as fraud`;
            rect.appendChild(title);
            g.appendChild(rect);
            if (v.alerts) {
                const label = document.createElementNS(ns, 'text');
                label.setAttribute('x', x + (barW - 6) / 2); label.setAttribute('y', H - h - 5); label.setAttribute('class', 'bar-label');
                label.textContent = v.alerts;
                g.appendChild(label);
            }
            if (i % 2 === 1 || values.length < 8) {
                const day = document.createElementNS(ns, 'text');
                day.setAttribute('x', x + (barW - 6) / 2); day.setAttribute('y', H + 16); day.setAttribute('class', 'tick');
                day.textContent = v.day.slice(8, 10) + '/' + v.day.slice(5, 7);
                g.appendChild(day);
            }
            svg.appendChild(g);
        });
        const t = el('table', 'visually-hidden');
        values.forEach(v => { const tr = el('tr'); tr.append(el('td', null, v.day), el('td', null, String(v.alerts))); t.appendChild(tr); });
        box.replaceChildren(svg, t);
    }

    // ================= ALERTS =================
    let alertStatus = 'pending';

    const FEATURE_LABEL = {
        amount: 'Amount', oldbalanceOrg: 'Sender balance before', newbalanceOrig: 'Sender balance after',
        oldbalanceDest: 'Recipient balance before', newbalanceDest: 'Recipient balance after',
        type_encoded: 'Transaction type', balance_discrepancy: 'Balance discrepancy',
    };

    function featureValue(c) {
        if (c.feature === 'type_encoded') return c.value === 1 ? 'transfer' : 'cash-out';
        return formatMoney(c.value);
    }

    function row(label, value) {
        const frag = document.createDocumentFragment();
        frag.appendChild(el('dt', null, label));
        frag.appendChild(el('dd', null, value));
        return frag;
    }

    function context(alert, meta) {
        const out = [];
        const amount = Number(alert.amount);
        const before = Number(meta.sender_balance_before);
        const after = Number(meta.sender_balance_after);
        if (Number.isFinite(before) && before > 0) {
            const share = Math.round((amount / before) * 100);
            out.push([share >= 90 ? 'bad' : share >= 50 ? 'warn' : 'idle', `Moved ${share}% of the sender's balance in one transaction`]);
        }
        if (Number.isFinite(after) && after === 0) out.push(['bad', 'Sender\'s wallet was left empty']);
        const cashOut = meta.type === 'withdrawal' || meta.type === 'bank_transfer';
        if (!cashOut && meta.receiver_balance_before !== undefined) {
            const rb = Number(meta.receiver_balance_before);
            out.push([rb === 0 ? 'warn' : 'idle', rb === 0 ? 'Recipient\'s wallet was empty before receiving' : `Recipient already held ${formatMoney(rb)}`]);
        }
        if (meta.purpose) out.push([meta.purpose.risky ? 'bad' : 'idle', `Sender said it is for: ${meta.purpose.label.toLowerCase()}`]);
        if (meta.channel && meta.channel !== 'web') out.push(['idle', `Made through ${meta.channel === 'ussd' ? 'USSD' : meta.channel}`]);
        return out;
    }

    function explanation(risk) {
        const box = el('div', 'signals explain');
        box.appendChild(el('span', 'mono', 'Why this was raised'));
        const sum = el('p', 'risk-sum');
        if (risk.model_score === null || risk.model_score === undefined) {
            sum.append(document.createTextNode('The fraud model was unavailable, so this risk of '), el('strong', null, Number(risk.score).toFixed(2)),
                document.createTextNode(' comes from the behavioural signals alone.'));
        } else {
            sum.append(document.createTextNode('Model score '), el('strong', null, Number(risk.model_score).toFixed(2)),
                document.createTextNode(risk.signals && risk.signals.length ? ' raised by behaviour to a risk of ' : ', no behavioural signals, risk '),
                el('strong', null, Number(risk.score).toFixed(2)));
            if (risk.model_version) sum.append(document.createTextNode(` · model ${risk.model_version}`));
            if (risk.shadow) sum.append(document.createTextNode(` · challenger scored ${Number(risk.shadow.score).toFixed(2)}`));
        }
        box.appendChild(sum);
        if (risk.signals && risk.signals.length) {
            const ul = el('ul');
            risk.signals.forEach(signal => {
                const li = el('li');
                const text = el('span', 'why');
                text.appendChild(dotLabel(signal.weight >= 0.3 ? 'bad' : 'warn', signal.label));
                li.appendChild(text);
                li.appendChild(el('span', 'weight mono', `weight ${Number(signal.weight).toFixed(2)}`));
                ul.appendChild(li);
            });
            box.appendChild(ul);
        }
        const contributions = (risk.contributions || []).filter(c => Math.abs(c.contribution) >= 0.005).slice(0, 5);
        if (contributions.length) {
            box.appendChild(el('span', 'mono sub', 'What moved the model score'));
            const largest = Math.max(...contributions.map(c => Math.abs(c.contribution)));
            const chart = el('div', 'contrib');
            contributions.forEach(c => {
                const up = c.contribution > 0;
                const r = el('div', 'contrib-row');
                r.appendChild(el('span', 'contrib-name', `${FEATURE_LABEL[c.feature] || c.feature} (${featureValue(c)})`));
                const track = el('span', 'contrib-track');
                const bar = el('i', up ? 'up' : 'down');
                bar.style.width = `${Math.max(4, (Math.abs(c.contribution) / largest) * 100)}%`;
                track.appendChild(bar);
                r.appendChild(track);
                r.appendChild(el('span', 'contrib-num mono', `${up ? '+' : '−'}${Math.abs(c.contribution).toFixed(2)}`));
                chart.appendChild(r);
            });
            box.appendChild(chart);
            if (risk.base_value !== null && risk.base_value !== undefined) {
                box.appendChild(el('p', 'note', `The model starts from ${Number(risk.base_value).toFixed(2)} and each feature moves the score up (orange) or down (green); together they add up to the model score. Balance discrepancy is always zero in this wallet, so the model leans on the balances.`));
            }
        }
        return box;
    }

    async function toggleNotes(alert, holder, trigger) {
        if (holder.childElementCount) { holder.replaceChildren(); return; }
        const data = await call(`/api/admin/fraud-alerts/${alert.id}/notes`);
        const list = el('ul', 'simple-list');
        data.notes.forEach(n => {
            const li = el('li');
            li.append(el('span', null, n.note), el('span', 'mono', `${n.author || 'Admin'} · ${formatDate(n.created_at)}`));
            list.appendChild(li);
        });
        if (!data.notes.length) list.appendChild(el('li', 'empty', 'No notes yet.'));
        const form = el('form', 'inline-form');
        const input = el('input');
        input.placeholder = 'Add a note for other analysts';
        input.setAttribute('aria-label', 'Note');
        const add = el('button', 'quiet', 'Add note');
        add.type = 'submit';
        form.append(input, add);
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (!input.value.trim()) return;
            await call(`/api/admin/fraud-alerts/${alert.id}/notes`, { method: 'POST', body: JSON.stringify({ note: input.value.trim() }) }).catch(fail);
            holder.replaceChildren();
            trigger.textContent = `Notes (${Number(alert.note_count) + 1})`;
            alert.note_count = Number(alert.note_count) + 1;
            toggleNotes(alert, holder, trigger);
        });
        holder.replaceChildren(list, form);
    }

    function renderAlert(alert) {
        const meta = parseMeta(alert.metadata);
        const type = meta.type === 'withdrawal' ? 'Withdrawal'
            : meta.type === 'bank_transfer' ? `Bank transfer to ${meta.bank || 'a bank'} ${meta.account_masked || ''}`.trim() : 'Transfer';
        const cashOut = meta.type === 'withdrawal' || meta.type === 'bank_transfer';
        const score = Number(alert.score);
        const item = el('li', `alert ${alert.status}`);
        const tone = alert.status === 'confirmed_fraud' ? 'fraud' : alert.status === 'cleared' ? 'low' : 'high';

        const scoreBox = el('div', 'score');
        scoreBox.appendChild(el('span', 'mono', meta.risk ? 'Risk score' : 'Fraud score'));
        scoreBox.appendChild(el('div', 'figure', score.toFixed(2)));
        scoreBox.appendChild(meter(score, tone));
        scoreBox.appendChild(el('span', 'mono alert-type', (alert.alert_type || '').replace('_', ' ')));
        item.appendChild(scoreBox);

        const body = el('div');
        const who = alert.sender_name || alert.sender_email || 'Unknown sender';
        const held = alert.transaction_status === 'pending';
        const heading = el('h3', null, `${type} of ${alert.currency || 'KES'} ${formatMoney(alert.amount)} by ${who}`);
        if (held) heading.append(' ', el('span', 'badge hold', meta.risk && meta.risk.action === 'cooling_off' ? 'Cooling off' : 'On hold'));
        else if (meta.risk && meta.risk.action === 'released') heading.append(' ', el('span', 'badge', 'Released'));
        else if (meta.risk && ['reversed', 'cancelled'].includes(meta.risk.action)) heading.append(' ', el('span', 'badge', meta.risk.action === 'cancelled' ? 'Cancelled by sender' : 'Refunded'));
        if (alert.assigned_to_name) heading.append(' ', el('span', 'badge', `Assigned: ${alert.assigned_to_name}`));
        body.appendChild(heading);

        const dl = el('dl');
        dl.appendChild(row('From', alert.sender_email || 'Unknown'));
        if (!cashOut) dl.appendChild(row('To', alert.receiver_email || 'Unknown'));
        if (meta.sender_balance_before !== undefined) dl.appendChild(row('Sender balance', `${formatMoney(meta.sender_balance_before)} before, ${formatMoney(meta.sender_balance_after)} after`));
        dl.appendChild(row('Made', formatDate(alert.transaction_time)));
        dl.appendChild(row('Reference', reference(alert.transaction_id)));
        body.appendChild(dl);

        if (meta.risk && meta.risk.score !== null && meta.risk.score !== undefined) body.appendChild(explanation(meta.risk));
        const found = context(alert, meta);
        if (found.length) {
            const box = el('div', 'signals');
            box.appendChild(el('span', 'mono', 'Context for this alert'));
            const ul = el('ul');
            found.forEach(([kind, text]) => { const li = el('li'); li.appendChild(dotLabel(kind, text)); ul.appendChild(li); });
            box.appendChild(ul);
            body.appendChild(box);
        }

        const tools = el('div', 'alert-tools');
        const notesHolder = el('div', 'notes-holder');
        const notesButton = button(`Notes (${alert.note_count || 0})`, 'quiet small', b => toggleNotes(alert, notesHolder, b).catch(fail));
        tools.appendChild(notesButton);
        if (alert.sender_email) {
            const link = el('a', 'button quiet small', 'View network');
            link.href = `#network`;
            link.addEventListener('click', () => { pendingNetwork = alert.sender_email; });
            tools.appendChild(link);
        }
        if (alert.status === 'pending') {
            const mine = String(alert.assigned_to) === String(meId);
            tools.appendChild(button(mine ? 'Unassign' : 'Assign to me', 'quiet small', async () => {
                await call(`/api/admin/fraud-alerts/${alert.id}/assign`, { method: 'POST', body: JSON.stringify({ unassign: mine }) }).catch(fail);
                loadAlerts();
            }));
        }
        body.append(tools, notesHolder);
        item.appendChild(body);

        if (alert.status === 'pending') {
            const actions = el('div', 'actions');
            const proposedByMe = alert.proposed_status && String(alert.proposed_by) === String(meId);
            if (alert.proposed_status) {
                actions.appendChild(el('p', 'proposal', proposedByMe
                    ? `You proposed: ${alert.proposed_status === 'cleared' ? 'release' : 'confirm fraud'}. Waiting for a second administrator.`
                    : `${alert.proposed_by_name || 'An administrator'} proposed: ${alert.proposed_status === 'cleared' ? 'release' : 'confirm fraud'}. Approve or reject.`));
            }
            if (!proposedByMe) {
                const confirm = el('button', 'danger', alert.proposed_status === 'confirmed_fraud' ? 'Approve: confirm fraud' : held ? 'Confirm fraud, refund sender' : 'Confirm fraud');
                const dismiss = el('button', 'quiet', alert.proposed_status === 'cleared' ? 'Approve: release' : held ? 'Release payment' : 'Dismiss');
                confirm.type = 'button'; dismiss.type = 'button';
                if (alert.proposed_status === 'cleared') confirm.hidden = true;
                if (alert.proposed_status === 'confirmed_fraud') dismiss.hidden = true;
                confirm.addEventListener('click', () => decide(alert.id, 'confirmed_fraud', [confirm, dismiss]));
                dismiss.addEventListener('click', () => decide(alert.id, 'cleared', [confirm, dismiss]));
                actions.append(confirm, dismiss);
                if (alert.proposed_status) {
                    actions.appendChild(button('Reject proposal', 'quiet small', async () => {
                        await call(`/api/admin/fraud-alerts/${alert.id}/proposal/reject`, { method: 'POST' }).catch(fail);
                        loadAlerts();
                    }));
                } else if (held && Number(alert.amount) >= twoPersonThreshold) {
                    actions.appendChild(el('p', 'proposal', 'Needs two administrators'));
                }
            }
            item.appendChild(actions);
        } else {
            const decision = el('div', 'decision');
            decision.appendChild(el('strong', null, alert.status === 'confirmed_fraud' ? 'Confirmed fraud' : 'Dismissed'));
            decision.appendChild(document.createTextNode(`by ${alert.reviewed_by_name || 'an administrator'}${alert.reviewed_at ? ', ' + formatDate(alert.reviewed_at) : ''}`));
            item.appendChild(decision);
        }
        return item;
    }

    const EMPTY = {
        pending: 'No alerts are waiting for review. New ones appear here, live, when a payment reaches the alert threshold.',
        confirmed_fraud: 'No alerts have been confirmed as fraud yet.',
        cleared: 'No alerts have been dismissed yet.',
    };

    async function loadAlerts() {
        const data = await call(`/api/admin/fraud-alerts?status=${alertStatus}`);
        meId = data.me;
        twoPersonThreshold = data.twoPersonThreshold || twoPersonThreshold;
        paintMode();
        Object.entries(data.counts).forEach(([key, value]) => {
            const counter = $(`count-${key}`); if (counter) counter.textContent = value;
            const stat = $(`stat-${key}`); if (stat) stat.textContent = value;
        });
        $('navAlerts').hidden = !data.counts.pending;
        $('navAlerts').textContent = data.counts.pending;
        $('alertList').replaceChildren(...(data.alerts.length ? data.alerts.map(renderAlert) : [el('li', 'empty', EMPTY[alertStatus])]));
    }
    LOADERS.alerts = async () => { await loadAlerts(); loadStatus(); };

    async function decide(id, decision, buttons) {
        buttons.forEach(b => { b.disabled = true; });
        try {
            const result = await call(`/api/admin/fraud-alerts/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: decision }) });
            if (result.awaitingSecondApproval) {
                setMessage(adminMessage, `Alert #${id}: decision recorded. A second administrator must approve it before the money moves.`, 'success');
            } else {
                const moved = result.settlement === 'reversed' ? ' The held money was returned to the sender.'
                    : result.settlement === 'released' ? ' The held payment was released.' : '';
                setMessage(adminMessage, (decision === 'confirmed_fraud' ? `Alert #${id} confirmed as fraud.` : `Alert #${id} dismissed.`) + moved, 'success');
            }
            await loadAlerts();
        } catch (error) {
            fail(error);
            buttons.forEach(b => { b.disabled = false; });
        }
    }

    document.querySelectorAll('[data-panel="alerts"] .tabs button').forEach(b => {
        b.addEventListener('click', () => {
            alertStatus = b.dataset.status;
            document.querySelectorAll('[data-panel="alerts"] .tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
            loadAlerts().catch(fail);
        });
    });

    // ================= DISPUTES AND REPORTS =================
    let caseTab = 'open';

    async function loadCases() {
        const box = $('caseList');
        if (caseTab === 'reports') {
            const data = await call('/api/admin/reports');
            const t = el('table', 'data-table');
            table(t, ['Account', 'Reports', 'Reasons', 'Last report', 'State', ''], data.accounts.map(a => [
                `${a.name} (${a.email})`, { text: String(a.reports), className: 'num' }, a.reasons.join('; '), formatDate(a.last_report),
                a.frozen_at ? 'Frozen' : 'Active',
                button(a.frozen_at ? 'Restore' : 'Freeze', a.frozen_at ? 'quiet small' : 'danger small', async () => {
                    await call(`/api/admin/users/${a.id}/${a.frozen_at ? 'restore' : 'freeze'}`, { method: 'POST', body: JSON.stringify({ reason: 'Reported by other users' }) }).catch(fail);
                    loadCases();
                }),
            ]));
            const wrap = el('div', 'console table-wrap');
            wrap.appendChild(t);
            box.replaceChildren(wrap);
            return;
        }
        const data = await call(`/api/admin/disputes${caseTab === 'open' ? '?status=open' : ''}`);
        twoPersonThreshold = data.twoPersonThreshold;
        const rows = data.disputes.filter(d => (caseTab === 'open' ? d.status === 'open' : d.status !== 'open'));
        if (caseTab === 'open') { $('navCases').hidden = !rows.length; $('navCases').textContent = rows.length; }
        if (!rows.length) { box.replaceChildren(el('p', 'empty console', caseTab === 'open' ? 'No open disputes.' : 'No decided disputes yet.')); return; }
        box.replaceChildren(...rows.map(d => {
            const card = el('article', 'console case');
            const head = el('div', 'console-head');
            head.append(el('span', 'mono', `Dispute #${d.id} · ${reference(d.transaction_id)}`), el('span', 'mono', formatDate(d.created_at)));
            card.appendChild(head);
            card.appendChild(el('h3', null, `${d.sender_name} says they did not make a ${String(d.type).replace('_', ' ')} of ${kes(d.amount)}`));
            const dl = el('dl', 'case-dl');
            dl.appendChild(row('Customer', d.sender_email));
            if (d.recipient_email) dl.appendChild(row('Paid to', `${d.recipient_name} (${d.recipient_email}), who now holds ${kes(d.recipient_balance || 0)}`));
            dl.appendChild(row('Payment', `${d.transaction_status === 'failed' ? 'Stopped and refunded' : d.transaction_status === 'pending' ? 'Waiting' : 'Completed'} · ${formatDate(d.transaction_time)}`));
            if (d.reason) dl.appendChild(row('Their words', d.reason));
            if (d.status !== 'open') dl.appendChild(row('Decision', `${d.status} by ${d.decided_by_name || 'an administrator'}${d.recovered_amount !== null ? `, recovered ${kes(d.recovered_amount)}` : ''}`));
            card.appendChild(dl);
            if (d.status === 'open') {
                const actions = el('div', 'actions');
                const mine = d.proposed_status && String(d.proposed_by) === String(data.me);
                if (d.proposed_status) actions.appendChild(el('p', 'proposal', mine ? `You proposed "${d.proposed_status}". Waiting for a second administrator.` : `${d.proposed_by_name} proposed "${d.proposed_status}".`));
                if (!mine) {
                    if (d.proposed_status !== 'rejected') {
                        actions.appendChild(button(d.proposed_status ? 'Approve: uphold' : 'Uphold and recover', 'danger', async (b) => {
                            b.disabled = true;
                            try {
                                const r = await call(`/api/admin/disputes/${d.id}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'upheld' }) });
                                setMessage(adminMessage, r.awaitingSecondApproval ? 'Recorded. A second administrator must approve the recovery.' : `Upheld. Recovered ${kes(r.recovered || 0)}.`, 'success');
                                loadCases();
                            } catch (error) { fail(error); b.disabled = false; }
                        }));
                    }
                    if (d.proposed_status !== 'upheld') {
                        actions.appendChild(button(d.proposed_status ? 'Approve: reject' : 'Reject claim', 'quiet', async (b) => {
                            b.disabled = true;
                            try {
                                await call(`/api/admin/disputes/${d.id}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'rejected' }) });
                                setMessage(adminMessage, 'Claim rejected.', 'success');
                                loadCases();
                            } catch (error) { fail(error); b.disabled = false; }
                        }));
                    }
                    if (d.proposed_status) actions.appendChild(button('Reject proposal', 'quiet small', async () => { await call(`/api/admin/disputes/${d.id}/proposal/reject`, { method: 'POST' }).catch(fail); loadCases(); }));
                }
                card.appendChild(actions);
            }
            return card;
        }));
    }
    LOADERS.cases = loadCases;
    document.querySelectorAll('[data-panel="cases"] .tabs button').forEach(b => {
        b.addEventListener('click', () => {
            caseTab = b.dataset.case;
            document.querySelectorAll('[data-panel="cases"] .tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
            loadCases().catch(fail);
        });
    });

    // ================= NETWORK =================
    let pendingNetwork = null;

    LOADERS.network = async () => {
        const data = await call('/api/admin/network/findings');
        table($('findings'), ['Account', { label: 'Payers', className: 'num' }, { label: 'Received', className: 'num' }, { label: 'Sent on', className: 'num' }, { label: 'Reports', className: 'num' }, ''],
            data.accounts.map(a => [
                `${a.name} (${a.email})${a.frozen ? ' · frozen' : ''}`, { text: String(a.senders), className: 'num' }, { text: formatMoney(a.received), className: 'num' },
                { text: `${a.passThrough}%`, className: 'num' }, { text: String(a.reports), className: 'num' },
                button('Show', 'quiet small', () => { $('networkAccount').value = a.email; showNetwork(); }),
            ]));
        if (pendingNetwork) {
            $('networkAccount').value = pendingNetwork;
            pendingNetwork = null;
            showNetwork();
        }
    };

    async function showNetwork() {
        const account = $('networkAccount').value.trim();
        if (!account) return;
        try {
            const data = await call(`/api/admin/network?account=${encodeURIComponent(account)}&hours=${$('networkHours').value}&hops=${$('networkHops').value}`);
            $('graphBox').hidden = false;
            $('graphTitle').textContent = `${data.nodes.length} accounts and ${data.edges.length} flows around ${account}${data.truncated ? ' (first 60 accounts shown)' : ''}`;
            drawGraph($('graph'), data);
            const names = new Map(data.nodes.map(n => [n.id, n.name]));
            table($('graphTable'), ['From', 'To', { label: 'Total', className: 'num' }, { label: 'Payments', className: 'num' }, 'Latest'],
                data.edges.sort((a, b) => b.total - a.total).map(e => [names.get(e.from), names.get(e.to), { text: formatMoney(e.total), className: 'num' }, { text: String(e.count), className: 'num' }, `${formatDate(e.lastAt)}${e.pending ? ' · held' : ''}`]));
        } catch (error) { fail(error); }
    }
    $('networkForm').addEventListener('submit', (event) => { event.preventDefault(); showNetwork(); });

    // A small force-directed layout: linked accounts pull together, all
    // accounts push apart, and the centre account is pinned in the middle.
    function drawGraph(svg, data) {
        const W = 760; const H = 440;
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        const nodes = data.nodes.map((n, i) => ({ ...n, x: W / 2 + Math.cos(i * 2.4) * 160 * (n.centre ? 0 : 1), y: H / 2 + Math.sin(i * 2.4) * 120 * (n.centre ? 0 : 1), vx: 0, vy: 0 }));
        const byId = new Map(nodes.map(n => [n.id, n]));
        const links = data.edges.map(e => ({ ...e, s: byId.get(e.from), t: byId.get(e.to) })).filter(l => l.s && l.t);
        for (let step = 0; step < 300; step += 1) {
            for (let i = 0; i < nodes.length; i += 1) {
                for (let j = i + 1; j < nodes.length; j += 1) {
                    const a = nodes[i]; const b = nodes[j];
                    let dx = a.x - b.x; let dy = a.y - b.y;
                    const d2 = Math.max(dx * dx + dy * dy, 25);
                    const f = 2600 / d2;
                    const d = Math.sqrt(d2);
                    dx /= d; dy /= d;
                    a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
                }
            }
            links.forEach(l => {
                const dx = l.t.x - l.s.x; const dy = l.t.y - l.s.y;
                const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
                const f = (d - 120) * 0.02;
                l.s.vx += (dx / d) * f; l.s.vy += (dy / d) * f; l.t.vx -= (dx / d) * f; l.t.vy -= (dy / d) * f;
            });
            nodes.forEach(n => {
                if (n.centre) { n.x = W / 2; n.y = H / 2; n.vx = 0; n.vy = 0; return; }
                n.vx += (W / 2 - n.x) * 0.002; n.vy += (H / 2 - n.y) * 0.002;
                n.x = Math.min(W - 30, Math.max(30, n.x + n.vx * 0.5)); n.y = Math.min(H - 24, Math.max(24, n.y + n.vy * 0.5));
                n.vx *= 0.6; n.vy *= 0.6;
            });
        }
        const ns = 'http://www.w3.org/2000/svg';
        const make = (tag, attrs) => { const node = document.createElementNS(ns, tag); Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v)); return node; };
        svg.replaceChildren();
        const defs = make('defs', {});
        const marker = make('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: '19', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
        marker.appendChild(make('path', { d: 'M0 0 10 5 0 10z', class: 'arrow' }));
        defs.appendChild(marker);
        svg.appendChild(defs);
        const maxTotal = Math.max(1, ...links.map(l => l.total));
        links.forEach(l => {
            const line = make('line', { x1: l.s.x, y1: l.s.y, x2: l.t.x, y2: l.t.y, class: `edge${l.pending ? ' held' : ''}`, 'stroke-width': 1.5 + (l.total / maxTotal) * 4, 'marker-end': 'url(#arrow)' });
            const title = make('title', {});
            title.textContent = `${l.s.name} → ${l.t.name}: ${kes(l.total)} in ${l.count} payment${l.count === 1 ? '' : 's'}`;
            line.appendChild(title);
            svg.appendChild(line);
        });
        nodes.forEach(n => {
            const g = make('g', { class: 'node', tabindex: '0' });
            const tone = n.centre ? 'centre' : (n.confirmedIn || n.reports || n.frozen) ? 'bad' : n.openAlerts ? 'ok' : 'idle';
            g.appendChild(make('circle', { cx: n.x, cy: n.y, r: n.centre ? 12 : 9, class: `node-${tone}` }));
            const label = make('text', { x: n.x, y: n.y - 15, class: 'node-label' });
            label.textContent = n.name.length > 18 ? `${n.name.slice(0, 17)}…` : n.name;
            g.appendChild(label);
            const title = make('title', {});
            title.textContent = `${n.name} (${n.email}) · balance ${kes(n.balance)}${n.reports ? ` · reported by ${n.reports}` : ''}${n.openAlerts ? ` · ${n.openAlerts} open alerts` : ''}${n.frozen ? ' · frozen' : ''}`;
            g.appendChild(title);
            g.addEventListener('click', () => { $('networkAccount').value = n.email; showNetwork(); });
            svg.appendChild(g);
        });
    }

    // ================= MODELS =================
    let modelPoll = null;

    function metricsList(metrics) {
        const box = el('div', 'metric-grid');
        if (!metrics) return box;
        Object.entries(metrics).forEach(([name, m]) => {
            if (!m) return;
            const card = el('div', 'metric');
            card.appendChild(el('span', 'mono', name === 'paysim_realistic' ? 'PaySim test set, ~1% fraud' : name === 'live_holdout' ? 'Held-back live labels' : name === 'paysim_split' ? 'PaySim split' : name));
            card.appendChild(el('strong', null, `F1 ${Number(m.f1).toFixed(3)}`));
            card.appendChild(el('span', null, `precision ${Number(m.precision).toFixed(3)} · recall ${Number(m.recall).toFixed(3)} · ${m.n} records`));
            box.appendChild(card);
        });
        return box;
    }

    LOADERS.models = async () => {
        clearTimeout(modelPoll);
        const d = await call('/api/admin/models');
        const champ = $('championCard');
        const head = el('div', 'console-head');
        head.append(el('span', 'mono', 'Champion: in charge'), el('span', 'mono', d.champion.version));
        champ.replaceChildren(head, el('p', 'hint', `${d.champion.notes || ''} Trained ${d.champion.trained_at ? formatDate(d.champion.trained_at) : 'with the notebook'}.`), metricsList(d.champion.metrics));
        const labels = d.labels;
        champ.appendChild(el('p', 'hint', `Labelled examples available: ${labels.fraud} fraud and ${labels.legit} legitimate (alerts ${labels.alert}, disputes ${labels.dispute}, API clients ${labels.api}).`));
        const retrain = button(d.job.state === 'running' ? 'Retraining…' : 'Retrain from decisions', null, async (b) => {
            b.disabled = true;
            try { await call('/api/admin/models/retrain', { method: 'POST' }); toast('Retraining started', 'A challenger will appear in a few seconds'); LOADERS.models(); } catch (error) { fail(error); b.disabled = false; }
        });
        retrain.disabled = d.job.state === 'running';
        const tools = el('div', 'model-tools');
        tools.appendChild(retrain);
        if (d.archive && d.archive.length) {
            tools.appendChild(button('Roll back to the previous model', 'quiet small', async () => {
                try { const r = await call('/api/admin/models/rollback', { method: 'POST' }); toast('Rolled back', `Now ${r.champion}`); LOADERS.models(); } catch (error) { fail(error); }
            }));
        }
        champ.appendChild(tools);
        if (d.job.state === 'failed') champ.appendChild(el('p', 'message error', `Last retraining failed: ${d.job.error}`));

        const chal = $('challengerCard');
        const chead = el('div', 'console-head');
        chead.append(el('span', 'mono', 'Challenger: scoring in shadow'), el('span', 'mono', d.challenger ? d.challenger.version : 'none'));
        if (!d.challenger) {
            chal.replaceChildren(chead, el('p', 'hint', d.job.state === 'running' ? 'Training…' : 'No challenger yet. Retrain from analyst decisions to build one. It will score every payment beside the champion without affecting any decision.'));
        } else {
            const s = d.shadow || {};
            chal.replaceChildren(chead, el('p', 'hint', d.challenger.notes), metricsList(d.challenger.metrics));
            if (d.comparison && d.comparison.metrics) {
                chal.appendChild(el('span', 'mono sub', `Champion on the same tests`));
                chal.appendChild(metricsList(d.comparison.metrics));
            }
            chal.appendChild(el('span', 'mono sub', 'Live shadow comparison'));
            chal.appendChild(el('p', 'hint', s.scored
                ? `Scored ${s.scored} live payments: agrees with the champion on ${Math.round(s.agreement * 100)}% at the 0.5 threshold, average score difference ${s.meanDifference}. Champion flagged ${s.championFlags}, challenger ${s.challengerFlags}.`
                : 'No live payments scored by the challenger yet.'));
            const ctools = el('div', 'model-tools');
            ctools.appendChild(button('Promote to champion', null, async (b) => {
                if (b.dataset.sure !== 'yes') { b.dataset.sure = 'yes'; b.textContent = 'Click again to promote'; return; }
                try { const r = await call('/api/admin/models/promote', { method: 'POST' }); toast('Promoted', `${r.champion} now scores every payment`); LOADERS.models(); } catch (error) { fail(error); }
            }));
            ctools.appendChild(button('Discard', 'quiet', async () => {
                try { await call('/api/admin/models/discard', { method: 'POST' }); toast('Challenger discarded', ''); LOADERS.models(); } catch (error) { fail(error); }
            }));
            chal.appendChild(ctools);
        }
        if (d.job.state === 'running') modelPoll = setTimeout(() => { if (!$('championCard').closest('[data-panel]').hidden) LOADERS.models().catch(fail); }, 2000);

        try {
            const drift = await call('/api/admin/models/drift');
            $('driftN').textContent = drift.n ? `${drift.n} recent payments · model ${drift.version || ''}` : '';
            const features = Object.entries(drift.features || {});
            if (!features.length) { $('drift').replaceChildren(el('p', 'hint', drift.note || 'Not enough scored payments yet.')); return; }
            const max = Math.max(0.3, ...features.map(([, f]) => f.psi));
            $('drift').replaceChildren(...features.map(([name, f]) => {
                const r = el('div', 'contrib-row drift-row');
                r.appendChild(el('span', 'contrib-name', FEATURE_LABEL[name] || name));
                const track = el('span', 'contrib-track');
                const bar = el('i', f.status === 'stable' ? 'down' : f.status === 'moderate' ? 'mid' : 'up');
                bar.style.width = `${Math.max(2, (Math.min(f.psi, max) / max) * 100)}%`;
                bar.title = `PSI ${f.psi}`;
                track.appendChild(bar);
                r.appendChild(track);
                const value = el('span', 'contrib-num mono');
                value.appendChild(dotLabel(f.status === 'stable' ? 'safe' : f.status === 'moderate' ? 'warn' : 'bad', `${f.psi.toFixed(2)} ${f.status}`));
                r.appendChild(value);
                return r;
            }));
        } catch (error) {
            $('drift').replaceChildren(el('p', 'hint', error.message));
        }
    };

    // ================= ATTACK LAB =================
    const OUTCOME = {
        allowed: ['safe', 'Allowed'], verified: ['safe', 'Verified with PIN'], flagged: ['warn', 'Flagged for review'],
        challenged: ['warn', 'Stopped: PIN required'], held: ['bad', 'Held for review'], unscored: ['idle', 'Not scored'],
        not_run: ['idle', 'Did not run'], prevented: ['safe', 'Prevented by an earlier stop'],
        cooling_off: ['warn', 'Cooling off: sender can cancel'], purpose_asked: ['warn', 'Stopped: asked what it is for'],
    };
    let lastEval = null;

    function renderRun(result) {
        const s = result.summary;
        $('labResult').hidden = false;
        $('labResultTitle').textContent = result.scenario.title;
        $('labResultMode').textContent = result.mode === 'enforce' ? 'Enforcing' : 'Advisory';
        const stat = (label, value, tone) => { const b = el('div', 'lab-stat' + (tone ? ' ' + tone : '')); b.append(el('span', 'mono', label), el('strong', null, value)); return b; };
        const stats = [];
        if (s.attackSteps) {
            stats.push(stat('Attack steps caught', `${s.detected} of ${s.attackSteps}`, s.detected === s.attackSteps ? 'good' : 'poor'));
            stats.push(stat('Model alone would catch', `${s.modelAlone} of ${s.attackSteps}`));
            stats.push(stat('Money stopped', result.mode === 'enforce' ? `${formatMoney(s.stopped)} of ${formatMoney(s.attempted)}` : 'None: advisory mode only flags', result.mode === 'enforce' && s.stopped > 0 ? 'good' : ''));
        }
        if (s.normalSteps) stats.push(stat('False alarms', `${s.falsePositives} of ${s.normalSteps}`, s.falsePositives === 0 ? 'good' : 'poor'));
        $('labSummary').replaceChildren(...stats);
        $('labTrace').replaceChildren(...result.steps.map(step => {
            const [tone, label] = OUTCOME[step.outcome] || ['idle', step.outcome];
            const li = el('li', 'trace-step');
            const head = el('div', 'trace-head');
            head.appendChild(el('strong', null, step.label));
            const out = el('span', 'mono'); out.appendChild(dotLabel(tone, label)); head.appendChild(out);
            li.appendChild(head);
            const what = step.kind === 'transfer' ? `${step.actor} sends ${formatMoney(step.amount)} to ${step.to}` : step.kind === 'withdrawal' ? `${step.actor} withdraws ${formatMoney(step.amount)}` : `${step.actor} sends ${formatMoney(step.amount)} to a bank`;
            const line = el('div', 'trace-what', what);
            if (step.risk !== null && step.risk !== undefined) {
                line.append(' ', meter(step.risk, step.detected ? 'high' : 'low'), el('span', 'mono', ` risk ${Number(step.risk).toFixed(2)}${step.modelScore !== null && step.modelScore !== undefined ? ' · model alone ' + Number(step.modelScore).toFixed(2) : ''}`));
            }
            li.appendChild(line);
            if (step.reasons && step.reasons.length) li.appendChild(el('div', 'trace-why', step.reasons.join(' · ')));
            const miss = (step.expect === 'detect' && !step.detected) || (step.expect === 'pass' && step.detected);
            if (miss) li.appendChild(el('div', 'trace-miss', step.expect === 'detect' ? 'Missed: this step should have been caught.' : 'False alarm: this step is ordinary behaviour.'));
            return li;
        }));
    }

    LOADERS.lab = async () => {
        const lab = await call('/api/admin/lab');
        riskMode = lab.mode;
        paintMode();
        $('labOff').hidden = lab.enabled;
        $('labOn').hidden = !lab.enabled;
        $('scenarioList').replaceChildren(...lab.scenarios.map(scenario => {
            const li = el('li', 'console scenario');
            li.append(el('span', 'mono', scenario.attack ? 'Attack' : 'Control'), el('h3', null, scenario.title), el('p', null, scenario.description));
            li.appendChild(button('Run scenario', 'small', async (b) => {
                const all = [...document.querySelectorAll('.scenario button'), $('labCleanup'), $('runAll')];
                all.forEach(x => { x.disabled = true; });
                b.textContent = 'Running…';
                try {
                    renderRun(await call('/api/admin/lab/run', { method: 'POST', body: JSON.stringify({ scenario: scenario.id }) }));
                    $('labResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
                } catch (error) { setMessage($('labMessage'), error.message, 'error'); } finally {
                    all.forEach(x => { x.disabled = false; });
                    b.textContent = 'Run scenario';
                }
            }));
            return li;
        }));
    };

    $('runAll').addEventListener('click', async (event) => {
        const b = event.currentTarget;
        b.disabled = true; b.textContent = 'Running every scenario…';
        try {
            lastEval = await call('/api/admin/lab/run-all', { method: 'POST' });
            const t = lastEval.total;
            $('evalWhen').textContent = `${lastEval.mode === 'enforce' ? 'Enforcing' : 'Advisory'} · ${formatDate(lastEval.ranAt)}`;
            $('evalTable').hidden = false;
            table($('evalTable'), ['Scenario', { label: 'Caught', className: 'num' }, { label: 'Model alone', className: 'num' }, { label: 'False alarms', className: 'num' }, { label: 'Money stopped', className: 'num' }],
                [...lastEval.rows.map(r => [r.scenario.title, { text: r.summary.attackSteps ? `${r.summary.detected} / ${r.summary.attackSteps}` : '–', className: 'num' },
                    { text: r.summary.attackSteps ? `${r.summary.modelAlone} / ${r.summary.attackSteps}` : '–', className: 'num' },
                    { text: r.summary.normalSteps ? `${r.summary.falsePositives} / ${r.summary.normalSteps}` : '–', className: 'num' },
                    { text: r.summary.attempted ? `${formatMoney(r.summary.stopped)} of ${formatMoney(r.summary.attempted)}` : '–', className: 'num' }]),
                ['All scenarios', { text: `${t.detected} / ${t.attackSteps}`, className: 'num' }, { text: `${t.modelAlone} / ${t.attackSteps}`, className: 'num' },
                    { text: `${t.falsePositives} / ${t.normalSteps}`, className: 'num' }, { text: `${formatMoney(t.stopped)} of ${formatMoney(t.attempted)}`, className: 'num' }]]);
            $('exportEval').disabled = false;
        } catch (error) { setMessage($('labMessage'), error.message, 'error'); } finally { b.disabled = false; b.textContent = 'Run every scenario'; }
    });

    $('exportEval').addEventListener('click', () => {
        if (!lastEval) return;
        const lines = [['scenario', 'attack_steps', 'caught', 'model_alone', 'normal_steps', 'false_alarms', 'attempted', 'stopped', 'mode', 'ran_at']];
        lastEval.rows.forEach(r => lines.push([r.scenario.id, r.summary.attackSteps, r.summary.detected, r.summary.modelAlone, r.summary.normalSteps, r.summary.falsePositives, r.summary.attempted, r.summary.stopped, lastEval.mode, lastEval.ranAt]));
        const blob = new Blob([lines.map(l => l.join(',')).join('\r\n')], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `attack-lab-evaluation-${lastEval.ranAt.slice(0, 10)}.csv`;
        document.body.appendChild(a); a.click(); a.remove();
    });

    $('labCleanup').addEventListener('click', async (event) => {
        const b = event.currentTarget; b.disabled = true;
        try {
            const r = await call('/api/admin/lab/cleanup', { method: 'POST' });
            $('labResult').hidden = true;
            setMessage($('labMessage'), r.removed ? `Removed ${r.removed} lab accounts with their transactions and alerts.` : 'There was no lab data to remove.', 'success');
        } catch (error) { setMessage($('labMessage'), error.message, 'error'); } finally { b.disabled = false; }
    });

    // ================= LEDGER =================
    function paintRun(run) {
        const card = $('reconCard');
        const head = el('div', 'console-head');
        head.append(el('span', 'mono', 'Reconciliation'), el('span', 'mono', run ? `#${run.id} · ${run.trigger_source || 'manual'} · ${formatDate(run.finished_at || run.started_at)}` : ''));
        const parts = [head];
        if (!run) parts.push(el('p', 'hint', 'Not run yet.'));
        else {
            const status = el('p', 'recon-status');
            status.appendChild(dotLabel(run.ok ? 'safe' : 'bad', run.ok ? 'The books balance' : `${run.issues.length} problems found`));
            parts.push(status);
            const s = run.summary || {};
            const rows = [
                ['Journal entries verified', s.journalChain ? s.journalChain.checked : '–'],
                ['Audit records verified', s.auditChain ? s.auditChain.checked : '–'],
                ['Wallets matched', s.wallets ? s.wallets.accounts : '–'],
                ['Savings goals, loans, chamas', s.savings ? `${s.savings.accounts}, ${s.loans.accounts}, ${s.chamas.accounts}` : '–'],
                ['Took', s.durationMs !== undefined ? `${s.durationMs} ms` : '–'],
            ];
            const ul = el('ul', 'console-rows');
            rows.forEach(([a, b]) => { const li = el('li'); li.append(el('span', null, a), el('span', 'mono', String(b))); ul.appendChild(li); });
            parts.push(ul);
            if (run.issues.length) {
                const list = el('ul', 'simple-list');
                run.issues.slice(0, 15).forEach(i => { const li = el('li'); li.append(el('span', null, i.detail), el('span', 'mono', `${i.check} ${i.id ?? ''}`)); list.appendChild(li); });
                parts.push(list);
            }
        }
        parts.push(button('Reconcile now', 'full', async (b) => {
            b.disabled = true;
            try { const r = await call('/api/admin/ledger/reconcile', { method: 'POST' }); toast(r.ok ? 'The books balance' : 'Problems found', `${r.summary.lines} journal lines checked`, !r.ok); LOADERS.ledger(); } catch (error) { fail(error); b.disabled = false; }
        }));
        card.replaceChildren(...parts);
        const pos = $('positionsCard');
        const ph = el('div', 'console-head');
        ph.append(el('span', 'mono', 'Positions'), el('span', 'mono', 'Sum of each kind of account'));
        const NAMES = { wallet: 'Customer wallets', savings: 'Savings goals', loan: 'Loans (repaid minus lent)', held: 'Held or cooling off', chama: 'Chama pots' };
        const list = el('ul', 'console-rows');
        ((run && run.summary && run.summary.positions) || []).forEach(p => {
            const li = el('li');
            li.append(el('span', null, NAMES[p.account] || p.account), el('span', 'mono', formatMoney(p.total)));
            list.appendChild(li);
        });
        pos.replaceChildren(ph, list, el('p', 'hint', 'Every entry adds up to zero, so these add up to zero too: money in customer accounts is matched by the money that came in from outside.'));
    }

    LOADERS.ledger = async () => {
        const d = await call('/api/admin/ledger');
        paintRun(d.runs[0]);
        $('headHash').textContent = `head ${d.head.lastHash.slice(0, 16)}…`;
        $('headHash').title = d.head.lastHash;
        table($('journalTable'), ['#', 'Time', 'Kind', 'Transaction', 'Lines'], d.entries.map(e => [
            String(e.id), formatDate(e.created_at), e.kind.replace(/_/g, ' '), e.transaction_id ? reference(e.transaction_id) : '–',
            e.lines.map(l => `${l.account} ${l.amount > 0 ? '+' : ''}${formatMoney(l.amount)}`).join('   '),
        ]));
    };

    // ================= AUDIT =================
    let auditBefore = null;
    async function loadAudit(more) {
        const filter = $('auditFilter').value;
        const params = new URLSearchParams();
        if (filter) params.set('action', filter);
        if (more && auditBefore) params.set('before', auditBefore);
        const d = await call(`/api/admin/audit?${params}`);
        const rows = d.entries.map(a => [String(a.id), formatDate(a.created_at), a.actor_name ? `${a.actor_name} (${a.actor_role})` : (a.actor_role || 'system'),
            a.action, a.target_type ? `${a.target_type} ${a.target_id || ''}` : '', a.details ? a.details.slice(0, 120) : '', { text: a.hash.slice(0, 10), className: 'mono' }]);
        const headers = ['#', 'Time', 'Who', 'Action', 'Target', 'Details', 'Hash'];
        if (more) {
            const tableNode = $('auditTable');
            const temp = el('table');
            table(temp, headers, rows);
            [...temp.querySelectorAll('tr')].slice(1).forEach(tr => tableNode.appendChild(tr));
        } else table($('auditTable'), headers, rows);
        auditBefore = d.entries.length ? d.entries[d.entries.length - 1].id : null;
        $('auditMore').hidden = d.entries.length < 50;
    }
    LOADERS.audit = () => loadAudit(false);
    $('auditFilter').addEventListener('change', () => loadAudit(false).catch(fail));
    $('auditMore').addEventListener('click', () => loadAudit(true).catch(fail));
    $('verifyChain').addEventListener('click', async (event) => {
        const b = event.currentTarget; b.disabled = true;
        try {
            const r = await call('/api/admin/audit/verify', { method: 'POST' });
            setMessage($('verifyResult'), r.ok
                ? `Both chains are intact: ${r.journal.checked} journal entries and ${r.audit.checked} audit records verified.`
                : `Tampering detected: ${r.issues.slice(0, 3).map(i => `${i.check} #${i.id}: ${i.detail}`).join('; ')}`, r.ok ? 'success' : 'error');
        } catch (error) { fail(error); } finally { b.disabled = false; }
    });

    // ================= SYSTEM =================
    LOADERS.system = async () => {
        const d = await call('/api/admin/system');
        const hours = Math.floor(d.uptimeSeconds / 3600);
        const minutes = Math.floor((d.uptimeSeconds % 3600) / 60);
        $('systemTiles').replaceChildren(
            tile('Uptime', `${hours}h ${minutes}m`, `Node ${d.node} · ${d.memoryMb} MB`),
            tile('Scoring model', d.model ? 'Up' : 'Down', d.model ? `${d.model.version}${d.model.challenger ? ` · challenger ${d.model.challenger}` : ''}` : 'Payments are recorded unscored', d.model ? 'safe' : 'bad'),
            tile('Unscored backlog', String(d.unscoredBacklog), 'Retried every 30 seconds', d.unscoredBacklog ? 'warn' : 'safe'),
            tile('Webhooks waiting', String(d.webhooks.pending), `${d.webhooks.failed} failed after retries`, d.webhooks.failed ? 'warn' : null),
            tile('Live connections', String(d.streams.streams), `${d.streams.admins} administrators`),
            tile('Modes', d.riskMode === 'enforce' ? 'Enforcing' : 'Advisory', `M-Pesa ${d.mpesaMode}`),
        );
        const names = { payment_ms: 'Payment, end to end', model_score_ms: 'Fraud model call', api_assess_ms: 'Fraud API assessment' };
        table($('latencyTable'), ['Route', { label: 'Calls', className: 'num' }, { label: 'Median', className: 'num' }, { label: '95th', className: 'num' }, { label: '99th', className: 'num' }, { label: 'Slowest', className: 'num' }],
            d.series.map(s => [names[s.name] || s.name, { text: String(s.count), className: 'num' }, { text: String(s.p50), className: 'num' }, { text: String(s.p95), className: 'num' }, { text: String(s.p99), className: 'num' }, { text: String(s.max), className: 'num' }]));
    };
    $('systemRefresh').addEventListener('click', () => LOADERS.system().catch(fail));

    // ================= API CLIENTS =================
    function showSecret(lines) {
        const box = $('secretBox');
        box.hidden = false;
        box.replaceChildren(el('strong', null, 'Copy these now. They will not be shown again.'), ...lines.map(([label, value]) => {
            const p = el('p');
            p.append(el('span', 'mono', `${label}: `), el('code', null, value));
            return p;
        }));
        box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    LOADERS.api = async () => {
        const d = await call('/api/admin/api-clients');
        $('clientList').replaceChildren(...(d.clients.length ? d.clients.map(c => {
            const card = el('article', 'console client');
            const head = el('div', 'console-head');
            const state = el('span', 'mono');
            state.appendChild(dotLabel(c.status === 'active' ? 'safe' : 'bad', c.status));
            head.append(el('span', 'mono', `${c.name} · client ${c.id}`), state);
            card.appendChild(head);
            card.appendChild(el('p', 'hint', `${c.assessments} assessments · ${c.labelled} labelled · ${c.rate_limit_per_minute} requests a minute · last used ${c.last_used_at ? formatDate(c.last_used_at) : 'never'}${c.contact_email ? ` · ${c.contact_email}` : ''}`));

            const keys = el('table', 'data-table');
            table(keys, ['Key', 'Label', 'Created', 'Last used', ''], c.keys.map(k => [
                { text: `${k.prefix}…`, className: 'mono' }, k.label || '', formatDate(k.created_at), k.last_used_at ? formatDate(k.last_used_at) : 'never',
                k.revoked_at ? 'Revoked' : button('Revoke', 'quiet small', async () => { await call(`/api/admin/api-clients/${c.id}/keys/${k.id}`, { method: 'DELETE' }).catch(fail); LOADERS.api(); }),
            ]));
            card.appendChild(keys);

            const hook = el('form', 'inline-form');
            hook.noValidate = true;
            const url = el('input');
            url.type = 'url'; url.placeholder = 'https://example.com/webhooks/securewallet'; url.value = c.webhook_url || '';
            url.setAttribute('aria-label', 'Webhook URL');
            const save = el('button', 'quiet', 'Save webhook');
            save.type = 'submit';
            hook.append(url, save);
            hook.addEventListener('submit', async (event) => {
                event.preventDefault();
                try { await call(`/api/admin/api-clients/${c.id}`, { method: 'PATCH', body: JSON.stringify({ webhookUrl: url.value.trim() || null }) }); toast('Webhook saved', ''); } catch (error) { fail(error); }
            });
            card.appendChild(el('span', 'mono sub', 'Webhook for flagged assessments'));
            card.appendChild(hook);

            const tools = el('div', 'model-tools');
            tools.appendChild(button('New key', 'small', async () => { try { const r = await call(`/api/admin/api-clients/${c.id}/keys`, { method: 'POST', body: JSON.stringify({ label: 'Created in the console' }) }); showSecret([['API key', r.apiKey]]); LOADERS.api(); } catch (error) { fail(error); } }));
            tools.appendChild(button('Send test event', 'quiet small', async () => {
                try { const r = await call(`/api/admin/api-clients/${c.id}/webhook/test`, { method: 'POST' }); toast(r.status === 'delivered' ? 'Test event delivered' : 'Test event not delivered', r.last_error || `HTTP ${r.last_status_code}`, r.status !== 'delivered'); } catch (error) { fail(error); }
            }));
            tools.appendChild(button('New webhook secret', 'quiet small', async () => { try { const r = await call(`/api/admin/api-clients/${c.id}/webhook/rotate`, { method: 'POST' }); showSecret([['Webhook secret', r.webhookSecret]]); } catch (error) { fail(error); } }));
            tools.appendChild(button(c.status === 'active' ? 'Suspend' : 'Reactivate', 'quiet small', async () => { await call(`/api/admin/api-clients/${c.id}`, { method: 'PATCH', body: JSON.stringify({ status: c.status === 'active' ? 'suspended' : 'active' }) }).catch(fail); LOADERS.api(); }));
            tools.appendChild(button('Deliveries', 'quiet small', async (b) => {
                const holder = card.querySelector('.deliveries') || card.appendChild(el('div', 'deliveries table-wrap'));
                if (holder.childElementCount) { holder.replaceChildren(); return; }
                const r = await call(`/api/admin/api-clients/${c.id}/deliveries`).catch(fail);
                const t = el('table', 'data-table');
                table(t, ['#', 'Event', 'Status', 'Attempts', 'Result', 'Created'], (r ? r.deliveries : []).map(x => [String(x.id), x.event_type, x.status, String(x.attempts), x.last_error || (x.last_status_code ? `HTTP ${x.last_status_code}` : ''), formatDate(x.created_at)]));
                holder.appendChild(t);
                b.blur();
            }));
            card.appendChild(tools);
            return card;
        }) : [el('p', 'console empty', 'No clients yet. Add one to issue an API key.')]));
    };

    $('clientForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
            const r = await call('/api/admin/api-clients', { method: 'POST', body: JSON.stringify({ name: $('clientName').value.trim(), contactEmail: $('clientEmail').value.trim() }) });
            event.target.reset();
            showSecret([['API key', r.apiKey], ['Webhook secret', r.webhookSecret]]);
            LOADERS.api();
        } catch (error) { fail(error); }
    });

    // ================= SURVEY =================
    const STATEMENTS = [
        'I would like to use SecureWallet frequently', 'SecureWallet is unnecessarily complex', 'SecureWallet is easy to use',
        'I would need help from a technical person to use it', 'Its functions are well integrated', 'There is too much inconsistency',
        'Most people would learn to use it very quickly', 'It is very cumbersome to use', 'I felt very confident using it',
        'I needed to learn a lot before I could get going',
    ];
    LOADERS.survey = async () => {
        const d = await call('/api/admin/survey');
        const tiles = [tile('Responses', String(d.n), 'All participants'), tile('Mean SUS score', d.meanScore === null ? 'n/a' : String(d.meanScore), 'Out of 100; about 68 is average')];
        Object.entries(d.byRole).forEach(([role, r]) => tiles.push(tile(role === 'analyst' ? 'Analysts' : 'Wallet users', String(r.meanScore), `${r.n} responses`)));
        $('surveyTiles').replaceChildren(...tiles);
        const roles = Object.keys(d.byRole);
        table($('surveyTable'), ['Statement', ...roles.map(r => ({ label: r === 'analyst' ? 'Analysts' : 'Users', className: 'num' }))],
            STATEMENTS.map((s, i) => [`${i + 1}. ${s}`, ...roles.map(r => ({ text: d.byRole[r].itemMeans[i].toFixed(2), className: 'num' }))]));
        $('surveyComments').replaceChildren(...(d.comments.length ? d.comments.map(c => { const li = el('li'); li.append(el('span', null, c.comment), el('span', 'mono', `${c.role} · SUS ${c.score}`)); return li; }) : [el('li', 'empty', 'No comments yet.')]));
    };

    // ================= two-factor gate =================
    async function showGate() {
        document.querySelectorAll('[data-panel]').forEach(p => { p.hidden = true; });
        $('mfaGate').hidden = false;
        if ($('gateQr').src) return;
        try {
            const d = await api('/api/auth/2fa/setup', { method: 'POST' });
            $('gateQr').src = d.qr;
            $('gateSecret').textContent = d.secret.replace(/(.{4})/g, '$1 ').trim();
        } catch (error) { setMessage($('gateMessage'), error.message, 'error'); }
    }
    $('gateEnable').addEventListener('click', async () => {
        try {
            await api('/api/auth/2fa/enable', { method: 'POST', body: JSON.stringify({ code: $('gateCode').value.trim(), password: $('gatePassword').value }) });
            $('mfaGate').hidden = true;
            showSection();
        } catch (error) { setMessage($('gateMessage'), error.message, 'error'); }
    });

    // ================= live updates =================
    function connectLive() {
        if (!window.EventSource) return;
        const source = new EventSource('/api/events');
        source.addEventListener('ready', () => $('liveState').replaceChildren(dotLabel('safe', 'Live')));
        source.onerror = () => $('liveState').replaceChildren(dotLabel('idle', 'Reconnecting'));
        source.addEventListener('alert.created', (event) => {
            const d = JSON.parse(event.data);
            toast('New alert', `${kes(d.amount || 0)}${d.risk !== undefined ? ` · risk ${Number(d.risk).toFixed(2)}` : ''}${d.late ? ' · scored late' : ''}`, true);
            if (location.hash === '#alerts' || location.hash === '') LOADERS[location.hash === '' ? 'overview' : 'alerts']().catch(() => {});
            else loadAlerts().catch(() => {});
        });
        source.addEventListener('alert.updated', () => { if (location.hash === '#alerts') loadAlerts().catch(() => {}); });
        source.addEventListener('dispute.created', () => { toast('New dispute', 'A customer says a payment was not them', true); if (location.hash === '#cases') loadCases().catch(() => {}); });
        source.addEventListener('report.created', () => { if (location.hash === '#cases') loadCases().catch(() => {}); });
        source.addEventListener('reconciliation.finished', (event) => { const d = JSON.parse(event.data); toast(d.ok ? 'Reconciliation: the books balance' : 'Reconciliation found problems', `Run #${d.id}`, !d.ok); });
    }

    (async () => {
        const user = await requireUser('admin');
        if (!user) return;
        $('userName').textContent = user.name;
        if (user.mustSetUp2fa) { showGate(); return; }
        try {
            const status = await api('/api/status');
            riskMode = status.riskMode;
        } catch (error) { /* keep default */ }
        paintMode();
        showSection();
        loadAlerts().catch(() => {});
        connectLive();
    })();
})();
