'use strict';

// The frontend test suite renders with a recorded copy of GET /api/crypto/meta
// (frontend/src/test/cryptoMeta.fixture.json). It must be exactly what the
// backend serves, or the UI tests pass against a registry that no longer
// exists. Regenerate with UPDATE_SNAPSHOTS=1.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
delete process.env.ETH_CHAINS;

const FIXTURE = path.join(__dirname, '..', '..', 'frontend', 'src', 'test', 'cryptoMeta.fixture.json');

test('the frontend meta fixture is the meta the backend serves', () => {
  const actual = JSON.parse(JSON.stringify(require('../src/crypto/meta').buildCryptoMeta()));
  if (process.env.UPDATE_SNAPSHOTS === '1') fs.writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
  assert.deepEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')), actual);
});
