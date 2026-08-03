'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const migration = fs.readFileSync(
  path.join(__dirname, '../migrations/070_seed_opensea_seaport_label.sql'),
  'utf8'
);

test('Seaport label is a single high-confidence, provenance-preserving row', () => {
  assert.match(migration, /%builtin-opensea%/);
  assert.match(
    migration,
    /CHECK \(source IN \('user', 'builtin', 'eth-labels', 'auto-match',\s+'builtin-bridge', 'builtin-polymarket',\s+'builtin-etherdelta', 'builtin-opensea'\)\)/
  );
  assert.match(
    migration,
    /NULL,\s+'0x00000000000000adc04c56bf30ac9d3c0aaf14dc',\s+'OpenSea: Seaport 1\.5',\s+'builtin-opensea',\s+'external',\s+'high'/
  );
  assert.match(migration, /Source: https:\/\/github\.com\/ProjectOpenSea\/opensea-js/);
  assert.match(migration, /ON CONFLICT \(address\) WHERE user_id IS NULL DO NOTHING;/);
  assert.doesNotMatch(migration.replace(/--[^\n]*/g, ''), /DO UPDATE/);
});
