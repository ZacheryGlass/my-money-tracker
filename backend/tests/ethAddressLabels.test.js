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
  // Callers that predate the kind column pass nothing, which must mean "leave
  // the verdict alone", not "make it an exchange".
  assert.equal(params[4], null);
  // User rows are separate from builtins (user_id NULL): the arbiter is the
  // partial per-user unique index, so builtins never get clobbered. The insert
  // arm consults the builtin row before defaulting: naming a pack 'external'
  // gateway must inherit 'external', not re-vote it to 'exchange'.
  const sql = text.replace(/\s+/g, ' ');
  // $2 is cast at both uses: the INSERT position would deduce varchar (the
  // column type) while the subselect comparison deduces text, and Postgres
  // rejects the conflict (42P08) -- caught against a real database, which the
  // fake pool here cannot do.
  assert.match(sql, /VALUES \(\$1, \$2::text, \$3, 'user', \$4, COALESCE\(\$5, \(SELECT kind FROM eth_address_labels WHERE address = \$2::text AND user_id IS NULL\), 'exchange'\)\)/);
  assert.match(sql, /ON CONFLICT \(user_id, address\) WHERE user_id IS NOT NULL/);
});

test('upsert preserves an existing verdict when no kind is given', async () => {
  queries.length = 0;
  await EthAddressLabel.upsert(1, MIXED_CASE, 'My cold wallet', null, 'own');
  const { text, params } = queries[0];
  assert.equal(params[4], 'own');
  const sql = text.replace(/\s+/g, ' ');
  // A NULL kind keeps the stored verdict. Writing EXCLUDED.kind outright would
  // let a plain rename -- which sends no kind -- flip an 'own' address to
  // 'exchange', dropping it out of the own set and turning a self-transfer
  // into a phantom exchange deposit.
  assert.match(sql, /kind = COALESCE\(\$5, eth_address_labels\.kind\)/);
  // note keeps its COALESCE -- a re-label with no note must not erase one.
  assert.match(sql, /note = COALESCE\(EXCLUDED\.note, eth_address_labels\.note\)/);
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
