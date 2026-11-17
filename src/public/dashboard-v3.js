// SecureWallet dashboard, version 3 additions: live notifications, the
// frozen-account and new-device banners, M-Pesa deposits, receipts with
// "This wasn't me", "Report this account" and "Cancel", the Security page
// (devices, two-factor sign-in, mobile number, freezing the account, data
// download), chamas and the language switch.
//
// Uses the helpers app.js shares on window.SW.

(function () {
    if (document.body.dataset.page !== 'dashboard' || !window.SW) return;
    const SW = window.SW;
    const { api, el, toast, formatMoney, formatDate, setMessage, failText, handleAuth, dotLabel } = SW;
    const t = (text, values) => SW.t(text, values);
    const $ = id => document.getElementById(id);
    let me = null;

    // ---------- notifications and live updates ----------
    let unread = 0;
    const MONEY_EVENTS = new Set(['money_received', 'payment_released', 'payment_returned', 'mpesa_deposit', 'chama_paid', 'dispute_decided']);

    function paintCount() {
        $('bellCount').hidden = unread === 0;
        $('bellCount').textContent = unread > 9 ? '9+' : String(unread);
    }

    function noteItem(n) {
        const li = el('li', n.read_at ? '' : 'unread');
        li.appendChild(el('strong', null, n.title));
        if (n.body) li.appendChild(el('span', null, n.body));
        li.appendChild(el('span', 'mono', formatDate(n.created_at)));
        return li;
    }

    async function loadNotifications() {
        const data = await api('/api/notifications');
        unread = data.unread;
        paintCount();
        $('notifList').replaceChildren(...(data.notifications.length
            ? data.notifications.map(noteItem) : [el('li', 'empty', t('Nothing yet. Money you receive and security alerts appear here.'))]));
    }

    $('bellButton').addEventListener('click', async () => {
        const panel = $('notifPanel');
        panel.hidden = !panel.hidden;
        $('bellButton').setAttribute('aria-expanded', String(!panel.hidden));
        if (!panel.hidden && unread) {
            await api('/api/notifications/read', { method: 'POST' }).catch(() => {});
            unread = 0;
            paintCount();
        }
    });
    document.addEventListener('click', (event) => {
        if (!event.target.closest('.bell-wrap')) $('notifPanel').hidden = true;
    });

    function connectLive() {
        if (!window.EventSource) return;
        const source = new EventSource('/api/events');
        source.addEventListener('ready', () => $('liveState').replaceChildren(dotLabel('safe', t('Live'))));
        source.addEventListener('notification', (event) => {
            const n = JSON.parse(event.data);
            unread += 1;
            paintCount();
            const list = $('notifList');
            const empty = list.querySelector('.empty');
            if (empty) empty.remove();
            list.prepend(noteItem(n));
            toast(n.title, n.body || '', /frozen|held|new_device|returned/.test(n.kind));
            if (MONEY_EVENTS.has(n.kind)) SW.refreshHome().catch(() => {});
            if (n.kind === 'account_frozen' || n.kind === 'account_restored') refreshMe();
        });
        source.onerror = () => $('liveState').replaceChildren(dotLabel('idle', t('Reconnecting')));
    }

    // ---------- banners ----------
    function paintBanners() {
        const frozen = $('frozenBanner');
        frozen.hidden = !me.frozen;
        if (me.frozen) {
            frozen.replaceChildren(dotLabel('bad', t('Your account is frozen: no money can leave it. {reason}', { reason: me.frozenReason ? `(${me.frozenReason})` : '' })));
        }
        const device = $('deviceBanner');
        device.hidden = !me.newDevice || me.frozen;
        if (me.newDevice) {
            device.replaceChildren(dotLabel('ok', t('You signed in on a new device. For the next 24 hours, unusual payments from it get extra checks.')));
        }
    }

    async function refreshMe() {
        try {
            me = (await api('/api/auth/me')).user;
            SW.hasPin = me.hasPin;
            paintBanners();
            paintSecurityExtras();
        } catch (error) {
            handleAuth(error);
        }
    }

    // ---------- receipts: cancel, "This wasn't me", report ----------
    const DISPUTABLE = ['transfer', 'withdrawal', 'bank_transfer', 'payment'];

    function receiptActions(tx, state) {
        const box = $('receiptExtra');
        box.replaceChildren();
        const buttons = el('div', 'receipt-buttons');
        const message = el('p', 'message');
        message.setAttribute('role', 'status');

        if (state && state.cooling) {
            const cancel = el('button', 'small', t('Cancel this payment'));
            cancel.type = 'button';
            cancel.addEventListener('click', async () => {
                cancel.disabled = true;
                try {
                    await api(`/api/wallet/transactions/${tx.id}/cancel`, { method: 'POST' });
                    SW.closeReceipt();
                    toast(t('Payment cancelled'), t('The money is back in your wallet'));
                    await SW.refreshHome();
                } catch (error) {
                    setMessage(message, failText(error), 'error');
                    cancel.disabled = false;
                }
            });
            buttons.appendChild(cancel);
        }

        const age = Date.now() - new Date(tx.created_at).getTime();
        if (tx.direction === 'out' && DISPUTABLE.includes(tx.type) && !tx.dispute && age < 30 * 86400000) {
            const dispute = el('button', 'quiet small', t("This wasn't me"));
            dispute.type = 'button';
            dispute.addEventListener('click', () => {
                buttons.hidden = true;
                const form = el('div', 'inline-panel');
                form.appendChild(el('p', null, t('We will freeze your account straight away so no more money can leave it, return any payment that is still waiting, and an analyst will look into this one.')));
                const reason = el('input');
                reason.placeholder = t('What happened? (optional)');
                reason.maxLength = 500;
                form.appendChild(reason);
                const go = el('button', 'danger small', t('Freeze my account and report it'));
                go.type = 'button';
                go.addEventListener('click', async () => {
                    go.disabled = true;
                    try {
                        await api(`/api/wallet/transactions/${tx.id}/dispute`, { method: 'POST', body: JSON.stringify({ reason: reason.value.trim() }) });
                        SW.closeReceipt();
                        toast(t('Reported. Your account is frozen.'), t('An analyst will review the payment'), true);
                        await refreshMe();
                        await SW.refreshHome();
                    } catch (error) {
                        setMessage(message, failText(error), 'error');
                        go.disabled = false;
                    }
                });
                form.appendChild(go);
                box.insertBefore(form, message);
            });
            buttons.appendChild(dispute);
        }
        if (tx.dispute) box.appendChild(el('p', 'hint', t('You reported this payment ({status}).', { status: t(tx.dispute) })));

        if (tx.type === 'transfer' && tx.counterparty && tx.counterparty.email) {
            const report = el('button', 'quiet small', t('Report this account'));
            report.type = 'button';
            report.addEventListener('click', async () => {
                buttons.hidden = true;
                let reasons = [];
                try { reasons = (await api('/api/reports/reasons')).reasons; } catch (error) { reasons = []; }
                const form = el('div', 'inline-panel');
                form.appendChild(el('p', null, t('Other SecureWallet users will see a warning before they pay {name}. Reports are anonymous.', { name: tx.counterparty.name || tx.counterparty.email })));
                const select = el('select');
                reasons.forEach(r => { const o = el('option', null, t(r.label)); o.value = r.key; select.appendChild(o); });
                form.appendChild(select);
                const go = el('button', 'small', t('Send report'));
                go.type = 'button';
                go.addEventListener('click', async () => {
                    go.disabled = true;
                    try {
                        await api('/api/reports', { method: 'POST', body: JSON.stringify({ email: tx.counterparty.email, reason: select.value }) });
                        setMessage(message, t('Thank you. The account has been reported.'), 'success');
                        form.remove();
                    } catch (error) {
                        setMessage(message, failText(error), 'error');
                        go.disabled = false;
                    }
                });
                form.appendChild(go);
                box.insertBefore(form, message);
            });
            buttons.appendChild(report);
        }
        if (buttons.childElementCount) box.appendChild(buttons);
        box.appendChild(message);
    }

    // ---------- M-Pesa ----------
    let mpesaRequest = null;
    let mpesaPoll = null;

    function closeMpesa() {
        clearInterval(mpesaPoll);
        mpesaRequest = null;
        $('mpesaDialog').close();
    }

    $('mpesaAction').addEventListener('click', async () => {
        $('mpesaForm').reset();
        $('mpesaForm').hidden = false;
        $('mpesaPhoneMock').hidden = true;
        setMessage($('mpesaMessage'), '');
        $('mpesaPhone').value = me && me.phone ? `0${me.phone.slice(3)}` : '';
        try {
            const status = await api('/api/status');
            $('mpesaMode').textContent = status.mpesaMode === 'sandbox' ? t('Daraja sandbox') : t('Simulator');
        } catch (error) { /* label stays empty */ }
        $('mpesaDialog').showModal();
        ($('mpesaPhone').value ? $('mpesaAmount') : $('mpesaPhone')).focus();
    });
    $('mpesaClose').addEventListener('click', closeMpesa);

    async function finishMpesa(status) {
        clearInterval(mpesaPoll);
        if (status.status === 'success') {
            closeMpesa();
            toast(t('KES {amount} deposited from M-Pesa', { amount: formatMoney(status.amount) }), `${t('Receipt')} ${status.receipt}`);
            await SW.refreshHome();
        } else {
            $('mpesaPhoneMock').hidden = true;
            $('mpesaForm').hidden = false;
            setMessage($('mpesaMessage'), `${t('Not completed')}: ${status.result_desc || ''}`, 'error');
        }
    }

    $('mpesaForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const amount = Number($('mpesaAmount').value);
        if (!Number.isInteger(amount) || amount < 1) return setMessage($('mpesaMessage'), t('Enter a whole amount of at least 1.'), 'error');
        $('mpesaSend').disabled = true;
        try {
            mpesaRequest = await api('/api/mpesa/stk', {
                method: 'POST', idempotencyKey: `mpesa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                body: JSON.stringify({ amount, phone: $('mpesaPhone').value.trim() }),
            });
            if (mpesaRequest.mode === 'simulator') {
                $('mpesaForm').hidden = true;
                $('mpesaPhoneMock').hidden = false;
                $('mpesaPinMock').value = '';
                $('mpesaPrompt').textContent = t('Do you want to pay KES {amount} to SECUREWALLET account SW{id}? Enter M-PESA PIN.', { amount: formatMoney(amount), id: mpesaRequest.id });
                $('mpesaPinMock').focus();
            } else {
                setMessage($('mpesaMessage'), t('Check your phone and enter your M-Pesa PIN.'), 'success');
                mpesaPoll = setInterval(async () => {
                    const status = await api(`/api/mpesa/requests/${mpesaRequest.id}`).catch(() => null);
                    if (status && status.status !== 'pending') finishMpesa(status);
                }, 3000);
            }
        } catch (error) {
            setMessage($('mpesaMessage'), failText(error), 'error');
        } finally {
            $('mpesaSend').disabled = false;
        }
    });

    async function simulate(action) {
        if (!mpesaRequest) return;
        if (action === 'pay' && !/^\d{4}$/.test($('mpesaPinMock').value)) {
            $('mpesaPinMock').focus();
            return;
        }
        $('mpesaPayMock').disabled = true;
        try {
            finishMpesa(await api(`/api/mpesa/simulator/${mpesaRequest.id}`, { method: 'POST', body: JSON.stringify({ action }) }));
        } catch (error) {
            setMessage($('mpesaMessage'), failText(error), 'error');
        } finally {
            $('mpesaPayMock').disabled = false;
        }
    }
    $('mpesaPayMock').addEventListener('click', () => simulate('pay'));
    $('mpesaCancelMock').addEventListener('click', () => simulate('cancel'));

    // ---------- Security page ----------
    function paintSecurityExtras() {
        if (!me) return;
        $('phoneState').replaceChildren(dotLabel(me.phone ? 'safe' : 'idle', me.phone ? `+${me.phone}` : t('Not linked')));
        $('mfaState').replaceChildren(dotLabel(me.totpEnabled ? 'safe' : 'warn', me.totpEnabled ? t('On') : t('Off')));
        $('mfaStart').hidden = me.totpEnabled || !$('mfaSetup').hidden;
        $('mfaDisableForm').hidden = !me.totpEnabled;
        $('freezeButton').disabled = me.frozen;
        $('freezeButton').textContent = me.frozen ? t('Your account is frozen') : t('Freeze my account now');
    }

    async function loadDevices() {
        const data = await api('/api/me/devices');
        $('deviceList').replaceChildren(...data.devices.map(d => {
            const li = el('li');
            li.appendChild(el('span', null, `${d.label}${d.current ? ` · ${t('this device')}` : ''}`));
            li.appendChild(el('span', 'mono', `${t('Last used')} ${formatDate(d.last_seen)}`));
            return li;
        }));
    }

    $('signOutOthers').addEventListener('click', async (event) => {
        event.currentTarget.disabled = true;
        try {
            const result = await api('/api/me/devices/sign-out-others', { method: 'POST' });
            setMessage($('deviceMessage'), t('Signed out {n} other sessions.', { n: result.signedOut }), 'success');
        } catch (error) {
            setMessage($('deviceMessage'), failText(error), 'error');
        } finally {
            event.currentTarget.disabled = false;
        }
    });

    $('mfaStart').addEventListener('click', async () => {
        try {
            const data = await api('/api/auth/2fa/setup', { method: 'POST' });
            $('mfaQr').src = data.qr;
            $('mfaSecret').textContent = data.secret.replace(/(.{4})/g, '$1 ').trim();
            $('mfaSetup').hidden = false;
            $('mfaStart').hidden = true;
            $('mfaEnableCode').focus();
        } catch (error) {
            setMessage($('mfaMessage'), failText(error), 'error');
        }
    });

    $('mfaEnable').addEventListener('click', async () => {
        try {
            await api('/api/auth/2fa/enable', { method: 'POST', body: JSON.stringify({ code: $('mfaEnableCode').value.trim(), password: $('mfaEnablePassword').value }) });
            $('mfaSetup').hidden = true;
            setMessage($('mfaMessage'), t('Two-factor sign-in is on. You will need the app each time you sign in.'), 'success');
            await refreshMe();
        } catch (error) {
            setMessage($('mfaMessage'), failText(error), 'error');
        }
    });

    $('mfaDisable').addEventListener('click', async () => {
        try {
            await api('/api/auth/2fa/disable', { method: 'POST', body: JSON.stringify({ password: $('mfaDisablePassword').value, code: $('mfaDisableCode').value.trim() }) });
            setMessage($('mfaMessage'), t('Two-factor sign-in is off.'), 'success');
            await refreshMe();
        } catch (error) {
            setMessage($('mfaMessage'), failText(error), 'error');
        }
    });

    $('phoneForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
            await api('/api/me/phone', { method: 'PUT', body: JSON.stringify({ phone: $('phoneInput').value.trim(), password: $('phonePassword').value }) });
            event.target.reset();
            setMessage($('phoneMessage'), t('Number saved.'), 'success');
            await refreshMe();
        } catch (error) {
            setMessage($('phoneMessage'), failText(error), 'error');
        }
    });

    $('freezeButton').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        if (button.dataset.confirm !== 'yes') {
            button.dataset.confirm = 'yes';
            button.textContent = t('Tap again to freeze');
            setTimeout(() => { button.dataset.confirm = ''; paintSecurityExtras(); }, 4000);
            return;
        }
        button.disabled = true;
        try {
            const result = await api('/api/me/freeze', { method: 'POST', body: JSON.stringify({ reason: 'Frozen by the account holder' }) });
            setMessage($('freezeMessage'), result.cancelled.length
                ? t('Frozen. {n} waiting payments were returned to your wallet.', { n: result.cancelled.length })
                : t('Frozen. No money can leave your account.'), 'success');
            await refreshMe();
            await SW.refreshHome();
        } catch (error) {
            setMessage($('freezeMessage'), failText(error), 'error');
        }
    });

    $('exportButton').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
            const response = await fetch('/api/me/export', { credentials: 'same-origin' });
            if (!response.ok) throw new Error(t('Could not prepare your data'));
            const blob = await response.blob();
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `securewallet-my-data-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        } catch (error) {
            toast(error.message, '', true);
        } finally {
            button.disabled = false;
        }
    });

    // ---------- chamas ----------
    let openChama = null;

    async function loadChamas() {
        const data = await api('/api/chamas');
        const list = $('chamaList');
        if (!data.chamas.length) {
            list.replaceChildren(el('li', 'empty', t('You are not in a chama yet. Start one, or ask a chair to invite you.')));
            return;
        }
        list.replaceChildren(...data.chamas.map(c => {
            const li = el('li', 'chama-row');
            const name = el('button', 'link-button', c.name);
            name.type = 'button';
            name.addEventListener('click', () => showChama(c.id));
            li.appendChild(name);
            if (c.status === 'invited') {
                const box = el('span', 'req-actions');
                const join = el('button', 'small', t('Join'));
                const no = el('button', 'quiet small', t('Decline'));
                join.type = 'button'; no.type = 'button';
                join.addEventListener('click', async () => { await api(`/api/chamas/${c.id}/accept`, { method: 'POST' }); await loadChamas(); showChama(c.id); });
                no.addEventListener('click', async () => { await api(`/api/chamas/${c.id}/decline`, { method: 'POST' }); await loadChamas(); });
                box.append(join, no);
                li.appendChild(box);
            } else {
                li.appendChild(el('span', 'mono', `${formatMoney(c.balance)} · ${c.members} ${t('members')}${Number(c.open_payouts) ? ` · ${c.open_payouts} ${t('to vote on')}` : ''}`));
            }
            return li;
        }));
        if (openChama) showChama(openChama).catch(() => {});
    }

    function field(labelText, input) {
        const wrap = el('div');
        const label = el('label', null, labelText);
        const id = `f${Math.random().toString(36).slice(2, 9)}`;
        label.htmlFor = id;
        input.id = id;
        wrap.append(label, input);
        return wrap;
    }

    async function showChama(id) {
        openChama = id;
        const data = await api(`/api/chamas/${id}`);
        const box = $('chamaDetail');
        const c = data.chama;
        const head = el('div', 'console-head');
        head.append(el('span', 'mono', c.name), el('span', 'mono', `${t('Your role')}: ${t(data.me.role)}`));
        const pot = el('div', 'balance-amount');
        pot.append(el('span', 'currency', SW.currency), el('span', 'value', formatMoney(c.balance)));
        const parts = [head, pot];
        if (c.purpose) parts.push(el('p', 'hint', c.purpose));
        if (c.goal_amount) {
            const progress = el('div', 'progress');
            const bar = el('i');
            bar.style.width = `${Math.min(100, (Number(c.balance) / Number(c.goal_amount)) * 100)}%`;
            progress.appendChild(bar);
            parts.push(progress, el('p', 'hint', t('{saved} of the {goal} goal', { saved: formatMoney(c.balance), goal: formatMoney(c.goal_amount) })));
        }
        if (data.me.status === 'invited') {
            box.replaceChildren(...parts, el('p', 'hint', t('Join this chama from the list to take part.')));
            return;
        }

        // Members and what each has put in and taken out.
        const table = el('table', 'data-table');
        const thead = el('tr');
        [t('Member'), t('Role'), t('Contributed'), t('Received')].forEach(h => thead.appendChild(el('th', null, h)));
        table.appendChild(thead);
        data.members.forEach(m => {
            const tr = el('tr');
            tr.append(el('td', null, `${m.name}${m.status === 'invited' ? ` (${t('invited')})` : ''}`), el('td', null, t(m.role)),
                el('td', 'num', formatMoney(m.contributed)), el('td', 'num', formatMoney(m.received)));
            table.appendChild(tr);
        });
        parts.push(el('span', 'mono sub', t('Members')), table);

        // Contribute.
        const contribute = el('form', 'inline-form');
        contribute.noValidate = true;
        const amount = el('input');
        amount.type = 'number'; amount.min = '1'; amount.step = '0.01';
        amount.placeholder = c.contribution_amount ? formatMoney(c.contribution_amount) : t('Amount');
        if (c.contribution_amount) amount.value = Number(c.contribution_amount).toFixed(2);
        amount.setAttribute('aria-label', t('Contribution amount'));
        const give = el('button', null, t('Contribute'));
        give.type = 'submit';
        contribute.append(amount, give);
        const message = el('p', 'message');
        contribute.addEventListener('submit', async (event) => {
            event.preventDefault();
            give.disabled = true;
            try {
                await api(`/api/chamas/${id}/contribute`, { method: 'POST', idempotencyKey: `chama-${Date.now().toString(36)}`, body: JSON.stringify({ amount: Number(amount.value) }) });
                toast(t('Contributed {amount}', { amount: SW.money(Number(amount.value)) }), c.name);
                await Promise.all([showChama(id), SW.refreshHome(), loadChamas()]);
            } catch (error) {
                setMessage(message, failText(error), 'error');
            } finally {
                give.disabled = false;
            }
        });
        parts.push(el('span', 'mono sub', t('Contribute from your wallet')), contribute);

        // Payouts.
        parts.push(el('span', 'mono sub', t('Payouts: {n} of {total} active members must approve', { n: data.requiredApprovals, total: data.members.filter(m => m.status === 'active').length })));
        const payouts = el('ul', 'simple-list');
        if (!data.payouts.length) payouts.appendChild(el('li', 'empty', t('No payouts yet.')));
        data.payouts.forEach(p => {
            const li = el('li', 'payout');
            li.appendChild(el('span', null, `${formatMoney(p.amount)} → ${p.recipient_name}${p.reason ? ` · ${p.reason}` : ''}`));
            const stateText = p.status === 'proposed' ? t('{yes} of {needed} approvals', { yes: p.approvals, needed: p.required_approvals }) : t(p.status);
            li.appendChild(el('span', 'mono', stateText));
            if (p.status === 'proposed' && !p.my_vote) {
                const votes = el('span', 'req-actions');
                ['approve', 'reject'].forEach(v => {
                    const b = el('button', v === 'approve' ? 'small' : 'quiet small', t(v === 'approve' ? 'Approve' : 'Reject'));
                    b.type = 'button';
                    b.addEventListener('click', async () => {
                        b.disabled = true;
                        try {
                            const r = await api(`/api/chamas/payouts/${p.id}/vote`, { method: 'POST', body: JSON.stringify({ vote: v }) });
                            toast(r.status === 'paid' ? t('Payout approved and paid') : t('Vote recorded'), '');
                            await Promise.all([showChama(id), loadChamas(), SW.refreshHome()]);
                        } catch (error) {
                            setMessage(message, failText(error), 'error');
                            b.disabled = false;
                        }
                    });
                    votes.appendChild(b);
                });
                li.appendChild(votes);
            }
            payouts.appendChild(li);
        });
        parts.push(payouts);

        // Propose a payout.
        const propose = el('form', 'propose');
        propose.noValidate = true;
        const to = el('select');
        data.members.filter(m => m.status === 'active').forEach(m => { const o = el('option', null, m.name); o.value = m.id; to.appendChild(o); });
        const pAmount = el('input'); pAmount.type = 'number'; pAmount.min = '1'; pAmount.step = '0.01';
        const reason = el('input'); reason.maxLength = 200; reason.placeholder = t('For example, school fees');
        const send = el('button', 'quiet', t('Propose payout'));
        send.type = 'submit';
        propose.append(field(t('Pay to'), to), field(t('Amount'), pAmount), field(t('Reason'), reason), send);
        propose.addEventListener('submit', async (event) => {
            event.preventDefault();
            send.disabled = true;
            try {
                const r = await api(`/api/chamas/${id}/payouts`, { method: 'POST', body: JSON.stringify({ amount: Number(pAmount.value), recipientId: Number(to.value), reason: reason.value.trim() }) });
                toast(r.status === 'paid' ? t('Payout paid') : t('Payout proposed'), r.status === 'paid' ? '' : t('Waiting for other members to approve'));
                await Promise.all([showChama(id), loadChamas(), SW.refreshHome()]);
            } catch (error) {
                setMessage(message, failText(error), 'error');
            } finally {
                send.disabled = false;
            }
        });
        parts.push(el('span', 'mono sub', t('Propose a payout')), propose);

        // Invite (chair or treasurer).
        if (['chair', 'treasurer'].includes(data.me.role)) {
            const invite = el('form', 'inline-form');
            invite.noValidate = true;
            const address = el('input'); address.type = 'email'; address.placeholder = 'name@example.com';
            address.setAttribute('aria-label', t('Email address to invite'));
            const go = el('button', 'quiet', t('Invite'));
            go.type = 'submit';
            invite.append(address, go);
            invite.addEventListener('submit', async (event) => {
                event.preventDefault();
                try {
                    await api(`/api/chamas/${id}/invite`, { method: 'POST', body: JSON.stringify({ email: address.value.trim() }) });
                    setMessage(message, t('Invitation sent.'), 'success');
                    await showChama(id);
                } catch (error) {
                    setMessage(message, failText(error), 'error');
                }
            });
            parts.push(el('span', 'mono sub', t('Invite a member')), invite);
        }
        parts.push(message);
        box.replaceChildren(...parts);
    }

    $('chamaForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const message = $('chamaMessage');
        try {
            const created = await api('/api/chamas', { method: 'POST', body: JSON.stringify({
                name: $('chamaName').value.trim(), purpose: $('chamaPurpose').value.trim(),
                goalAmount: $('chamaGoal').value ? Number($('chamaGoal').value) : null,
                contributionAmount: $('chamaContribution').value ? Number($('chamaContribution').value) : null,
            }) });
            event.target.reset();
            setMessage(message, '');
            await loadChamas();
            await showChama(created.id);
        } catch (error) {
            setMessage(message, failText(error), 'error');
        }
    });

    // ---------- language ----------
    function paintLanguage() {
        const lang = window.SWi18n ? window.SWi18n.language() : 'en';
        $('langToggle').textContent = lang === 'sw' ? 'EN' : 'SW';
        $('langToggle').title = lang === 'sw' ? 'Switch to English' : 'Badili kwa Kiswahili';
    }

    $('langToggle').addEventListener('click', async () => {
        if (!window.SWi18n) return;
        const next = window.SWi18n.language() === 'sw' ? 'en' : 'sw';
        await api('/api/me/language', { method: 'PUT', body: JSON.stringify({ language: next }) }).catch(() => {});
        window.SWi18n.set(next);
        window.location.reload();
    });

    // ---------- hooks used by app.js ----------
    SW.receiptActions = receiptActions;
    SW.onView = (view) => {
        if (view === 'security') {
            paintSecurityExtras();
            loadDevices().catch(() => {});
        }
        if (view === 'chamas') loadChamas().catch(() => {});
    };
    SW.start = (user) => {
        me = user;
        if (window.SWi18n && user.language && window.SWi18n.language() !== user.language) {
            window.SWi18n.set(user.language);
            window.location.reload();
            return;
        }
        paintLanguage();
        paintBanners();
        paintSecurityExtras();
        loadNotifications().catch(() => {});
        connectLive();
    };
})();
