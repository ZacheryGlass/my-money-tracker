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

const EthWalletService = require('../src/services/EthWalletService');

// These SQL statements carry long explanatory comments that quote the very
// predicates the assertions below look for ("no OR l.user_id IS NULL fallback",
// "no kind predicate here"). Strip comments before collapsing whitespace, or a
// doesNotMatch assertion fails on the prose rather than the code.
const sqlOf = (query) => query.text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

const WALLET = '0xAbCd000000000000000000000000000000000001';
const OTHER = '0x1111111111111111111111111111111111111111';

function normalTx(overrides = {}) {
  return {
    hash: '0xhash1',
    blockNumber: '100',
    timeStamp: '1700000000',
    from: WALLET,
    to: OTHER,
    value: '1000000000000000000',
    gasUsed: '21000',
    gasPrice: '50000000000',
    isError: '0',
    ...overrides,
  };
}

test('synthesizes a gas row with gasUsed * gasPrice for sent txs', () => {
  const rows = EthWalletService.normalizeFeeds(WALLET, { normal: [normalTx()] });
  const gas = rows.filter((r) => r.transfer_type === 'gas');
  assert.equal(gas.length, 1);
  assert.equal(gas[0].value_wei, String(21000n * 50000000000n));
  assert.equal(gas[0].is_error, false);

  const native = rows.filter((r) => r.transfer_type === 'native');
  assert.equal(native.length, 1);
  assert.equal(native[0].value_wei, '1000000000000000000');
  assert.equal(native[0].from_address, WALLET.toLowerCase());
});

test('failed sent tx keeps its gas row and flags the value row', () => {
  const rows = EthWalletService.normalizeFeeds(WALLET, {
    normal: [normalTx({ isError: '1' })],
  });
  const gas = rows.filter((r) => r.transfer_type === 'gas');
  assert.equal(gas.length, 1);
  assert.equal(gas[0].is_error, false);

  const native = rows.filter((r) => r.transfer_type === 'native');
  assert.equal(native.length, 1);
  assert.equal(native[0].is_error, true);
});

test('no gas row for received txs', () => {
  const rows = EthWalletService.normalizeFeeds(WALLET, {
    normal: [normalTx({ from: OTHER, to: WALLET })],
  });
  assert.equal(rows.filter((r) => r.transfer_type === 'gas').length, 0);
  assert.equal(rows.filter((r) => r.transfer_type === 'native').length, 1);
});

test('zero-value contract calls produce only a gas row', () => {
  const rows = EthWalletService.normalizeFeeds(WALLET, {
    normal: [normalTx({ value: '0' })],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].transfer_type, 'gas');
});

test('assigns sequential ordinals within one tx hash per feed', () => {
  const internal = [
    { hash: '0xmulti', blockNumber: '200', timeStamp: '1700000100', from: OTHER, to: WALLET, value: '5', isError: '0' },
    { hash: '0xmulti', blockNumber: '200', timeStamp: '1700000100', from: OTHER, to: WALLET, value: '7', isError: '0' },
  ];
  const token = [
    { hash: '0xmulti', blockNumber: '200', timeStamp: '1700000100', from: OTHER, to: WALLET, value: '9', contractAddress: '0xTOKEN000000000000000000000000000000000001', tokenSymbol: 'TKN', tokenDecimal: '18' },
  ];
  const rows = EthWalletService.normalizeFeeds(WALLET, { internal, token });

  const internalRows = rows.filter((r) => r.transfer_type === 'internal');
  assert.deepEqual(internalRows.map((r) => r.ordinal), [0, 1]);

  // Token ordinals count independently of internal ordinals on the same hash.
  const tokenRows = rows.filter((r) => r.transfer_type === 'token');
  assert.deepEqual(tokenRows.map((r) => r.ordinal), [0]);
  assert.equal(tokenRows[0].token_contract, '0xtoken000000000000000000000000000000000001');
  assert.equal(tokenRows[0].token_decimals, 18);
});

test('contract creation (empty to) yields a gas row with a NULL counterparty', () => {
  // Etherscan reports to:"" for contract creations. A NULL to_address must
  // survive: the reclassify UPDATE writes a NOT NULL boolean, so an
  // unguarded NULL there would abort every future sync.
  const rows = EthWalletService.normalizeFeeds(WALLET, {
    normal: [normalTx({ to: '', value: '0', gasUsed: '500000' })],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].transfer_type, 'gas');
  assert.equal(rows[0].to_address, null);
});

