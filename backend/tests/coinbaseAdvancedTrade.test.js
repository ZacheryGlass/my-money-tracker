'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recordFromTransaction } = require('../src/services/exchangeSync/coinbase')._internals;
const { multiplyAmounts } = require('../src/services/exchangeImport/shared');
const retail = require('../src/services/exchangeImport/coinbaseRetail');

const transaction = (asset, amount, overrides = {}) => ({
  id: `synthetic-${asset}`, type: 'advanced_trade_fill', status: 'completed',
  created_at: '2024-01-01T00:00:00Z',
  amount: { currency: asset, amount },
  native_amount: { currency: 'USD', amount: '-1999.99' },
  advanced_trade_fill: {
    product_id: 'ETH-USDC', order_side: 'SELL', order_id: 'synthetic-order',
    fill_price: '2000.125', commission: '3.25',
  },
  ...overrides,
});
const parse = (tx) => recordFromTransaction(tx, { line: 1, fillsByOrder: new Map() });

test('Advanced Trade uses exact execution proceeds and charges the quote currency once', () => {
  const base = parse(transaction('ETH', '-0.123456789'));
  assert.equal(base.quote_asset, 'USDC');
  assert.equal(base.quote_amount, '246.929010098625');
  assert.equal(base.fee_asset, 'USDC');
  assert.equal(base.fee_amount, '3.25');
  assert.equal(base.needs_review, false);
  // Each call is independent, as when the counterpart arrives in a later sync.
  assert.equal(parse(transaction('USDC', '246.929010098625')), null);
});

test('Advanced Trade buy debits quote and retains distinct partial fills', () => {
  const fill = { product_id: 'ETH-USD', order_side: 'BUY', fill_price: '1234.5', commission: '1', order_id: 'same-order' };
  const first = parse(transaction('ETH', '2', { advanced_trade_fill: fill }));
  const second = parse(transaction('ETH', '3', { id: 'second-fill', advanced_trade_fill: fill }));
  assert.equal(first.quote_amount, '-2469');
  assert.equal(second.quote_amount, '-3703.5');
  assert.notEqual(first.external_id, second.external_id);
  assert.equal(parse(transaction('USD', '-2469', { advanced_trade_fill: fill })), null);
});

test('Advanced Trade never drops an inconsistent or incomplete account movement', () => {
  for (const tx of [
    transaction('USDC', '-246.9'),
    transaction('BTC', '1'),
    transaction('ETH', '-1', { advanced_trade_fill: {} }),
    transaction('USDC', '246.9', { status: 'pending' }),
  ]) {
    const row = parse(tx);
    assert.ok(row);
    assert.equal(row.needs_review, true);
    assert.equal(row.quote_amount, null);
    assert.equal(row.base_amount, tx.amount.amount);
  }
});

test('execution multiplication preserves large decimals and rejects sub-wei rounding', () => {
  assert.equal(multiplyAmounts('9007199254740993.1', '2'), '18014398509481986.2');
  assert.equal(multiplyAmounts('0.000000000000000001', '0.1'), null);
});

test('Advanced CSV execution notes agree exactly with API despite rounded USD valuation', () => {
  const row = retail.parse([
    ['ID', 'Timestamp', 'Transaction Type', 'Asset', 'Quantity Transacted', 'Price Currency', 'Subtotal', 'Fees and/or Spread', 'Notes'],
    ['synthetic-csv', '2024-01-01T00:00:00Z', 'Advanced Trade Sell', 'ETH', '-0.123456789', 'USD', '246.92', '3.25',
      'Sold 0.123456789 ETH for 243.679010098625 USDC on ETH-USDC at 2000.125 USDC/ETH'],
  ]).records[0];
  const api = parse(transaction('ETH', '-0.123456789'));
  for (const field of ['base_asset', 'base_amount', 'quote_asset', 'quote_amount', 'fee_asset', 'fee_amount']) {
    assert.equal(row[field], api[field], field);
  }
  assert.equal(row.needs_review, false);
});

test('Coinbase staking credits are already net of commission; fiat fee valuation stays in raw', () => {
  const row = retail.parse([
    ['ID', 'Timestamp', 'Transaction Type', 'Asset', 'Quantity Transacted', 'Price Currency', 'Subtotal', 'Fees and/or Spread'],
    ['synthetic-reward', '2024-01-01T00:00:00Z', 'Staking Income', 'ETH2', '0.01', 'USD', '20', '5'],
  ]).records[0];
  assert.equal(row.base_amount, '0.01');
  assert.equal(row.quote_amount, null);
  assert.equal(row.fee_amount, null);
  assert.equal(row.fee_asset, null);
  assert.equal(row.raw['Fees and/or Spread'], '5');
});
