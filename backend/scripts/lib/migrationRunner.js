'use strict';

// Tracked migrations: each file runs once per database and is recorded in
// schema_migrations(version = file stem, checksum, applied_at, duration_ms,
// mode).
//
// Adoption is automatic. A database with no recorded migrations (a fresh one,
// or a legacy one whose runner re-ran every file on every boot) runs EVERY
// file exactly as the legacy runner did, then records them all as 'baseline'
// in one transaction. A failed pass records nothing, so the next boot retries
// the same adoption. After that only unrecorded files run, in filename order,
// each recorded in the same transaction as its statements -- or straight after
// it, for a file that manages its own BEGIN/COMMIT.
//
// A recorded file whose bytes changed is checksum drift: the change will never
// reach a database that already ran it. Boot warns and continues; strict mode
// (CI) fails.
//
// One runner at a time: a transaction-scoped advisory lock on a dedicated
// client, held for the whole run (see withMigrationLock).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');
const MIGRATION_LOCK = [0x4D494752, 1]; // "MIGR"

function migrationFiles(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
}

function versionOf(file) {
  return file.replace(/\.sql$/, '');
}

function checksumOf(sql) {
  // Line endings do not change what a file does; a CRLF checkout must not read
  // as drift.
  return crypto.createHash('sha256').update(String(sql).replace(/\r\n/g, '\n')).digest('hex');
}

// A file with a top-level BEGIN owns its transaction; it cannot be wrapped.
function managesOwnTransaction(sql) {
  return /^\s*BEGIN\s*;/mi.test(sql);
}

const TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    duration_ms INTEGER,
    mode TEXT NOT NULL CHECK (mode IN ('baseline', 'applied'))
  )`;

// lockClient: a connected pg.Client used only for the lock. connect(): returns
// a pooled client for running files (released by this module).
async function withMigrationLock(lockClient, fn, { log = console.log } = {}) {
  await lockClient.query('BEGIN');
  try {
    // A stuck holder must fail this boot loudly rather than hang it forever.
    await lockClient.query("SET LOCAL lock_timeout = '15min'");
    const { rows } = await lockClient.query('SELECT pg_try_advisory_xact_lock($1, $2) AS locked', MIGRATION_LOCK);
    if (!rows[0].locked) {
      log('Another migration run holds the lock; waiting...');
      await lockClient.query('SELECT pg_advisory_xact_lock($1, $2)', MIGRATION_LOCK);
    }
    const result = await fn();
    await lockClient.query('COMMIT');
    return result;
  } catch (error) {
    try { await lockClient.query('ROLLBACK'); } catch { /* the session end releases it */ }
    throw error;
  }
}

async function recorded(pool) {
  await pool.query(TABLE_DDL);
  const { rows } = await pool.query('SELECT version, checksum FROM schema_migrations');
  return new Map(rows.map((row) => [row.version, row.checksum]));
}

async function runFile(pool, file, sql, { record, mode }) {
  const started = Date.now();
  if (!record || managesOwnTransaction(sql)) {
    await pool.query(sql);
    const durationMs = Date.now() - started;
    if (record) {
      await pool.query(
        `INSERT INTO schema_migrations (version, checksum, duration_ms, mode) VALUES ($1, $2, $3, $4)`,
        [versionOf(file), checksumOf(sql), durationMs, mode]
      );
    }
    return durationMs;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    const durationMs = Date.now() - started;
    await client.query(
      `INSERT INTO schema_migrations (version, checksum, duration_ms, mode) VALUES ($1, $2, $3, $4)`,
      [versionOf(file), checksumOf(sql), durationMs, mode]
    );
    await client.query('COMMIT');
    return durationMs;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* surface the original error */ }
    throw error;
  } finally {
    client.release();
  }
}

// options:
//   strict     -- checksum drift (or a recorded file missing on disk) throws.
//   rerunAll   -- legacy behavior for the transition: run every file again
//                 (idempotency is still under test) and record any missing.
async function runMigrations({ pool, lockClient, dir = MIGRATIONS_DIR, strict = false, rerunAll = false, log = console.log }) {
  const files = migrationFiles(dir);
  if (!files.length) {
    log('No migration files found');
    return { ran: [], mode: 'none' };
  }
  log(`Found ${files.length} migration(s)`);

  return withMigrationLock(lockClient, async () => {
    const done = await recorded(pool);
    const sources = new Map(files.map((file) => [file, fs.readFileSync(path.join(dir, file), 'utf8')]));

    const drift = files.filter((file) => done.has(versionOf(file))
      && done.get(versionOf(file)) !== checksumOf(sources.get(file)));
    const missing = [...done.keys()].filter((version) => !sources.has(`${version}.sql`));
    for (const file of drift) log(`WARNING: ${file} changed after it was applied; the change will not run`);
    for (const version of missing) log(`WARNING: ${version} is recorded but has no file`);
    if (strict && (drift.length || missing.length)) {
      const error = new Error(`Migration checksum drift: ${[...drift, ...missing].join(', ')}`);
      error.code = 'MIGRATION_DRIFT';
      throw error;
    }

    if (done.size === 0) {
      // Adoption: run everything as the legacy runner did, then record it all.
      for (const file of files) {
        log(`Running ${file}...`);
        await runFile(pool, file, sources.get(file), { record: false });
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const file of files) {
          await client.query(
            `INSERT INTO schema_migrations (version, checksum, duration_ms, mode) VALUES ($1, $2, NULL, 'baseline')`,
            [versionOf(file), checksumOf(sources.get(file))]
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* surface the original error */ }
        throw error;
      } finally {
        client.release();
      }
      log(`Adopted ${files.length} migration(s) as baseline`);
      return { ran: files, mode: 'baseline', drift };
    }

    const ran = [];
    for (const file of files) {
      const pending = !done.has(versionOf(file));
      if (!pending && !rerunAll) continue;
      log(`Running ${file}...`);
      await runFile(pool, file, sources.get(file), { record: pending, mode: 'applied' });
      ran.push(file);
    }
    log(ran.length ? `Applied ${ran.length} migration(s)` : 'No pending migrations');
    return { ran, mode: rerunAll ? 'rerun-all' : 'incremental', drift };
  });
}

module.exports = {
  MIGRATIONS_DIR, MIGRATION_LOCK, migrationFiles, versionOf, checksumOf, managesOwnTransaction, runMigrations,
};
