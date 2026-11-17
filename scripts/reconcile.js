// Runs a reconciliation from the command line and exits with code 1 if
// the books do not balance. The automated tests run it after every suite.
//
//   node scripts/reconcile.js

require('dotenv').config();
const db = require('../src/config/db');
const reconcile = require('../src/services/reconcile');

(async () => {
    try {
        const result = await reconcile.run('script');
        const s = result.summary;
        console.log(`Reconciliation #${result.id}: ${result.ok ? 'the books balance' : `${result.issues.length} problems found`}`);
        if (s.journalChain) console.log(`  ${s.journalChain.checked} journal entries and ${s.auditChain.checked} audit records verified`);
        if (s.wallets) console.log(`  ${s.wallets.accounts} wallets, ${s.savings.accounts} savings goals, ${s.loans.accounts} loans, ${s.chamas.accounts} chamas checked`);
        result.issues.slice(0, 20).forEach(i => console.log(`  - ${i.check} ${i.id ?? ''}: ${i.detail}`));
        if (!result.ok) process.exitCode = 1;
    } catch (error) {
        console.error('Reconciliation could not run:', error.message);
        process.exitCode = 1;
    } finally {
        await db.end();
    }
})();
