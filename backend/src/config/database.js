const { Pool, types } = require('pg');
const logger = require('./logger');

types.setTypeParser(1114, str => new Date(str + 'Z'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle client');
});

module.exports = pool;
