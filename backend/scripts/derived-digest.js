'use strict';

// Canonical digest of one user's derived crypto tables and their inputs.
//
//   node scripts/derived-digest.js --user-id 1 --output /abs/private/before.json [--rows]
//   node scripts/derived-digest.js --diff /abs/before.json /abs/after.json
//
// Read-only: one REPEATABLE READ READ ONLY snapshot. --rows keeps every
// canonical row so --diff can name the rows that changed; such a file holds
// addresses and amounts, so it is written 0600 to a gitignored path.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const fs = require('fs');
const { Client } = require('pg');
const { computeDigest, diffDigests } = require('./lib/derivedDigest');
const { writePrivateReport } = require('../src/utils/privateReport');

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

async function main() {
  const diffIndex = process.argv.indexOf('--diff');
  if (diffIndex !== -1) {
    const [beforePath, afterPath] = process.argv.slice(diffIndex + 1, diffIndex + 3);
    const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
    const after = JSON.parse(fs.readFileSync(afterPath, 'utf8'));
    const diff = diffDigests(before, after);
    const changed = Object.keys(diff.derived).length + Object.keys(diff.inputs).length;
    const summary = {
      derived_equal: before.derived_sha256 === after.derived_sha256,
      inputs_equal: before.input_sha256 === after.input_sha256,
      tables: Object.fromEntries(['derived', 'inputs'].map((section) => [section,
        Object.fromEntries(Object.entries(diff[section]).map(([name, entry]) => [name, {
          before_rows: entry.before_rows,
          after_rows: entry.after_rows,
          only_before: entry.only_before?.length ?? null,
          only_after: entry.only_after?.length ?? null,
        }]))])),
    };
    console.log(JSON.stringify(summary, null, 2));
    const out = arg('--output');
    if (out) writePrivateReport(out, diff);
    process.exit(changed === 0 ? 0 : 3);
  }

  const userId = Number(arg('--user-id'));
  const output = arg('--output');
  if (!Number.isInteger(userId) || userId <= 0) throw new Error('--user-id is required');
  if (!output) throw new Error('--output /absolute/private/path.json is required');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const host = new URL(url).hostname;
  const client = new Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(host) ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  let digest;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    digest = await computeDigest(client, userId, { keepLines: process.argv.includes('--rows') });
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
  digest.generated_at = new Date().toISOString();
  writePrivateReport(output, digest);
  const counts = (section) => Object.fromEntries(Object.entries(digest[section])
    .map(([name, entry]) => [name, entry.rows ?? entry.skipped]));
  console.log(JSON.stringify({
    derived_sha256: digest.derived_sha256,
    input_sha256: digest.input_sha256,
    derived_rows: counts('derived'),
    input_rows: counts('inputs'),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
