#!/usr/bin/env node
'use strict';

// Operator-reviewed private manifest; no provider calls or ledger mutations.
// node scripts/import-eth-history-findings.js --user <id> --file <private.json> [--apply]
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const pool = require('../src/config/database');
const { EthHistoryFindings } = require('../src/models/EthHistoryFindings');

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--user', '--file', '--apply'].includes(key) || Object.hasOwn(options, key)) throw new Error('Invalid arguments');
    options[key] = key === '--apply' ? true : args[++i];
  }
  if (!options['--file'] || !/^[1-9]\d*$/.test(options['--user'] || '')) throw new Error('Required: --user and --file');
  const stat = fs.statSync(options['--file']);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 2_000_000) throw new Error('Manifest must be a private file, at most 2 MB');
  const manifest = JSON.parse(fs.readFileSync(options['--file'], 'utf8'));
  console.log(JSON.stringify(await EthHistoryFindings.importForUser(Number(options['--user']), manifest, { apply: Boolean(options['--apply']) })));
}
main().catch(() => {
  // DB errors and malformed JSON can contain private input. Keep CLI output
  // aggregate-only, including on failures.
  console.error('History findings import failed; verify manifest, ownership, freshness and migrations.');
  process.exitCode = 1;
}).finally(() => pool.end());
