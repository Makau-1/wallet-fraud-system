/**
 * User model functions using the shared MySQL pool
 * - createUser(name, email, passwordHash) -> inserts a new user, returns inserted id
 * - findUserByEmail(email) -> returns the user row or null
 * Uses parameterized queries only.
 */

const pool = require('../config/db');

/**
 * Inserts a new user and returns the inserted id
 * @param {string} name
 * @param {string} email
 * @param {string} passwordHash
 * @returns {Promise<number>} insertId
 */
async function createUser(name, email, passwordHash) {
	const sql = 'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)';
	const params = [name || null, email, passwordHash];
	const [result] = await pool.execute(sql, params);
	return result.insertId;
}

/**
 * Finds a user by email. Returns the row or null if not found.
 * @param {string} email
 * @returns {Promise<Object|null>} user row
 */
async function findUserByEmail(email) {
	const sql = `SELECT id, name, email, password_hash AS passwordHash, role, created_at AS createdAt, updated_at AS updatedAt
							 FROM users WHERE email = ? LIMIT 1`;
	const [rows] = await pool.execute(sql, [email]);
	return rows.length ? rows[0] : null;
}

module.exports = {
	createUser,
	findUserByEmail
};
