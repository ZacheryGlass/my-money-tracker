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

const { buildMirrorRow } = require('../src/services/EthTransactionMirrorService');
const { CATEGORY_DIRECTIONS, classify } = require('../src/services/TransactionClassificationService');

const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function transfer(overrides = {}) {
  return {
    transfer_type: 'native',
    from_address: WALLET,
    to_address: OTHER,
    value_wei: '2000000000000000000', // 2 ETH
    is_error: false,
    counterparty_is_own: false,
    token_contract: null,
    token_symbol: null,
    token_decimals: null,
    ...overrides,
  };
}

test('outgoing external ETH transfer mirrors as a positive (outflow) amount', () => {
  const row = buildMirrorRow(transfer(), WALLET, { ethPrice: 3000 });
  assert.equal(row.category, 'CRYPTO_EXTERNAL');
  assert.equal(row.amount, 6000);
  assert.match(row.name, /^ETH → 0xbbbb/);
});

test('incoming self-transfer mirrors as a negative (inflow) self-transfer', () => {
  const row = buildMirrorRow(
    transfer({ from_address: OTHER, to_address: WALLET, counterparty_is_own: true }),
    WALLET,
    { ethPrice: 3000 }
  );
  assert.equal(row.category, 'CRYPTO_SELF_TRANSFER');
  assert.equal(row.amount, -6000);
  assert.match(row.name, /^ETH ← 0xbbbb/);
});

test('gas rows mirror as fees; failed value rows are dropped', () => {
  const gas = buildMirrorRow(
    transfer({ transfer_type: 'gas', value_wei: '1000000000000000' }), // 0.001 ETH
    WALLET,
    { ethPrice: 3000 }
  );
  assert.equal(gas.category, 'CRYPTO_GAS_FEE');
  assert.equal(gas.amount, 3);

  const failed = buildMirrorRow(transfer({ is_error: true }), WALLET, { ethPrice: 3000 });
  assert.equal(failed, null);
});

test('ignored tokens are dropped; unpriced tokens mirror at $0', () => {
  const tokenTransfer = transfer({
    transfer_type: 'token',
    token_contract: '0xcccccccccccccccccccccccccccccccccccccccc',
    token_symbol: 'PEPE',
    token_decimals: 18,
    value_wei: '5000000000000000000',
  });

  const ignored = buildMirrorRow(tokenTransfer, WALLET, {
    ethPrice: 3000,
    ignoredContracts: new Set(['0xcccccccccccccccccccccccccccccccccccccccc']),
  });
  assert.equal(ignored, null);

  const unpriced = buildMirrorRow(tokenTransfer, WALLET, { ethPrice: 3000 });
  assert.equal(unpriced.category, 'CRYPTO_TOKEN');
  assert.equal(unpriced.amount, 0);
  assert.match(unpriced.name, /^PEPE → /);

  const priced = buildMirrorRow(tokenTransfer, WALLET, {
    ethPrice: 3000,
    tokenPrices: { '0xcccccccccccccccccccccccccccccccccccccccc': { usd: 2 } },
  });
  assert.equal(priced.amount, 10);
});

test('mirror categories map onto safe classification directions', () => {
  assert.equal(CATEGORY_DIRECTIONS.CRYPTO_SELF_TRANSFER, 'internal_transfer');
  assert.equal(CATEGORY_DIRECTIONS.CRYPTO_GAS_FEE, 'fee');
  assert.equal(CATEGORY_DIRECTIONS.CRYPTO_EXTERNAL, 'other');
  assert.equal(CATEGORY_DIRECTIONS.CRYPTO_TOKEN, 'other');

  // The amount-sign fallback must never see these rows as spending/income.
  const classified = classify({ category: 'CRYPTO_GAS_FEE', amount: 12.5 });
  assert.equal(classified.direction, 'fee');
  const self = classify({ category: 'CRYPTO_SELF_TRANSFER', amount: -400 });
  assert.equal(self.direction, 'internal_transfer');
  assert.equal(self.isInternalTransfer, true);
});
