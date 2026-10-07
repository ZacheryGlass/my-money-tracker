'use strict';

// Seed generators append the next migration instead of rewriting an applied
// one. The delta carries the full block (DO NOTHING inserts add new rows),
// UPDATEs for changed rows and scoped DELETE tombstones for removed ones.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeSeedDelta, latestBlock, parseTuple, insertSections } = require('../scripts/lib/seedDelta');

const START = '-- BEGIN TEST SEED';
const END = '-- END TEST SEED';
const SPECS = { eth_address_labels: { key: ['address'], scope: "user_id IS NULL AND source = 'test'" } };
const block = (rows) => [
  START,
  'INSERT INTO eth_address_labels (user_id, address, name, source) VALUES',
  rows.map(([address, name]) => `  (NULL, '${address}', '${name}', 'test')`).join(',\n'),
  'ON CONFLICT (address) WHERE user_id IS NULL DO NOTHING;',
  END,
].join('\n');

function tempMigrations(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-delta-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test('literal tuples keep escapes and casts verbatim', () => {
  assert.deepEqual(parseTuple("  ('a''b', 12, NULL, '{\"k\":1}'::jsonb),"), ["'a''b'", '12', 'NULL', '\'{"k":1}\'::jsonb']);
  assert.deepEqual(insertSections(block([['0x1', 'One'], ['0x2', 'Two']]))[0].rows.length, 2);
});

test('an unchanged pack writes nothing', (t) => {
  const dir = tempMigrations(t, { '010_seed.sql': `-- seed\n${block([['0x1', 'One']])}\n` });
  const result = writeSeedDelta({ start: START, end: END, desiredBlock: block([['0x1', 'One']]), stem: 'seed_delta', header: '-- h', specs: SPECS, dir });
  assert.equal(result.written, null);
  assert.equal(fs.readdirSync(dir).length, 1);
});

test('a changed pack becomes the next migration with updates and tombstones', (t) => {
  const dir = tempMigrations(t, {
    '010_seed.sql': `-- seed\n${block([['0x1', 'One'], ['0x2', 'Two']])}\n`,
    '011_other.sql': 'SELECT 1;\n',
  });
  const desired = block([['0x1', 'Uno'], ['0x3', 'Three']]);
  const result = writeSeedDelta({ start: START, end: END, desiredBlock: desired, stem: 'seed_delta', header: '-- h', specs: SPECS, dir });
  assert.equal(path.basename(result.written), '012_seed_delta.sql');
  assert.deepEqual(result.summary, { added: 1, changed: 1, removed: 1 });
  const written = fs.readFileSync(result.written, 'utf8');
  assert.ok(written.includes(desired));
  assert.match(written, /UPDATE eth_address_labels SET name = 'Uno'\n WHERE user_id IS NULL AND source = 'test' AND address = '0x1';/);
  assert.match(written, /DELETE FROM eth_address_labels\n WHERE user_id IS NULL AND source = 'test'\n {3}AND \(address\) IN \(VALUES\n {2}\('0x2'\)\n\);/);
  // The applied file is untouched, and the delta is now the cumulative block.
  assert.ok(fs.readFileSync(path.join(dir, '010_seed.sql'), 'utf8').includes("'Two'"));
  assert.equal(latestBlock(START, END, dir).file, '012_seed_delta.sql');
  const again = writeSeedDelta({ start: START, end: END, desiredBlock: desired, stem: 'seed_delta', header: '-- h', specs: SPECS, dir });
  assert.equal(again.written, null);
});
