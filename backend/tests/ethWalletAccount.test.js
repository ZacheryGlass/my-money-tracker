'use strict';

// addWallet's account handling. Unlike the other eth test files this one needs
// a working pool.connect(), because the wallet+account write is a transaction.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
// Resolution is DB -> env -> null; the fake pool returns no rows, so this env
// value is what lets addWallet past its fail-fast Etherscan check.
process.env.ETHERSCAN_API_KEY = 'test-key';

const queries = [];
// Rows returned for the next matching statement, keyed by a substring.
let clientResponses = [];

const respond = (text) => {
  const match = clientResponses.find((r) => text.includes(r.match));
  if (match?.throws) throw match.throws;
  return { rows: match ? match.rows : [] };
};

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
      async connect() {
        return {
          async query(text, params) {
            queries.push({ text, params });
            return respond(text);
          },
          release() {},
        };
      }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const EthWalletService = require('../src/services/EthWalletService');

const ADDRESS = '0xAbCd000000000000000000000000000000000001';
const ACCOUNT_NAME = 'Ethereum 0xabcd…0001';

const reset = (responses) => {
  queries.length = 0;
  clientResponses = [
    { match: 'INSERT INTO eth_wallets', rows: [{ id: 42, address: ADDRESS.toLowerCase() }] },
    ...responses,
  ];
};

const clientQueries = () => queries.filter((q) => /INSERT INTO accounts|UPDATE accounts|INSERT INTO eth_wallets/.test(q.text));

test('addWallet re-attaches an account left behind by a keep-data disconnect', async () => {
  // Disconnecting with removeData=false nulls accounts.eth_wallet_id but keeps
  // the row, name included. Re-adding the address must adopt that row.
  reset([{ match: 'UPDATE accounts', rows: [{ id: 9, name: ACCOUNT_NAME }] }]);

  const { account } = await EthWalletService.addWallet(1, ADDRESS, 'Cold storage');
  assert.equal(account.id, 9);

  const update = clientQueries().find((q) => q.text.includes('UPDATE accounts'));
  const sql = update.text.replace(/\s+/g, ' ');
  assert.match(sql, /SET eth_wallet_id = \$1/);
  // Only genuinely detached rows are adoptable -- never one a live wallet owns.
  assert.match(sql, /AND eth_wallet_id IS NULL/);
  assert.match(sql, /WHERE user_id = \$3 AND name = \$4/);
  // A re-add with no label must not blank out a display_name the user set.
  assert.match(sql, /display_name = COALESCE\(\$2, display_name\)/);
  assert.deepEqual(update.params, [42, 'Cold storage', 1, ACCOUNT_NAME]);

  // The INSERT is skipped entirely: running it is what used to violate
  // accounts_user_id_name_key and surface as a bare 500.
  assert.equal(clientQueries().some((q) => q.text.includes('INSERT INTO accounts')), false);
});

test('addWallet still creates an account when there is nothing to re-attach', async () => {
  reset([
    { match: 'UPDATE accounts', rows: [] },
    { match: 'INSERT INTO accounts', rows: [{ id: 10, name: ACCOUNT_NAME }] },
  ]);

  const { account } = await EthWalletService.addWallet(1, ADDRESS, null);
  assert.equal(account.id, 10);

  const insert = clientQueries().find((q) => q.text.includes('INSERT INTO accounts'));
  assert.deepEqual(insert.params, [ACCOUNT_NAME, null, 42, 1]);
});

test('addWallet turns a live account name collision into a 409, not a 500', async () => {
  // Reachable only when two distinct addresses share the same 6-and-4
  // abbreviation, so the name is held by an account a live wallet owns and the
  // re-attach UPDATE cannot claim it. routes/eth.js maps this code to 409.
  reset([
    { match: 'UPDATE accounts', rows: [] },
    { match: 'INSERT INTO accounts', throws: Object.assign(new Error('duplicate key value'), { code: '23505' }) },
  ]);

  await assert.rejects(
    () => EthWalletService.addWallet(1, ADDRESS, null),
    (err) => err.code === 'ACCOUNT_NAME_CONFLICT' && /already exists/.test(err.message)
  );
});
