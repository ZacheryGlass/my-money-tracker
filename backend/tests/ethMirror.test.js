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
const TOKEN = '0xcccccccccccccccccccccccccccccccccccccccc';

// usd_at_time / usd_basis are what the valuation pass (043) wrote onto the leg
// from the dated series. The mirror READS them and prices nothing itself, which
// is why these fixtures carry dollars rather than a price to multiply by:
// 2 ETH valued at $3,000 on the transfer's own date.
function transfer(overrides = {}) {
  return {
    transfer_type: 'native',
    from_address: WALLET,
    to_address: OTHER,
    value_wei: '2000000000000000000', // 2 ETH
    is_error: false,
    counterparty_is_own: false,
    counterparty_exchange: null,
    token_contract: null,
    token_symbol: null,
    token_decimals: null,
    usd_at_time: '6000.00',
    usd_basis: 'exact',
    ...overrides,
  };
}

test('outgoing external ETH transfer mirrors as a positive (outflow) amount', () => {
  const row = buildMirrorRow(transfer(), WALLET);
  assert.equal(row.category, 'CRYPTO_EXTERNAL');
  assert.equal(row.amount, 6000);
  assert.match(row.name, /^ETH → 0xbbbb/);
});

test('incoming self-transfer mirrors as a negative (inflow) self-transfer', () => {
  const row = buildMirrorRow(
    transfer({ from_address: OTHER, to_address: WALLET, counterparty_is_own: true }),
    WALLET
  );
  assert.equal(row.category, 'CRYPTO_SELF_TRANSFER');
  assert.equal(row.amount, -6000);
  assert.match(row.name, /^ETH ← 0xbbbb/);
});

// The #73 acceptance criterion, at the mirror's own boundary: the SAME leg,
// valued once at its 2017 price and once at today's, produces two different
// ledger amounts -- and the mirror has no way to reach a current price, so the
// only number it can ever write is the one the dated series gave it.
test('an old transfer mirrors at its own date-of-transfer dollars', () => {
  const legIn2017 = transfer({
    block_time: new Date('2017-06-12T14:00:00Z'),
    usd_at_time: '300.00', // 2 ETH at the ~$150 ETH actually traded at
    usd_basis: 'exact',
  });
  assert.equal(buildMirrorRow(legIn2017, WALLET).amount, 300);

  // Same quantity, valued at a modern close. The mirror follows the valuation;
  // it does not choose one.
  const legToday = transfer({ usd_at_time: '3746.44', usd_basis: 'exact' });
  assert.equal(buildMirrorRow(legToday, WALLET).amount, 3746.44);
});

// A close carried forward across a one-day gap in a 24/7 series is a repair,
// not a repricing, and it must reach the ledger exactly like an exact one.
test('a carried valuation mirrors as a real amount, not as unpriced', () => {
  const row = buildMirrorRow(transfer({ usd_at_time: '5900.00', usd_basis: 'carried' }), WALLET);
  assert.equal(row.amount, 5900);
});

test('gas rows mirror as fees; failed value rows are dropped', () => {
  const gas = buildMirrorRow(
    transfer({ transfer_type: 'gas', value_wei: '1000000000000000', usd_at_time: '3.00' }),
    WALLET
  );
  assert.equal(gas.category, 'CRYPTO_GAS_FEE');
  assert.equal(gas.amount, 3);

  // A fee is a cost whichever way the value went: an INBOUND transaction's gas
  // is still positive (money leaving the account).
  const inboundGas = buildMirrorRow(
    transfer({
      transfer_type: 'gas', from_address: OTHER, to_address: WALLET,
      value_wei: '1000000000000000', usd_at_time: '3.00',
    }),
    WALLET
  );
  assert.equal(inboundGas.amount, 3);

  const failed = buildMirrorRow(transfer({ is_error: true }), WALLET);
  assert.equal(failed, null);
});

