/**
 * PostgreSQL connection pool with PostGIS support
 * Uses pg-pool for connection management with retry logic
 */

'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Individual params (used if DATABASE_URL not set)
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME     || 'sathi_db',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',

  // Pool configuration
  max:              20,   // max connections in pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

/**
 * Execute a parameterized query.
 * @param {string} text   SQL string with $1, $2 placeholders
 * @param {Array}  params Values array
 */
async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 500 && process.env.NODE_ENV !== 'test') {
    console.warn(`Slow query (${duration}ms):`, text.substr(0, 80));
  }
  return result;
}

/**
 * Execute multiple queries in a single transaction.
 * @param {function} callback Receives `client`, returns a Promise
 */
async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Verify DB connectivity — used in health check.
 */
async function healthCheck() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

async function connect() {
  // Trigger a test connection to validate credentials at startup
  const client = await pool.connect();
  client.release();
}

module.exports = { query, transaction, healthCheck, connect, pool };
