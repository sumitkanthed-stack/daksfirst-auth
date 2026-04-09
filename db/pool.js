const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Log connection events for debugging
pool.on('error', (err) => {
  console.error('[pool] Unexpected error on idle client:', err);
});

pool.on('connect', () => {
  console.log('[pool] Database connection established');
});

module.exports = pool;
