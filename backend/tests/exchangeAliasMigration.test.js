'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '062_kraken_asset_aliases.sql'),
  'utf8'
);

test('Kraken alias migration is scoped, exact, idempotent, and data-only', () => {
  assert.match(migration, /UPDATE exchange_records er/);
  assert.match(migration, /FROM exchange_accounts ea/);
  assert.match(migration, /ea\.id = er\.exchange_account_id/);
  assert.match(migration, /ea\.exchange = 'kraken'/);
  assert.match(migration, /'SOL03', 'SOL03\.S'/);
  assert.match(migration, /base_asset/);
  assert.match(migration, /quote_asset/);
  assert.match(migration, /fee_asset/);
  assert.match(migration, /ELSE er\.base_asset/);
  assert.match(migration, /ELSE er\.quote_asset/);
  assert.match(migration, /ELSE er\.fee_asset/);
  assert.doesNotMatch(migration, /external_id\s*=/i);
  assert.doesNotMatch(migration, /raw\s*=/i);
  assert.doesNotMatch(migration, /exchange_matches|exchange_match_verdicts/i);
});
