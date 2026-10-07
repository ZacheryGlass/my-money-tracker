#!/usr/bin/env node

// Applies backend/migrations/ through the tracked runner (scripts/lib/
// migrationRunner.js): each file runs once per database, under a lock.
//
//   node scripts/migrate.js            boot / deploy (drift only warns)
//   node scripts/migrate.js --strict   CI (checksum drift fails)
//   node scripts/migrate.js --rerun-all  legacy re-run of every file, kept
//                                        while idempotency is still tested

require('dotenv').config();
const { Client } = require('pg');
const pool = require('../src/config/database');
const { runMigrations } = require('./lib/migrationRunner');

async function main() {
  const lockClient = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  await lockClient.connect();
  try {
    await runMigrations({
      pool,
      lockClient,
      strict: process.argv.includes('--strict') || process.env.MIGRATIONS_STRICT === '1',
      rerunAll: process.argv.includes('--rerun-all'),
    });
  } finally {
    // Ending the session releases the lock even if COMMIT was never reached.
    await lockClient.end().catch(() => {});
  }
  console.log('All migrations completed successfully');
}

main().then(() => process.exit(0)).catch((error) => {
  console.error('Migration failed:', error.message);
  process.exit(1);
});
