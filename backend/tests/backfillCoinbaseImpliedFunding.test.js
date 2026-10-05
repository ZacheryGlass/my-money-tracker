'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  planFunding, classifyFunding, balanceEffect,
} = require('../scripts/backfill-coinbase-implied-funding');

// Synthetic stored rows, shaped as node-pg returns them: a Date for
// occurred_at and NUMERIC(38,18) text for the legs.
function storedTrade(overrides = {}) {
  return {
    id: 10,
    record_type: 'trade',
    occurred_at: new Date('2024-05-01T09:00:00Z'),
    base_asset: 'BTC',
    base_amount: '0.010000000000000000',
    quote_asset: 'USD',
    quote_amount: '-410.000000000000000000',
    fee_asset: null,
    fee_amount: null,
    external_id: 'cb:ffffffff-0000-0000-0000-0000000000a1',
    source: 'api',
    needs_review: false,
    duplicate_candidate: false,
    raw: { _format: 'coinbase', _source: 'api', type: 'buy', buy: { payment_method_name: 'Test Bank ****1234' } },
    ...overrides,
  };
}

test('backfill plans funding only for trades settled outside the wallet', () => {
  const { fundings, skipped } = planFunding('coinbase', [
    storedTrade(),
    storedTrade({
      id: 11,
      external_id: 'cb:ffffffff-0000-0000-0000-0000000000a2',
      raw: { _format: 'coinbase', type: 'buy', buy: { payment_method_name: 'USD Wallet' } },
    }),
    storedTrade({
      id: 12,
      external_id: 'cb:ffffffff-0000-0000-0000-0000000000a3',
      raw: { _format: 'coinbase', type: 'advanced_trade_fill' },
    }),
    storedTrade({
      id: 13,
      external_id: 'cb:legacy0000000000000000a4',
      source: 'csv',
      quote_amount: '-400.000000000000000000',
      fee_asset: 'USD',
      fee_amount: '10.000000000000000000',
      raw: {
        _format: 'coinbase_retail',
        'Transaction Type': 'Buy',
        Notes: 'Bought 0.01 BTC for 410 USD using bank account Test Bank ****1234',
      },
    }),
  ]);

  assert.deepEqual(fundings.map((record) => record.external_id), [
    'cb:ffffffff-0000-0000-0000-0000000000a1:funding',
    'cb:legacy0000000000000000a4:funding',
  ]);
  assert.deepEqual(skipped, { paid_from_wallet: 1, not_a_retail_buy_or_sell: 1 });
  assert.deepEqual(fundings.map((record) => record.source), ['api', 'csv']);
  assert.deepEqual(fundings.map((record) => record.base_amount), ['410', '410']);
  for (const record of fundings) {
    assert.equal(record.occurred_at, '2024-05-01T09:00:00.000Z');
    assert.ok(record.fingerprint, 'annotated like a reader record');
    assert.equal(record.duplicate_candidate, false);
  }
});

test('backfill preview classifies records the way bulkInsert would', () => {
  const { fundings } = planFunding('coinbase', [
    storedTrade(),
    storedTrade({ id: 20, external_id: 'cb:ffffffff-0000-0000-0000-0000000000b1' }),
    storedTrade({
      id: 21,
      external_id: 'cb:ffffffff-0000-0000-0000-0000000000b2',
      occurred_at: new Date('2024-05-02T09:00:00Z'),
    }),
    storedTrade({
      id: 22,
      external_id: 'cb:ffffffff-0000-0000-0000-0000000000b3',
      occurred_at: new Date('2024-05-03T09:00:00Z'),
    }),
  ]);
  const [already, audited, sameAsCsv, fresh] = fundings;
  const existing = [
    { id: 100, ...already, base_amount: '410.000000000000000000' },
    // The CSV observation of the same bank leg, at the same instant.
    { id: 101, ...sameAsCsv, external_id: 'cb:legacy-twin:funding', source: 'csv' },
  ];
  const decisions = classifyFunding(fundings, existing, new Set([audited.external_id]));

  assert.deepEqual(decisions.map(({ decision }) => decision), ['duplicate', 'replay', 'merge', 'insert']);
  assert.equal(decisions[2].existing_id, 101);
  assert.equal(fresh.base_amount, '410');
  // Only rows that land change the derived balance.
  assert.deepEqual(balanceEffect(decisions), { USD: '410' });
});
