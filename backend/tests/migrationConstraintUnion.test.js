'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Migrations re-run on every boot. Two migrations that unconditionally drop and
// re-add the same CHECK must list identical values, or a row using a value only
// the later one allows fails the earlier one at the next boot. Sentinel-guarded
// swaps (pg_get_constraintdef LIKE ...) only act when their value is missing.
test('unguarded CHECK re-adds of one constraint list the same values', () => {
  const dir = path.join(__dirname, '..', 'migrations');
  const byName = new Map();
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const match of sql.matchAll(/ADD\s+CONSTRAINT\s+(\w+)\s+CHECK\s*\(([\s\S]*?)\)\s*;/gi)) {
      const [, name, body] = match;
      if (!new RegExp(`DROP\\s+CONSTRAINT\\s+(IF\\s+EXISTS\\s+)?${name}\\b`, 'i').test(sql)) continue;
      if (/pg_get_constraintdef/i.test(sql)) continue;
      const values = [...body.matchAll(/'([^']*)'/g)].map((value) => value[1]).sort().join(',');
      if (!values) continue;
      if (!byName.has(name)) byName.set(name, new Map());
      byName.get(name).set(file, values);
    }
  }
  for (const [name, files] of byName) {
    assert.equal(new Set(files.values()).size, 1, `${name}: ${JSON.stringify(Object.fromEntries(files))}`);
  }
  assert.ok(byName.has('exchange_accounts_last_sync_status_check'));
});
