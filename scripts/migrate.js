// Applies database migrations without needing the mysql command-line tool.
//
//   node scripts/migrate.js            apply every migration not yet applied
//   node scripts/migrate.js --status   list migrations and whether each is applied
//
// Applied migrations are recorded in the schema_migrations table. On a
// database set up before this table existed, migrations whose changes are
// already present are recorded as applied rather than run again. A
// statement that would add something already there is skipped, so a
// migration that stopped half-way can simply be run again.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/config/db');

const DIR = path.join(__dirname, '..', 'database', 'migrations');

// Errors that mean "this change is already in place".
const ALREADY = new Set([
    'ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME', 'ER_TABLE_EXISTS_ERROR', 'ER_MULTIPLE_PRI_KEY',
    'ER_DUP_ENTRY', 'ER_TRG_ALREADY_EXISTS',
]);

// How to tell that an older migration was applied by hand.
const DETECT = {
    '002_money_services.sql': "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'savings_vaults'",
    '003_risk_engine.sql': "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'pin_hash'",
    '004_platform.sql': "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'journal_entries'",
};

// Splits a SQL file into statements: removes comments and splits on
// semicolons that are not inside quotes.
function statements(sql) {
    const out = [];
    let current = '';
    let quote = null;
    for (let i = 0; i < sql.length; i += 1) {
        const ch = sql[i];
        const next = sql[i + 1];
        if (!quote && ch === '-' && next === '-') {
            while (i < sql.length && sql[i] !== '\n') i += 1;
            current += '\n';
            continue;
        }
        if (!quote && ch === '/' && next === '*' && sql[i + 2] !== '!') {
            i += 2;
            while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
            i += 1;
            continue;
        }
        if (quote) {
            current += ch;
            if (ch === '\\') { current += next; i += 1; continue; }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
        if (ch === ';') {
            if (current.trim()) out.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim()) out.push(current.trim());
    return out;
}

async function applied() {
    await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        name varchar(120) NOT NULL PRIMARY KEY,
        applied_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    const [rows] = await db.query('SELECT name FROM schema_migrations');
    return new Set(rows.map(r => r.name));
}

async function main() {
    const files = fs.readdirSync(DIR).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
    const done = await applied();

    if (process.argv.includes('--status')) {
        files.forEach(f => console.log(`${done.has(f) ? 'applied ' : 'pending '} ${f}`));
        return;
    }

    // An empty database gets the whole current schema at once; every
    // migration is then recorded as applied.
    const [base] = await db.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'users'");
    if (Number(base[0].n) === 0) {
        console.log('Empty database: creating every table from database/schema.sql');
        const schema = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
        // One connection throughout: the file's SET statements (time zone,
        // foreign key checks) apply to the connection that runs them.
        const connection = await db.getConnection();
        try {
            for (const statement of statements(schema)) {
                try {
                    await connection.query(statement);
                } catch (error) {
                    console.error(`  failed: ${statement.split('\n')[0].slice(0, 90)}`);
                    throw error;
                }
            }
        } finally {
            connection.release();
        }
        for (const file of files) {
            await db.query('INSERT IGNORE INTO schema_migrations (name) VALUES (?)', [file]);
            done.add(file);
        }
    }

    for (const file of files) {
        if (done.has(file)) continue;
        if (DETECT[file]) {
            const [rows] = await db.query(DETECT[file]);
            if (Number(rows[0].n) > 0) {
                await db.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
                console.log(`Recorded ${file} (its changes were already in the database)`);
                continue;
            }
        }
        console.log(`Applying ${file}`);
        const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
        for (const statement of statements(sql)) {
            try {
                await db.query(statement);
            } catch (error) {
                if (ALREADY.has(error.code)) {
                    console.log(`  skipped, already present: ${statement.split('\n')[0].slice(0, 70)}`);
                    continue;
                }
                console.error(`  failed: ${statement.split('\n')[0].slice(0, 90)}`);
                throw error;
            }
        }
        await db.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
        console.log(`Applied ${file}`);
    }

    // The journal records existing balances the first time it is used.
    const opened = await db.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'chain_heads'");
    if (Number(opened[0][0].n) > 0) {
        const journal = require('../src/services/journal');
        const result = await journal.ensureOpened();
        if (result.opened) console.log(`Journal opened with the existing balances of ${result.accounts} accounts`);
    }
    console.log('Database is up to date.');
}

main()
    .catch(error => {
        console.error('Migration stopped:', error.message);
        if (error.code === 'ER_BINLOG_CREATE_ROUTINE_NEED_SUPER' || /SUPER privilege/.test(error.message)) {
            console.error('Creating triggers needs an administrator account. Set DB_USER=root in .env for this command, or ask the database administrator to set log_bin_trust_function_creators = 1.');
        }
        process.exitCode = 1;
    })
    .finally(() => db.end());
