'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      async query() { return { rows: [] }; }
      connect() { throw new Error('Unexpected connect'); }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const EthWalletService = require('../src/services/EthWalletService');

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

test('addWallet rejects malformed addresses', async () => {
  await assert.rejects(
    () => EthWalletService.addWallet('not-an-address'),
    (err) => err.code === 'INVALID_ADDRESS'
  );
  await assert.rejects(
    () => EthWalletService.addWallet('0x123'),
    (err) => err.code === 'INVALID_ADDRESS'
  );
});
