// Shared Neon Postgres client for all functions. DATABASE_URL is a Netlify env var, never in client code.
const { Pool } = require('@neondatabase/serverless');

let pool;
function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured.');
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

async function query(sql, params) {
  const client = getPool();
  return client.query(sql, params);
}

// Runs fn(client) inside a single transaction (BEGIN/COMMIT/ROLLBACK).
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, withTransaction };
