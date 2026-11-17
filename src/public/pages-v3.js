// Scripts for the version 3 pages: the usability survey, the developer
// documentation and the USSD simulator. Uses the helpers in app.js.

(function () {
    const page = document.body.dataset.page;
    const $ = id => document.getElementById(id);

    // ================= usability survey =================
    if (page === 'survey') {
        const STATEMENTS = [
            'I think that I would like to use SecureWallet frequently.',
            'I found SecureWallet unnecessarily complex.',
            'I thought SecureWallet was easy to use.',
            'I think that I would need the support of a technical person to be able to use SecureWallet.',
            'I found the various functions in SecureWallet were well integrated.',
            'I thought there was too much inconsistency in SecureWallet.',
            'I would imagine that most people would learn to use SecureWallet very quickly.',
            'I found SecureWallet very cumbersome to use.',
            'I felt very confident using SecureWallet.',
            'I needed to learn a lot of things before I could get going with SecureWallet.',
        ];
        const LABELS = ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree'];
        requireUser().then(user => { if (!user) window.location.href = 'login.html'; });
        $('susItems').replaceChildren(...STATEMENTS.map((text, i) => {
            const item = el('fieldset', 'sus-item');
            item.style.border = '0'; item.style.margin = '0'; item.style.padding = '14px 0';
            const legend = el('legend', null, `${i + 1}. ${text}`);
            legend.style.fontWeight = '600'; legend.style.marginBottom = '10px';
            item.appendChild(legend);
            const scale = el('div', 'likert');
            LABELS.forEach((label, v) => {
                const option = el('label');
                const input = el('input');
                input.type = 'radio'; input.name = `q${i}`; input.value = String(v + 1);
                option.append(input, el('span', null, label));
                option.title = label;
                scale.appendChild(option);
            });
            item.appendChild(scale);
            return item;
        }));
        $('susForm').addEventListener('submit', async (event) => {
            event.preventDefault();
            const answers = STATEMENTS.map((_, i) => {
                const checked = document.querySelector(`input[name="q${i}"]:checked`);
                return checked ? Number(checked.value) : null;
            });
            const missing = answers.findIndex(a => a === null);
            if (missing >= 0) {
                setMessage($('susMessage'), `Please answer statement ${missing + 1}.`, 'error');
                return;
            }
            $('susSubmit').disabled = true;
            try {
                const result = await api('/api/survey/sus', { method: 'POST', body: JSON.stringify({ answers, comment: $('susComment').value.trim() }) });
                $('susForm').replaceChildren(el('h2', null, 'Thank you.'), el('p', 'hint', `Your answers give a usability score of ${result.score} out of 100.`),
                    Object.assign(el('a', 'button', 'Back to my wallet'), { href: 'dashboard.html' }));
            } catch (error) {
                setMessage($('susMessage'), error.message, 'error');
                $('susSubmit').disabled = false;
            }
        });
    }

    // ================= developer documentation =================
    if (page === 'developers') {
        const sample = {
            external_id: 'pay_1001', type: 'TRANSFER', amount: 2500, account_id: 'cust_118', counterparty_id: 'cust_904', account_balance: 2600, counterparty_balance: 120,
        };
        $('tryBody').value = JSON.stringify(sample, null, 2);
        api('/api/v1/openapi.json').then(spec => {
            const box = $('endpoints');
            box.appendChild(el('h2', null, 'Endpoints'));
            box.appendChild(el('p', null, `Base URL: ${spec.servers[0].url}`));
            Object.entries(spec.paths).forEach(([path, methods]) => {
                Object.entries(methods).forEach(([method, op]) => {
                    const head = el('div', 'endpoint');
                    head.append(el('span', `method ${method}`, method.toUpperCase()), el('code', null, path), el('strong', null, op.summary));
                    box.appendChild(head);
                    if (op.description) box.appendChild(el('p', null, op.description));
                    const schema = op.requestBody && op.requestBody.content && op.requestBody.content['application/json'].schema;
                    if (schema && schema.properties) {
                        const t = el('table', 'data-table');
                        const tr = el('tr');
                        ['Field', 'Type', 'Description'].forEach(h => tr.appendChild(el('th', null, h)));
                        t.appendChild(tr);
                        Object.entries(schema.properties).forEach(([name, p]) => {
                            const row = el('tr');
                            row.append(el('td', null, `${name}${(schema.required || []).includes(name) ? ' *' : ''}`),
                                el('td', null, p.enum ? p.enum.filter(Boolean).join(' | ') : p.type), el('td', null, p.description || (p.example !== undefined ? `e.g. ${p.example}` : '')));
                            t.appendChild(row);
                        });
                        box.appendChild(t);
                    }
                });
            });
            box.appendChild(el('h3', null, 'Example'));
            box.appendChild(el('pre', null, `curl -X POST ${spec.servers[0].url}/assess \\
  -H "Authorization: Bearer $SECUREWALLET_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(sample)}'

{
  "id": "asm_1042", "decision": "allow", "risk": 0.31, "model_score": 0.17,
  "reasons": ["First payment to this recipient"],
  "explanation": { "base_value": 0.5, "contributions": [ ... ] },
  "model_version": "rf-20261117-055109-0live", "status": "completed"
}`));
        }).catch(() => {});

        $('tryForm').addEventListener('submit', async (event) => {
            event.preventDefault();
            const out = $('tryOut');
            out.hidden = false;
            let body;
            try { body = JSON.parse($('tryBody').value); } catch (error) { out.textContent = 'The request body is not valid JSON.'; return; }
            try {
                const response = await fetch('/api/v1/assess', {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${$('tryKey').value.trim()}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                out.textContent = `HTTP ${response.status}\n${JSON.stringify(await response.json(), null, 2)}`;
            } catch (error) {
                out.textContent = error.message;
            }
        });
    }

    // ================= USSD simulator =================
    if (page === 'ussd') {
        let answers = [];
        let open = false;
        const screen = $('ussdScreen');

        api('/api/ussd/simulator-status').then(s => {
            $('ussdOff').hidden = s.enabled;
            $('ussdOn').hidden = !s.enabled;
        }).catch(() => {});

        // The simulator dials from the signed-in user's own linked number.
        requireUser().then(user => {
            if (!user) { window.location.href = 'login.html'; return; }
            api('/api/ussd/simulator-phone').then(r => {
                $('ussdPhone').textContent = r.phone
                    ? `Dialling from ${r.phone}, the number linked to your account.`
                    : 'Link a phone number under Security in your wallet first.';
                $('ussdDial').disabled = !r.phone;
            }).catch(() => {});
        });

        async function send() {
            const text = answers.join('*');
            const body = { sessionId: 'sim', serviceCode: '*384*7#', text };
            const li = el('li', null, `text="${text}" → `);
            try {
                const response = await fetch('/api/ussd/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                const reply = await response.text();
                li.appendChild(el('strong', null, reply.split('\n')[0]));
                open = reply.startsWith('CON ');
                screen.textContent = reply.replace(/^(CON|END) /, '');
                screen.classList.toggle('closed', !open);
            } catch (error) {
                screen.textContent = 'Could not reach the server.';
                open = false;
            }
            $('ussdLog').prepend(li);
            $('ussdReply').disabled = !open;
            $('ussdSend').disabled = !open;
            if (open) $('ussdReply').focus();
        }

        $('ussdDial').addEventListener('click', () => {
            answers = [];
            $('ussdLog').replaceChildren();
            send();
        });
        $('ussdForm').addEventListener('submit', (event) => {
            event.preventDefault();
            if (!open) return;
            answers.push($('ussdReply').value.trim());
            $('ussdReply').value = '';
            send();
        });
        const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
        $('keypad').replaceChildren(...keys.map(k => {
            const b = el('button', null, k);
            b.type = 'button';
            b.addEventListener('click', () => { if (!$('ussdReply').disabled) { $('ussdReply').value += k; $('ussdReply').focus(); } });
            return b;
        }));
    }
})();
