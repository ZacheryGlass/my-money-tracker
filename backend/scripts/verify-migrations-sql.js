'use strict';

// Exercises the migration runner itself against throwaway Postgres clusters:
// concurrent runs serialize on the runner lock and both succeed.
//
//   node scripts/verify-migrations-sql.js [--pg-bin /path/to/postgres/bin]

const { spawn } = require('child_process');
const { startCluster, REPO_BACKEND } = require('./lib/throwawayCluster');

const checks = [];
const ok = (name, condition, detail) => {
  checks.push([name, Boolean(condition)]);
  if (!condition && detail !== undefined) console.log(`  detail for "${name}":`, detail);
};

function runMigrate(url) {
  return new Promise((resolve) => {
    const child = spawn('node', ['scripts/migrate.js'], {
      cwd: REPO_BACKEND,
      env: { ...process.env, DATABASE_URL: url, NODE_ENV: 'test' },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolve({ code, output }));
  });
}

(async () => {
  let cluster;
  try {
    cluster = await startCluster({ prefix: 'migrations-verify-' });
  } catch (error) {
    console.error(error.message);
    process.exit(error.code === 'NO_PG_BIN' ? 2 : 1);
  }

  // Two runners started together: one waits for the other, both succeed.
  const [first, second] = await Promise.all([runMigrate(cluster.url), runMigrate(cluster.url)]);
  ok('two concurrent migration runs both succeed', first.code === 0 && second.code === 0,
    { first: first.output.slice(-600), second: second.output.slice(-600) });
  ok('the second concurrent run waited for the runner lock',
    /holds the lock; waiting/.test(first.output) || /holds the lock; waiting/.test(second.output));

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
