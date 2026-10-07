'use strict';

// Exercises the tracked migration runner against throwaway Postgres:
//   - a fresh database adopts every file as baseline, and the next boot runs none;
//   - a legacy database (every file run twice by the old runner) adopts to the
//     same schema and the same builtin rows as a fresh one;
//   - the old runner can still run over an adopted database (rollback drill);
//   - a new file runs once and is recorded; checksum drift warns, or fails strict;
//   - concurrent runners serialize on the lock and both succeed.
//
//   node scripts/verify-migrations-sql.js [--pg-bin /path/to/postgres/bin]

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');
const { startCluster, REPO_BACKEND } = require('./lib/throwawayCluster');
const { runMigrations, migrationFiles, MIGRATIONS_DIR } = require('./lib/migrationRunner');

const checks = [];
const ok = (name, condition, detail) => {
  checks.push([name, Boolean(condition)]);
  if (!condition && detail !== undefined) console.log(`  detail for "${name}":`, detail);
};

function runMigrate(url, args = []) {
  return new Promise((resolve) => {
    const child = spawn('node', ['scripts/migrate.js', ...args], {
      cwd: REPO_BACKEND,
      env: { ...process.env, DATABASE_URL: url, NODE_ENV: 'test' },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolve({ code, output }));
  });
}

// The pre-tracking runner, exactly: every file, in order, on every boot.
async function legacyRun(url, dir = MIGRATIONS_DIR) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    for (const file of migrationFiles(dir)) {
      await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
    }
  } finally {
    await client.end();
  }
}

async function query(url, sql, params) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows;
  } finally {
    await client.end();
  }
}

const BUILTIN_HASH_SQL = `
  SELECT md5(string_agg(line, E'\\n' ORDER BY line)) AS digest FROM (
    SELECT 'label:' || address || ':' || name || ':' || source || ':' || COALESCE(kind, '') AS line
      FROM eth_address_labels WHERE user_id IS NULL
    UNION ALL
    SELECT 'endpoint:' || protocol || ':' || family_version || ':' || chain_id || ':' || address || ':' || role
      FROM eth_bridge_endpoints
    UNION ALL
    SELECT 'hop:' || deployment_key || ':' || family_version || ':' || route_key FROM eth_hop_bridge_routes
    UNION ALL
    SELECT 'asset:' || asset_code || ':' || canonical_key FROM evm_asset_identity_registry
  ) lines`;

