'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { snapshotHoldings } = require('../src/services/ExchangeHoldingsService');

// Synthetic positions only; never copy a user's exchange snapshot here.
const account = { id: 91, user_id: 2, name: 'Test venue', exchange: 'coinbase', credentials_updated_at: null };
const snapshot = (balances, overrides = {}) => ({
  provider: 'coinbase', complete: true, credential_generation: null,
  observed_at: '2026-01-01T00:00:00Z', balances, ...overrides,
});

test('exchange holdings combine ETH staking aliases exactly, retaining wrapped assets and cash separately', () => {
  const rows = snapshotHoldings(account, snapshot({ ETH: '1.000000000000000001', ETH2: '2.25', WETH: '0.5', USD: '12.34', BTC: '0', EUR: '7' }));
  assert.equal(rows.find((r) => r.ticker === 'ETH').quantity, '3.250000000000000001');
  assert.equal(rows.find((r) => r.ticker === 'WETH').quantity, '0.5');
  assert.deepEqual(rows.find((r) => r.name === 'US Dollar'), {
    ticker: null, name: 'US Dollar', quantity: '12.34', manual_value: '12.34', category: 'Cash',
  });
  assert.equal(rows.find((r) => r.name === 'EUR').manual_value, null);
  assert.equal(rows.find((r) => r.name === 'EUR').ticker, null);
  assert.equal(rows.some((r) => r.ticker === 'BTC'), false);
});

test('incomplete, malformed, foreign-provider and revoked-generation snapshots fail closed', () => {
  for (const data of [
    snapshot({ ETH: '1' }, { complete: false }),
    snapshot({ ETH: '1' }, { provider: 'kraken' }),
    snapshot({ ETH: '1' }, { credential_generation: '2026-01-01T00:00:00Z' }),
    snapshot({ ETH: '1' }, { observed_at: null }),
    snapshot({ ETH: 'NaN' }), snapshot({ ETH: null }), snapshot([]),
  ]) assert.throws(() => snapshotHoldings(account, data));
  assert.throws(() => snapshotHoldings({ ...account, user_id: null }, snapshot({ ETH: '1' })));
});
