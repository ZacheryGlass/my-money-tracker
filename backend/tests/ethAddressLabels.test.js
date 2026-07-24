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

test('upsert lowercases the address and forces source to user', async () => {
  queries.length = 0;
  await EthAddressLabel.upsert(MIXED_CASE, 'Coinbase', null);
  const { text, params } = queries[0];
  assert.equal(params[0], MIXED_CASE.toLowerCase());
  assert.equal(params[1], 'Coinbase');
  // Both the insert values and the conflict update must land on 'user' so a
  // user edit of a builtin row survives the seed migration re-running.
  const sql = text.replace(/\s+/g, ' ');
  assert.match(sql, /VALUES \(\$1, \$2, 'user', \$3\)/);
  assert.match(sql, /DO UPDATE SET .*source = 'user'/);
});

test('delete only removes user rows, never builtins', async () => {
  queries.length = 0;
  await EthAddressLabel.delete(MIXED_CASE);
  const { text, params } = queries[0];
  assert.equal(params[0], MIXED_CASE.toLowerCase());
  assert.match(text.replace(/\s+/g, ' '), /WHERE address = \$1 AND source = 'user'/);
});

test('findByAddress lowercases and returns null on miss', async () => {
  queries.length = 0;
  const row = await EthAddressLabel.findByAddress(MIXED_CASE);
  assert.equal(row, null);
  assert.equal(queries[0].params[0], MIXED_CASE.toLowerCase());
});
