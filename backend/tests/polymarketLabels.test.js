'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const migration = fs.readFileSync(
  path.join(__dirname, '../migrations/052_seed_polymarket_labels.sql'),
  'utf8'
);

const EXPECTED = new Map([
  ['0x4d97dcd97ec945f40cf65f87097ace5ea0476045', 'Polymarket: Conditional Tokens'],
  ['0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e', 'Polymarket: CTF Exchange V1'],
  ['0xc5d563a36ae78145c45a50134d48a1215220f80a', 'Polymarket: Neg Risk Exchange V1'],
  ['0xd91e80cf2e7be2e162c6513ced06f1dd0da35296', 'Polymarket: Neg Risk Adapter'],
]);

test('Polymarket label pack has four official, auditable external rows', () => {
  assert.match(migration, /%builtin-polymarket%/);
  assert.match(
    migration,
    /CHECK \(source IN \('user', 'builtin', 'eth-labels', 'auto-match', 'builtin-bridge', 'builtin-polymarket'\)\)/
  );
  assert.match(migration, /ON CONFLICT \(address\) WHERE user_id IS NULL DO NOTHING;/);
  assert.doesNotMatch(migration.replace(/--[^\n]*/g, ''), /DO UPDATE/);

  const rows = [...migration.matchAll(
    /\(NULL, '(0x[0-9a-f]{40})', '([^']+)', 'builtin-polymarket', '([^']+)', '([^']+)', '([^']+)'\),?/g
  )];
  assert.equal(rows.length, EXPECTED.size);
  const addresses = new Set();
  for (const [, address, name, kind, confidence, note] of rows) {
    assert.ok(!addresses.has(address), `duplicate ${address}`);
    addresses.add(address);
    assert.equal(EXPECTED.get(address), name);
    assert.equal(kind, 'external');
    assert.equal(confidence, 'high');
    assert.match(note, /Source: https:\/\/github\.com\/(?:Polymarket|polymarket)\//i);
  }
  assert.deepEqual(addresses, new Set(EXPECTED.keys()));
});
