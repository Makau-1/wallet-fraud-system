// USSD menu (version 3) for feature phones, in English and Swahili.
//
// Africa's Talking sends each step of a USSD session to the callback as a
// form post with sessionId, serviceCode, phoneNumber and text, where text
// holds every answer so far joined by "*" (for example "2*0712345678*500").
// The reply is plain text that starts with "CON " (more input needed) or
// "END " (the session closes).
//
// The menu is worked out from text alone, so no session state is stored.
// The user is identified by their phone number (linked under Security in
// the app), and every action needs the transaction PIN. Sending money goes
// through the same payment service as the website: the scam check, the
// risk engine, holds and cooling-off all apply, and the recipient's
// registered name is shown before the PIN is asked for (confirmation of
// payee).

const db = require('../config/db');
const payments = require('./payments');
const riskEngine = require('./riskEngine');
const { ServiceError } = require('./ledger');

const TEXT = {
    en: {
        menu: 'Welcome to SecureWallet\n1. Check balance\n2. Send money\n3. Mini statement\n4. Lugha / Language',
        notRegistered: 'This number is not linked to a SecureWallet account. Add it in the app under Security.',
        noPin: 'Set a transaction PIN in the app under Security first.',
        frozen: 'Your account is frozen. Contact support.',
        enterPin: 'Enter your PIN',
        balance: b => `Your balance is KES ${b}`,
        enterPhone: 'Enter the recipient\'s phone number',
        noRecipient: 'No SecureWallet account uses that number.',
        self: 'You cannot send money to yourself.',
        enterAmount: name => `Send to ${name}\nEnter amount`,
        badAmount: 'Enter a whole amount of at least 1.',
        purpose: 'Why are you sending this money?',
        confirm: (amount, name) => `Send KES ${amount} to ${name}?\nEnter PIN to confirm`,
        sent: (amount, name, balance, ref) => `Sent KES ${amount} to ${name}. New balance KES ${balance}. Ref ${ref}`,
        held: 'Payment on hold for review. It will be sent or returned to you after the check.',
        cooling: (amount, time) => `Payment of KES ${amount} will be sent at ${time}. You can cancel it in the app before then. If someone asked you to pay, do not continue.`,
        statement: 'Last 5 transactions:',
        none: 'No transactions yet.',
        language: 'Language set to English.',
        invalid: 'Invalid choice.',
        failed: 'The payment could not be made. Try again later.',
    },
    sw: {
        menu: 'Karibu SecureWallet\n1. Angalia salio\n2. Tuma pesa\n3. Taarifa fupi\n4. Lugha / Language',
        notRegistered: 'Nambari hii haijaunganishwa na akaunti ya SecureWallet. Iongeze kwenye programu chini ya Usalama.',
        noPin: 'Weka PIN ya malipo kwenye programu chini ya Usalama kwanza.',
        frozen: 'Akaunti yako imefungwa. Wasiliana na huduma kwa wateja.',
        enterPin: 'Weka PIN yako',
        balance: b => `Salio lako ni KES ${b}`,
        enterPhone: 'Weka nambari ya simu ya mpokeaji',
        noRecipient: 'Hakuna akaunti ya SecureWallet yenye nambari hiyo.',
        self: 'Huwezi kujitumia pesa.',
        enterAmount: name => `Tuma kwa ${name}\nWeka kiasi`,
        badAmount: 'Weka kiasi kamili cha angalau 1.',
        purpose: 'Unatuma pesa hii kwa sababu gani?',
        confirm: (amount, name) => `Tuma KES ${amount} kwa ${name}?\nWeka PIN kuthibitisha`,
        sent: (amount, name, balance, ref) => `Umetuma KES ${amount} kwa ${name}. Salio jipya ni KES ${balance}. Kumb. ${ref}`,
        held: 'Malipo yamesimamishwa kwa ukaguzi. Yatatumwa au kurudishwa kwako baada ya ukaguzi.',
        cooling: (amount, time) => `Malipo ya KES ${amount} yatatumwa saa ${time}. Unaweza kuyaghairi kwenye programu kabla ya hapo. Kama kuna mtu aliyekuomba ulipe, usiendelee.`,
        statement: 'Miamala 5 ya mwisho:',
        none: 'Bado hakuna miamala.',
        language: 'Lugha imebadilishwa kuwa Kiswahili.',
        invalid: 'Chaguo si sahihi.',
        failed: 'Malipo hayakuweza kufanyika. Jaribu tena baadaye.',
    },
};

const PURPOSE_SW = {
    family_friends: 'Familia au marafiki',
    goods_services: 'Malipo ya bidhaa au huduma',
    bills_rent: 'Bili, kodi au karo',
    asked_by_caller: 'Mtu alinipigia au kunitumia ujumbe akaniomba nilipe',
    investment: 'Uwekezaji au biashara yenye faida',
    job_prize_loan: 'Ada ya kupata kazi, zawadi au mkopo',
    sent_by_mistake: 'Kurudisha pesa anazosema zilitumwa kwangu kimakosa',
    other: 'Sababu nyingine',
};

const PURPOSE_EN_SHORT = {
    family_friends: 'Family or friends',
    goods_services: 'Goods or services',
    bills_rent: 'Bills, rent or fees',
    asked_by_caller: 'A caller or message asked me to pay',
    investment: 'Investment opportunity',
    job_prize_loan: 'Fee for a job, prize or loan',
    sent_by_mistake: 'Returning money "sent by mistake"',
    other: 'Something else',
};

