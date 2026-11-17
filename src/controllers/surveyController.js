// Usability survey (version 3): the System Usability Scale (SUS).
//
// Ten statements, each answered from 1 (strongly disagree) to 5 (strongly
// agree). The score runs from 0 to 100: odd-numbered statements score the
// answer minus 1, even-numbered ones 5 minus the answer, and the total is
// multiplied by 2.5 (Brooke, 1996). A score of about 68 is commonly treated
// as average.

const db = require('../config/db');
const { ServiceError, handle } = require('../services/ledger');

function susScore(answers) {
    const total = answers.reduce((sum, value, i) => sum + (i % 2 === 0 ? value - 1 : 5 - value), 0);
    return total * 2.5;
}

const submit = handle('Survey', async (req, res) => {
    const answers = Array.isArray(req.body.answers) ? req.body.answers.map(Number) : [];
    if (answers.length !== 10 || answers.some(a => !Number.isInteger(a) || a < 1 || a > 5)) {
        throw new ServiceError(400, 'Answer all ten statements from 1 to 5');
    }
    const comment = typeof req.body.comment === 'string' ? req.body.comment.trim().slice(0, 1000) : null;
    const score = susScore(answers);
    const role = req.session.role === 'admin' ? 'analyst' : 'user';
    await db.execute('INSERT INTO sus_responses (user_id, role, answers, score, comment) VALUES (?, ?, ?, ?, ?)',
        [req.session.userId, role, answers.join(','), score, comment || null]);
    res.status(201).json({ score });
});

module.exports = { submit, susScore };
