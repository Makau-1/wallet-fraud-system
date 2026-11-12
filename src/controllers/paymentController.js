// Payments out of the wallet: bank transfers, pay bill, buy goods and
// airtime. All are simulated; no money leaves the system.
//
// Bank transfers move money out of the wallet system, which matches the
// CASH_OUT records in PaySim, so they are scored by the fraud model exactly
// like withdrawals. Bills, goods and airtime are merchant payments; PaySim
// records no fraud in payments and the model was not trained on them, so
// they are recorded without a score.

const db = require('../config/db');
const payments = require('../services/payments');
const {
    ServiceError, checkAmount, withTransaction,
    walletForUser, debit, handle,
} = require('../services/ledger');

const BANKS = [
    'Absa Bank Kenya', 'Co-operative Bank', 'Diamond Trust Bank', 'Equity Bank',
    'Family Bank', 'I&M Bank', 'KCB Bank', 'NCBA Bank', 'Stanbic Bank', 'Standard Chartered',
];

function mask(accountNumber) {
    return '••••' + accountNumber.slice(-4);
}

const banks = (req, res) => res.json({ banks: BANKS });

const bankTransfer = async (req, res) => {
    const bank = req.body.bank;
    const accountNumber = typeof req.body.accountNumber === 'string' ? req.body.accountNumber.replace(/\s+/g, '') : '';

    if (!BANKS.includes(bank)) return res.status(400).json({ message: 'Choose a bank from the list' });
    if (!/^\d{6,16}$/.test(accountNumber)) {
        return res.status(400).json({ message: 'Enter an account number of 6 to 16 digits' });
    }

    // Scored as a cash-out by the shared payment service, which also
    // applies the PIN challenge or hold in enforce mode.
    return payments.respond(res, () => payments.execute({
        userId: req.session.userId,
        kind: 'bank_transfer',
        amount: req.body.amount,
        pin: req.body.pin,
        details: { bank, account_masked: mask(accountNumber) },
    }));
};

const KINDS = {
    paybill: { label: 'Pay bill', number: /^\d{5,7}$/, numberHint: 'a business number of 5 to 7 digits', needsAccount: true, max: 1000000 },
    till: { label: 'Buy goods', number: /^\d{5,7}$/, numberHint: 'a till number of 5 to 7 digits', needsAccount: false, max: 1000000 },
    airtime: { label: 'Airtime', number: /^(?:\+?254|0)[17]\d{8}$/, numberHint: 'a Kenyan phone number such as 0712345678', needsAccount: false, max: 10000 },
};

const pay = handle('PaymentController', async (req, res) => {
    const wallet = await walletForUser(req.session.userId);
    const kind = Object.prototype.hasOwnProperty.call(KINDS, req.body.kind) ? KINDS[req.body.kind] : null;
    if (!kind) throw new ServiceError(400, 'Choose pay bill, buy goods or airtime');

    const amount = checkAmount(req.body.amount, kind.max);
    const number = typeof req.body.number === 'string' ? req.body.number.replace(/\s+/g, '') : '';
    const account = typeof req.body.account === 'string' ? req.body.account.trim() : '';

    if (!kind.number.test(number)) throw new ServiceError(400, `Enter ${kind.numberHint}`);
    if (kind.needsAccount && (!account || account.length > 30)) {
        throw new ServiceError(400, 'Enter the account number for this bill (up to 30 characters)');
    }

    const moved = await withTransaction(connection => debit(connection, wallet.id, amount, {
        type: 'payment',
        kind: req.body.kind,
        number,
        ...(kind.needsAccount ? { account } : {}),
    }));

    res.json({
        message: `${kind.label} payment made`,
        transactionId: moved.transactionId,
        balance: moved.after,
    });
});

module.exports = { banks, bankTransfer, pay, BANKS };