function money(value) {
    return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function con(text) { return `CON ${text}`; }
function end(text) { return `END ${text}`; }

function purposeMenu(t, language) {
    const lines = payments.PURPOSES.map((p, i) => `${i + 1}. ${language === 'sw' ? PURPOSE_SW[p.key] : PURPOSE_EN_SHORT[p.key]}`);
    return `${t.purpose}\n${lines.join('\n')}`;
}

async function userByPhone(phone) {
    const [rows] = await db.execute(
        `SELECT u.id, u.name, u.email, u.language, u.frozen_at, (u.pin_hash IS NOT NULL) AS has_pin, w.id AS wallet_id, w.balance
         FROM users u JOIN wallets w ON w.user_id = u.id WHERE u.phone = ?`, [phone]);
    return rows[0] || null;
}

function errorText(error, t, language) {
    if (!(error instanceof ServiceError)) return t.failed;
    if (language === 'sw') {
        if (error.status === 403) return 'PIN si sahihi.';
        if (error.status === 423) return /frozen/i.test(error.message) ? t.frozen : 'PIN imefungwa kwa dakika 15 baada ya majaribio mengi.';
        if (/Insufficient/i.test(error.message)) return 'Salio halitoshi.';
        return t.failed;
    }
    return error.message;
}

async function handle({ phoneNumber, text }) {
    const phone = payments.phoneKey(phoneNumber);
    const user = phone ? await userByPhone(phone) : null;
    if (!user) return end(TEXT.en.notRegistered);
    const language = user.language === 'sw' ? 'sw' : 'en';
    const t = TEXT[language];
    const parts = String(text || '').split('*').filter((part, i, all) => !(part === '' && all.length === 1));

    if (!parts.length) return con(t.menu);
    const [choice] = parts;

    if (choice === '4') {
        const next = language === 'sw' ? 'en' : 'sw';
        await db.execute('UPDATE users SET language = ? WHERE id = ?', [next, user.id]);
        return end(TEXT[next].language);
    }
    if (!['1', '2', '3'].includes(choice)) return end(t.invalid);
    if (!Number(user.has_pin)) return end(t.noPin);
    if (user.frozen_at && choice === '2') return end(t.frozen);

    if (choice === '1' || choice === '3') {
        if (parts.length === 1) return con(t.enterPin);
        try {
            await payments.checkPinFor(user.id, parts[1]);
        } catch (error) {
            return end(errorText(error, t, language));
        }
        const [[wallet]] = await db.execute('SELECT balance FROM wallets WHERE id = ?', [user.wallet_id]);
        if (choice === '1') return end(t.balance(money(wallet.balance)));
        const [rows] = await db.execute(
            `SELECT t.amount, t.created_at, t.sender_wallet_id = ? AS outgoing,
                    JSON_UNQUOTE(JSON_EXTRACT(t.metadata, '$.type')) AS type
             FROM transactions t
             WHERE t.sender_wallet_id = ? OR (t.receiver_wallet_id = ? AND t.status = 'completed')
             ORDER BY t.id DESC LIMIT 5`, [user.wallet_id, user.wallet_id, user.wallet_id]);
        if (!rows.length) return end(t.none);
        const lines = rows.map(r => {
            const d = new Date(r.created_at);
            const day = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
            return `${day} ${Number(r.outgoing) ? '-' : '+'}${money(r.amount)} ${String(r.type || '').replace('_', ' ')}`;
        });
        return end(`${t.statement}\n${lines.join('\n')}\n${t.balance(money(wallet.balance))}`);
    }

    // Send money: 2 * phone * amount [* purpose] * PIN
    if (parts.length === 1) return con(t.enterPhone);
    const recipientPhone = payments.phoneKey(parts[1]);
    const recipient = recipientPhone ? await userByPhone(recipientPhone) : null;
    if (!recipient) return end(t.noRecipient);
    if (String(recipient.id) === String(user.id)) return end(t.self);
    if (parts.length === 2) return con(t.enterAmount(recipient.name));

    const amount = Number(parts[2]);
    if (!Number.isInteger(amount) || amount < 1) return end(t.badAmount);
    const [[paid]] = await db.execute(
        "SELECT COUNT(*) AS n FROM transactions WHERE sender_wallet_id = ? AND receiver_wallet_id = ? AND status = 'completed'",
        [user.wallet_id, recipient.wallet_id]);
    const minimum = Number.isFinite(Number(process.env.SCAM_CHECK_MIN)) && process.env.SCAM_CHECK_MIN !== undefined ? Number(process.env.SCAM_CHECK_MIN) : 1000;
    const needsPurpose = riskEngine.mode() === 'enforce' && Number(paid.n) === 0 && amount >= minimum;

    let purpose;
    let pinIndex = 3;
    if (needsPurpose) {
        if (parts.length === 3) return con(purposeMenu(t, language));
        const picked = payments.PURPOSES[Number(parts[3]) - 1];
        if (!picked) return end(t.invalid);
        purpose = picked.key;
        pinIndex = 4;
    }
    if (parts.length === pinIndex) return con(t.confirm(money(amount), recipient.name));

    try {
        const result = await payments.execute({
            userId: user.id,
            kind: 'transfer',
            amount,
            recipientEmail: recipient.email,
            pin: parts[pinIndex],
            purpose,
            requirePin: true,
            context: { channel: 'ussd' },
        });
        if (result.held) return end(t.held);
        if (result.coolingOff) {
            const at = new Date(result.coolingOff.until);
            const eat = new Date(at.getTime() + 3 * 3600 * 1000);
            const time = `${String(eat.getUTCHours()).padStart(2, '0')}:${String(eat.getUTCMinutes()).padStart(2, '0')}`;
            return end(t.cooling(money(amount), time));
        }
        return end(t.sent(money(amount), recipient.name, money(result.balance), `SW-${String(result.transactionId).padStart(6, '0')}`));
    } catch (error) {
        return end(errorText(error, t, language));
    }
}

module.exports = { handle };