function schemaDump(cluster, database) {
  const text = execFileSync(path.join(cluster.pgBin, 'pg_dump'), [
    '--schema-only', '--no-owner', '--no-privileges', '-d', `${cluster.url.replace(/\/postgres$/, `/${database}`)}`,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // pg_dump stamps a per-run restrict key; it carries no schema.
  return text.split('\n').filter((line) => !/^\\(un)?restrict /.test(line)).join('\n');
}

(async () => {
  let cluster;
  try {
    cluster = await startCluster({ prefix: 'migrations-verify-' });
  } catch (error) {
    console.error(error.message);
    process.exit(error.code === 'NO_PG_BIN' ? 2 : 1);
  }
  const urlFor = (database) => cluster.url.replace(/\/postgres$/, `/${database}`);
  for (const database of ['fresh', 'legacy', 'racing']) {
    await query(cluster.url, `CREATE DATABASE ${database}`);
  }
  const fileCount = migrationFiles().length;

  // --- fresh database: adopt, then nothing to do --------------------------
  const adopt = await runMigrate(urlFor('fresh'), ['--strict']);
  const baseline = await query(urlFor('fresh'), "SELECT COUNT(*)::int AS n FROM schema_migrations WHERE mode = 'baseline'");
  ok('a fresh database adopts every file as baseline', adopt.code === 0 && baseline[0].n === fileCount,
    { code: adopt.code, recorded: baseline[0].n, files: fileCount, tail: adopt.output.slice(-400) });
  const second = await runMigrate(urlFor('fresh'), ['--strict']);
  ok('the second boot runs zero files', second.code === 0 && /No pending migrations/.test(second.output)
    && !/Running /.test(second.output), second.output.slice(-400));

  // --- legacy database: old runner twice, then adopt -----------------------
  await legacyRun(urlFor('legacy'));
  await legacyRun(urlFor('legacy'));
  const legacyAdopt = await runMigrate(urlFor('legacy'), ['--strict']);
  ok('a legacy database adopts after the old runner', legacyAdopt.code === 0, legacyAdopt.output.slice(-400));
  const freshSchema = schemaDump(cluster, 'fresh');
  const legacySchema = schemaDump(cluster, 'legacy');
  ok('fresh and legacy-adopted schemas are identical', freshSchema === legacySchema,
    freshSchema === legacySchema ? undefined : 'pg_dump --schema-only differs');
  const [freshRows] = await query(urlFor('fresh'), BUILTIN_HASH_SQL);
  const [legacyRows] = await query(urlFor('legacy'), BUILTIN_HASH_SQL);
  ok('fresh and legacy-adopted builtin rows hash identically', freshRows.digest === legacyRows.digest);

  // --- rollback drill: the old runner over an adopted database -------------
  let drillError = null;
  try {
    await legacyRun(urlFor('fresh'));
  } catch (error) {
    drillError = error.message;
  }
  ok('the old runner still runs over an adopted database', drillError === null, drillError);
  const afterDrill = await runMigrate(urlFor('fresh'), ['--strict']);
  ok('after the drill the tracked runner still has nothing to do',
    afterDrill.code === 0 && /No pending migrations/.test(afterDrill.output), afterDrill.output.slice(-300));

  // --- a new file runs once; drift warns, strict fails ---------------------
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-copy-'));
  for (const file of migrationFiles()) fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(temp, file));
  fs.writeFileSync(path.join(temp, '999_verify_new_file.sql'), 'CREATE TABLE IF NOT EXISTS verify_new_file (id INT);\n');
  const run = async (options) => {
    const lockClient = new Client({ connectionString: urlFor('fresh') });
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: urlFor('fresh') });
    await lockClient.connect();
    const lines = [];
    try {
      return { result: await runMigrations({ pool, lockClient, dir: temp, log: (line) => lines.push(line), ...options }), lines };
    } catch (error) {
      return { error, lines };
    } finally {
      await lockClient.end();
      await pool.end();
    }
  };
  const added = await run({ strict: true });
  const [newRow] = await query(urlFor('fresh'), "SELECT mode FROM schema_migrations WHERE version = '999_verify_new_file'");
  ok('a new file runs once and is recorded as applied',
    added.result?.ran?.length === 1 && added.result.ran[0] === '999_verify_new_file.sql' && newRow?.mode === 'applied', added);
  fs.appendFileSync(path.join(temp, '999_verify_new_file.sql'), '-- edited after it was applied\n');
  const warned = await run({ strict: false });
  ok('drift on an applied file warns and runs nothing',
    !warned.error && warned.result.ran.length === 0 && warned.lines.some((line) => /changed after it was applied/.test(line)), warned.lines);
  const refused = await run({ strict: true });
  ok('drift fails a strict run', refused.error?.code === 'MIGRATION_DRIFT', refused.error?.message);
  fs.rmSync(temp, { recursive: true, force: true });

  // --- concurrent runners serialize on the lock ----------------------------
  const [first, raced] = await Promise.all([runMigrate(urlFor('racing')), runMigrate(urlFor('racing'))]);
  ok('two concurrent migration runs both succeed', first.code === 0 && raced.code === 0,
    { first: first.output.slice(-400), second: raced.output.slice(-400) });
  ok('the second concurrent run waited for the lock and then had nothing to do',
    [first, raced].some((r) => /holds the lock; waiting/.test(r.output) && /No pending migrations/.test(r.output)),
    [first.output.slice(-200), raced.output.slice(-200)]);

  console.log('\n--- checks ---');
  let failed = 0;
  for (const [name, passed] of checks) {
    console.log(`${passed ? 'PASS  ' : 'FAIL  '}${name}`);
    if (!passed) failed += 1;
  }
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : `\nALL ${checks.length} CHECKS PASSED`);
  cluster.stop();
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
