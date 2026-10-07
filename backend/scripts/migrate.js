#!/usr/bin/env node

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const pool = require('../src/config/database');

// One runner at a time. A boot and an operator's pre-restart run (or two
// instances during a rolling deploy) used to interleave every file. The lock
// is transaction-scoped on a DEDICATED client whose transaction stays open
// for the whole run: that holds under a transaction-mode connection pooler
// (the open transaction pins one server connection), where a session lock
// could be taken on one server connection and "released" on another.
const MIGRATION_LOCK = [0x4D494752, 1]; // "MIGR"

async function withMigrationLock(fn) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    // A stuck holder must fail this boot loudly rather than hang it forever.
    await client.query("SET LOCAL lock_timeout = '15min'");
    const { rows } = await client.query('SELECT pg_try_advisory_xact_lock($1, $2) AS locked', MIGRATION_LOCK);
    if (!rows[0].locked) {
      console.log('Another migration run holds the lock; waiting...');
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', MIGRATION_LOCK);
    }
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } finally {
    // Ending the session releases the lock even if COMMIT was never reached.
    await client.end().catch(() => {});
  }
}

async function runMigrations() {
  try {
    const migrationsDir = path.join(__dirname, '../migrations');

    // Get all .sql files sorted by name
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.log('No migration files found');
      process.exit(0);
    }

    console.log(`Found ${files.length} migration(s)`);

    await withMigrationLock(async () => {
      for (const file of files) {
        const migrationPath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(migrationPath, 'utf-8');

        console.log(`Running ${file}...`);
        await pool.query(sql);
        console.log(`  Done`);
      }
    });

    console.log('All migrations completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exit(1);
  }
}

runMigrations();
