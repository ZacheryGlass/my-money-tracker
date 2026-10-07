'use strict';

// A throwaway PostgreSQL cluster for the real-SQL harnesses.
//
// It NEVER touches the configured DATABASE_URL: the cluster is initdb'd into a
// fresh temp dir, listens on a kernel-assigned TCP port with no unix socket,
// and is removed on exit.

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const REPO_BACKEND = path.join(__dirname, '..', '..');

// --pg-bin, then Homebrew, Postgres.app, then a plain PATH install.
function findPgBin(argv = process.argv) {
  const flagIndex = argv.indexOf('--pg-bin');
  if (flagIndex !== -1 && argv[flagIndex + 1]) return argv[flagIndex + 1];
  const roots = ['/opt/homebrew/opt', '/usr/local/opt', '/Applications/Postgres.app/Contents/Versions'];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root).sort().reverse()) {
      const bin = path.join(root, entry, 'bin');
      if (fs.existsSync(path.join(bin, 'initdb'))) return bin;
    }
  }
  const which = spawnSync('sh', ['-c', 'command -v initdb'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return path.dirname(which.stdout.trim());
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Boots a cluster and returns { url, stop }. stop() also runs on process exit.
async function startCluster({ prefix = 'pg-verify-', argv = process.argv, log = console.log } = {}) {
  const pgBin = findPgBin(argv);
  if (!pgBin) {
    const error = new Error('No Postgres binaries found. Pass --pg-bin /path/to/bin.');
    error.code = 'NO_PG_BIN';
    throw error;
  }
  const data = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // LC_ALL/LANG on BOTH initdb and pg_ctl: a mismatch makes the cluster refuse to
  // start with a locale error that reads as a corrupt data directory.
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C', PGDATA: data };
  let started = false;
  const stop = () => {
    if (started) {
      spawnSync(path.join(pgBin, 'pg_ctl'), ['-D', data, '-m', 'immediate', 'stop'], { env });
      started = false;
    }
    try { fs.rmSync(data, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  process.on('exit', stop);

  log(`initdb -> ${data}`);
  execFileSync(path.join(pgBin, 'initdb'),
    ['-D', data, '-U', 'postgres', '--encoding=UTF8', '--locale=C', '-A', 'trust'],
    { env, stdio: 'pipe' });

  const port = await freePort();
  execFileSync(path.join(pgBin, 'pg_ctl'), [
    '-D', data, '-l', path.join(data, 'server.log'), '-w', '-o',
    // TCP only: unix_socket_directories='' keeps the cluster off any shared
    // socket path, so nothing else on the machine can reach it.
    `-p ${port} -h 127.0.0.1 -k "" -c unix_socket_directories=''`, 'start',
  ], { env, stdio: 'pipe' });
  started = true;

  return { url: `postgresql://postgres@127.0.0.1:${port}/postgres`, pgBin, stop };
}

// Applies the full migration chain `passes` times through the real runner.
// Migrations re-run on every boot, so a second pass is part of what is tested.
function applyMigrations(url, { passes = 2, log = console.log } = {}) {
  for (let pass = 1; pass <= passes; pass += 1) {
    const result = spawnSync('node', ['scripts/migrate.js'], {
      cwd: REPO_BACKEND,
      env: { ...process.env, DATABASE_URL: url, NODE_ENV: 'test' },
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      const error = new Error(`migration pass ${pass} FAILED\n${result.stdout}\n${result.stderr}`);
      error.code = 'MIGRATION_FAILED';
      throw error;
    }
    log(`migrations pass ${pass}: OK`);
  }
}

module.exports = { findPgBin, freePort, startCluster, applyMigrations, REPO_BACKEND };