test('reclassify SQL defaults a NULL counterparty to false', async () => {
  const EthTransfer = require('../src/models/EthTransfer');
  queries.length = 0;
  await EthTransfer.reclassifyCounterparties();
  assert.equal(queries.length, 2);
  const sql = sqlOf(queries[0]);
  // counterparty_is_own is NOT NULL and `NULL IN (...)` is NULL, so the
  // expression must be wrapped or one contract-creation row aborts the
  // statement -- and with it every sync, add, and remove.
  assert.match(sql, /COALESCE\(.*IN \(.*SELECT w2\.address FROM eth_wallets w2.*,\s*FALSE\s*\)/);
});

test("reclassify folds kind='own' labels into the own set", async () => {
  const EthTransfer = require('../src/models/EthTransfer');
  queries.length = 0;
  await EthTransfer.reclassifyCounterparties();
  const sql = sqlOf(queries[0]);
  // 'own' hooks into the FIRST statement, not the exchange pass -- that is what
  // gives it own-precedence for free and keeps counterparty_exchange NULL.
  assert.match(sql, /UNION .*SELECT l\.address FROM eth_address_labels l WHERE l\.user_id = w\.user_id AND l\.kind = 'own'/);
});

test("reclassify scopes kind='own' labels strictly to the owner", async () => {
  const EthTransfer = require('../src/models/EthTransfer');
  queries.length = 0;
  await EthTransfer.reclassifyCounterparties();
  const sql = sqlOf(queries[0]);
  // Unlike the builtin exchange labels, an 'own' label must never fall back to
  // user_id IS NULL: a global "this address is yours" row is nonsense and would
  // mark one user's address as self-owned on every other user's transfers.
  const ownClause = sql.slice(sql.indexOf('UNION'), sql.indexOf('), FALSE'));
  assert.doesNotMatch(ownClause, /IS NULL/);
});

test('reclassify scopes the own-wallet set to the transfer owner', async () => {
  const EthTransfer = require('../src/models/EthTransfer');
  queries.length = 0;
  await EthTransfer.reclassifyCounterparties();
  const sql = sqlOf(queries[0]);
  // Without this, user A's wallet address would classify as a self-transfer
  // counterparty on user B's transfers -- hiding B's real income/spending.
  assert.match(sql, /WHERE w2\.user_id = w\.user_id/);
});

test('reclassify restricts both statements to one owner when given a userId', async () => {
  const EthTransfer = require('../src/models/EthTransfer');
  queries.length = 0;
  await EthTransfer.reclassifyCounterparties(7);
  assert.equal(queries.length, 2);
  // A wallet or label edit by one user must not rewrite everyone else's rows.
  for (const query of queries) {
    assert.match(query.text.replace(/\s+/g, ' '), /WHERE t\.wallet_id = w\.id AND w\.user_id = \$1/);
    assert.deepEqual(query.params, [7]);
  }
});

test('reclassify sets exchange labels with owner scope and own-precedence', async () => {
  const EthTransfer = require('../src/models/EthTransfer');
  queries.length = 0;
  await EthTransfer.reclassifyCounterparties();
  const sql = sqlOf(queries[1]);
  assert.match(sql, /SET counterparty_exchange/);
  // Own must beat exchange: a tracked wallet that is also labeled stays a
  // self-transfer, encoded directly in the statement.
  assert.match(sql, /CASE WHEN t\.counterparty_is_own THEN NULL/);
  // Labels apply per owner; builtins (user_id NULL) apply to everyone, with
  // the user's own label shadowing the builtin.
  assert.match(sql, /l\.user_id = w\.user_id OR l\.user_id IS NULL/);
  assert.match(sql, /ORDER BY l\.user_id NULLS LAST LIMIT 1/);
});

test('reclassify tests label kind on the winning row, not in the WHERE', async () => {
  const EthTransfer = require('../src/models/EthTransfer');
  queries.length = 0;
  await EthTransfer.reclassifyCounterparties();
  const sql = sqlOf(queries[1]);
  // THE regression test for this feature. `kind` must be applied to whichever
  // row wins precedence, AFTER the ORDER BY resolves it.
  assert.match(sql, /SELECT CASE WHEN l\.kind = 'exchange' THEN l\.name ELSE NULL END/);
  // Moving the kind test into the WHERE looks equivalent and is not: it filters
  // a user's 'external' override out of the candidate set, so the builtin
  // 'exchange' row becomes the only match and wins -- silently inverting the
  // user's intent in exactly the case this column was added to express.
  const subquery = sql.slice(sql.indexOf('WHERE l.address'), sql.indexOf('ORDER BY l.user_id'));
  assert.doesNotMatch(subquery, /l\.kind/);
});

test('unreviewed counterparties treat any label kind as reviewed', async () => {
  const EthTransfer = require('../src/models/EthTransfer');
  queries.length = 0;
  await EthTransfer.unreviewedCounterparties(7, { limit: 25, offset: 0, minUsd: 1 });
  const sql = sqlOf(queries[0]);

  // "Reviewed" is the anti-join, with NO kind predicate. counterparty_exchange
  // IS NULL is not a substitute: after migration 032 it also matches
  // reviewed-external rows, so the queue would never drain.
  const antiJoin = sql.slice(sql.indexOf('NOT EXISTS'), sql.indexOf('grouped AS'));
  assert.match(antiJoin, /FROM eth_address_labels lab/);
  assert.doesNotMatch(antiJoin, /lab\.kind/);
  assert.match(antiJoin, /lab\.user_id = \$1 OR lab\.user_id IS NULL/);

  assert.deepEqual(queries[0].params, [7, 1, false, 25, 0]);
});

test('unreviewed counterparties exclude gas, failures, own, and ignored tokens', async () => {
  const EthTransfer = require('../src/models/EthTransfer');
  queries.length = 0;
  await EthTransfer.unreviewedCounterparties(7);
  const sql = sqlOf(queries[0]);
  // A gas row's counterparty is whatever contract was called, never a payee;
  // failed transfers moved no value and have no mirror row to reclassify.
  assert.match(sql, /t\.transfer_type <> 'gas'/);
  assert.match(sql, /t\.is_error = FALSE/);
  assert.match(sql, /t\.counterparty_is_own = FALSE/);
  // Ignored tokens are already-declared noise; reusing that signal keeps
  // airdrop spam out of the queue for free.
  assert.match(sql, /NOT IN \(SELECT contract_address FROM eth_ignored_tokens WHERE user_id = \$1\)/);
  // USD comes from the mirrored ledger row, which is the only place token
  // prices exist -- they are never persisted anywhere else.
  assert.match(sql, /LEFT JOIN transactions tx ON tx\.eth_transfer_id = t\.id/);
  // Outbound transfers are material: you cannot receive an airdrop you sent.
  // Outbound NFT legs are the exception (sent_count_valued, not sent_count) --
  // they get no mirror row, so their usd_volume is 0 forever and the OR arm,
  // which exists to rescue a value that merely failed to resolve, would pass
  // permanently and pin the badge above zero. See ethActivity.test.js.
  assert.match(sql, /usd_volume >= \$2::float8 OR g\.sent_count_valued > 0/);
  assert.match(sql, /FILTER \(WHERE outgoing AND transfer_type NOT IN \('nft', 'nft1155'\)\)/);
});

test('unreviewed counterparties sort material rows above dust', async () => {
  const EthTransfer = require('../src/models/EthTransfer');
  queries.length = 0;
  await EthTransfer.unreviewedCounterparties(7, { includeDust: true });
  const sql = sqlOf(queries[0]);
  // material DESC must lead. Materiality is "above the dollar floor OR the user
  // sent to it", so an outbound transfer of an unpriced token is material at
  // $0.00; ordering by dollars alone buries it under every one-cent airdrop and
  // a page limit then pushes it off entirely -- leaving the badge counting rows
  // the user cannot see, which is the failure the badge exists to prevent.
  assert.match(sql, /ORDER BY r\.material DESC, r\.usd_volume DESC/);
});

test('addWallet rejects malformed addresses', async () => {
  await assert.rejects(
    () => EthWalletService.addWallet(1, 'not-an-address'),
    (err) => err.code === 'INVALID_ADDRESS'
  );
  await assert.rejects(
    () => EthWalletService.addWallet(1, '0x123'),
    (err) => err.code === 'INVALID_ADDRESS'
  );
});