test('ignored tokens are dropped; an unpriced token is NOT mirrored at $0', () => {
  const tokenTransfer = transfer({
    transfer_type: 'token',
    token_contract: TOKEN,
    token_symbol: 'PEPE',
    token_decimals: 18,
    value_wei: '5000000000000000000',
    usd_at_time: null,
    usd_basis: 'unpriced',
  });

  const ignored = buildMirrorRow(tokenTransfer, WALLET, {
    ignoredContracts: new Set([TOKEN]),
  });
  assert.equal(ignored, null);

  // NO ROW AT ALL. transactions.amount is NOT NULL and carries no basis, so a
  // mirrored row is an assertion about dollars -- and $0.00 is an assertion
  // Spending sums as a real zero, quietly deleting a 500-USDC transfer the
  // provider could not price. The activity is still explained by
  // eth_activity.usd_basis, the transfers feed and the unpriced enumeration.
  assert.equal(buildMirrorRow(tokenTransfer, WALLET), null);

  // Same rule for a fee: an unpriced gas leg is an unknown cost, not a free
  // transaction.
  assert.equal(
    buildMirrorRow(
      transfer({ transfer_type: 'gas', value_wei: '1000000000000000', usd_at_time: null, usd_basis: 'unpriced' }),
      WALLET
    ),
    null
  );

  const priced = buildMirrorRow(
    { ...tokenTransfer, usd_at_time: '10.00', usd_basis: 'exact' },
    WALLET
  );
  assert.equal(priced.amount, 10);
});

test('outgoing ETH to a labeled exchange mirrors as a deposit named after it', () => {
  const row = buildMirrorRow(transfer({ counterparty_exchange: 'Coinbase' }), WALLET);
  assert.equal(row.category, 'CRYPTO_EXCHANGE_DEPOSIT');
  assert.equal(row.amount, 6000);
  assert.equal(row.name, 'ETH → Coinbase');
});

test('incoming token from a labeled exchange mirrors as a withdrawal', () => {
  const row = buildMirrorRow(
    transfer({
      transfer_type: 'token',
      from_address: OTHER,
      to_address: WALLET,
      counterparty_exchange: 'Kraken',
      token_contract: TOKEN,
      token_symbol: 'USDC',
      token_decimals: 6,
      value_wei: '250000000', // 250 USDC
      usd_at_time: '250.00',
    }),
    WALLET
  );
  assert.equal(row.category, 'CRYPTO_EXCHANGE_WITHDRAWAL');
  assert.equal(row.amount, -250);
  assert.equal(row.name, 'USDC ← Kraken');
});

test('own counterparty beats an exchange label', () => {
  const row = buildMirrorRow(
    transfer({ counterparty_is_own: true, counterparty_exchange: 'Coinbase' }),
    WALLET
  );
  assert.equal(row.category, 'CRYPTO_SELF_TRANSFER');
  assert.match(row.name, /^ETH → 0xbbbb/);
});

test('mirror categories map onto safe classification directions', () => {
  assert.equal(CATEGORY_DIRECTIONS.CRYPTO_SELF_TRANSFER, 'internal_transfer');
  assert.equal(CATEGORY_DIRECTIONS.CRYPTO_GAS_FEE, 'fee');
  assert.equal(CATEGORY_DIRECTIONS.CRYPTO_EXTERNAL, 'other');
  assert.equal(CATEGORY_DIRECTIONS.CRYPTO_TOKEN, 'other');
  assert.equal(CATEGORY_DIRECTIONS.CRYPTO_EXCHANGE_DEPOSIT, 'internal_transfer');
  assert.equal(CATEGORY_DIRECTIONS.CRYPTO_EXCHANGE_WITHDRAWAL, 'internal_transfer');

  // The amount-sign fallback must never see these rows as spending/income.
  const classified = classify({ category: 'CRYPTO_GAS_FEE', amount: 12.5 });
  assert.equal(classified.direction, 'fee');
  const self = classify({ category: 'CRYPTO_SELF_TRANSFER', amount: -400 });
  assert.equal(self.direction, 'internal_transfer');
  assert.equal(self.isInternalTransfer, true);
  const deposit = classify({ category: 'CRYPTO_EXCHANGE_DEPOSIT', amount: 500 });
  assert.equal(deposit.direction, 'internal_transfer');
  assert.equal(deposit.isInternalTransfer, true);
});
