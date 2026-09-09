/**
 * MySQL connection pool using mysql2/promise
 * Reads configuration from environment variables and exports the pool
 */

require('dotenv').config();

const mysql = require('mysql2/promise');

const {
    DB_HOST = '127.0.0.1',
    DB_PORT = '3306',
    DB_USER,
    DB_PASSWORD,
    DB_NAME,
    DB_CONN_LIMIT = '10'
} = process.env;

if (!DB_USER || !DB_PASSWORD || !DB_NAME) {
    console.warn(
        'DB env vars DB_USER/DB_PASSWORD/DB_NAME are not all set. Connection may fail at runtime.'
    );
}

const pool = mysql.createPool({
    host: DB_HOST,
    port: parseInt(DB_PORT, 10),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: parseInt(DB_CONN_LIMIT, 10) || 10,
    queueLimit: 0,
    namedPlaceholders: true,
    timezone: 'Z'
});

module.exports = pool;
