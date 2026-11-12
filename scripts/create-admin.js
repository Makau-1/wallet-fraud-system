// Creates an administrator account, or gives an existing account the
// administrator role.
//
//   node scripts/create-admin.js "Full Name" email@example.com "a-password"
//   node scripts/create-admin.js email@example.com          (existing account)
//
// With Docker:
//   docker compose exec web node scripts/create-admin.js "Full Name" email@example.com "a-password"

const bcrypt = require('bcrypt');
const db = require('../src/config/db');

(async () => {
    const args = process.argv.slice(2);
    try {
        if (args.length === 1) {
            const [result] = await db.execute("UPDATE users SET role = 'admin' WHERE LOWER(email) = ?", [args[0].toLowerCase()]);
            console.log(result.affectedRows ? `${args[0]} is now an administrator.` : `No account uses ${args[0]}.`);
            if (!result.affectedRows) process.exitCode = 1;
            return;
        }
        if (args.length !== 3) {
            console.log('Usage: node scripts/create-admin.js "Full Name" email@example.com "a-password"');
            process.exitCode = 1;
            return;
        }
        const [name, rawEmail, password] = args;
        const email = rawEmail.trim().toLowerCase();
        if (password.length < 8) {
            console.log('Use a password of at least 8 characters.');
            process.exitCode = 1;
            return;
        }
        const [existing] = await db.execute('SELECT id FROM users WHERE LOWER(email) = ?', [email]);
        if (existing.length) {
            await db.execute("UPDATE users SET role = 'admin' WHERE id = ?", [existing[0].id]);
            console.log(`${email} already existed and is now an administrator. Its password was not changed.`);
            return;
        }
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            const [user] = await connection.execute(
                "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')",
                [name, email, await bcrypt.hash(password, 10)]
            );
            await connection.execute('INSERT INTO wallets (user_id, balance) VALUES (?, 0)', [user.insertId]);
            await connection.commit();
            console.log(`Administrator ${email} created.`);
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error('Could not create the administrator:', error.message);
        process.exitCode = 1;
    } finally {
        await db.end();
    }
})();
