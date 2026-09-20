'use strict';

const { Pool } = require('pg');
const logger = require('./logger');

// Session advisory locks must retain one PostgreSQL connection for the full
// protected task. Keep those connections out of the application query pool so
// provider-heavy syncs can never consume every connection that their own model
// queries need in order to finish and release the lock.
const advisoryLocks = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 4,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 30000,
});

advisoryLocks.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle advisory-lock client');
});

module.exports = advisoryLocks;
