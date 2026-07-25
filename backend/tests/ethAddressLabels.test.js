'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const queries = [];
const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      async query(text, params) {
        queries.push({ text, params });
        return { rows: [] };
      }
      connect() { throw new Error('Unexpected connect'); }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const EthAddressLabel = require('../src/models/EthAddressLabel');

const MIXED_CASE = '0xAbCd000000000000000000000000000000000001';

test('upsert lowercases the address and writes a user-owned row', async () => {
  queries.length = 0;
  await EthAddressLabel.upsert(1, MIXED_CASE, 'Coinbase', null);
  const { text, params } = queries[0];
  assert.equal(params[0], 1);
  assert.equal(params[1], MIXED_CASE.toLowerCase());
  assert.equal(params[2], 'Coinbase');
  // User rows are separate from builtins (user_id NULL): the arbiter is the
  // partial per-user unique index, so builtins never get clobbered.
  const sql = text.replace(/\s+/g, ' ');
  assert.match(sql, /VALUES \(\$1, \$2, \$3, 'user', \$4\)/);
  assert.match(sql, /ON CONFLICT \(user_id, address\) WHERE user_id IS NOT NULL/);
});

test('delete only removes the caller\'s rows, never builtins', async () => {
  queries.length = 0;
  await EthAddressLabel.delete(1, MIXED_CASE);
  const { text, params } = queries[0];
  assert.deepEqual(params, [1, MIXED_CASE.toLowerCase()]);
  // Builtins have user_id NULL, which never matches the equality predicate.
  assert.match(text.replace(/\s+/g, ' '), /WHERE user_id = \$1 AND address = \$2/);
});

test('findByAddress prefers the user row over a builtin', async () => {
  queries.length = 0;
  const row = await EthAddressLabel.findByAddress(1, MIXED_CASE);
  assert.equal(row, null);
  const { text, params } = queries[0];
  assert.deepEqual(params, [MIXED_CASE.toLowerCase(), 1]);
  const sql = text.replace(/\s+/g, ' ');
  assert.match(sql, /user_id = \$2 OR user_id IS NULL/);
  assert.match(sql, /ORDER BY user_id NULLS LAST/);
});

test('findAllForUser shadows builtins with the user\'s own rows', async () => {
  queries.length = 0;
  await EthAddressLabel.findAllForUser(1);
  const sql = queries[0].text.replace(/\s+/g, ' ');
  assert.match(sql, /DISTINCT ON \(address\)/);
  assert.match(sql, /user_id = \$1 OR user_id IS NULL/);
  assert.match(sql, /ORDER BY address, user_id NULLS LAST/);
});
