'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  dependencyTotal,
  provenanceSnapshot,
  recordsMatch,
} = require('../scripts/resolve-cross-account-duplicates');

function row(overrides = {}) {
  return {
    external_id: 'cbp:transfer:one',
    record_type: 'deposit',
    occurred_at: '2022-01-01T12:00:00.000Z',
    base_asset: 'USD',
    base_amount: '100.000000000000000000',
    quote_asset: null,
    quote_amount: null,
    fee_asset: null,
    fee_amount: null,
    tx_hash: null,
    address: null,
    network: null,
    chain_id: null,
    source: 'csv',
    raw: { _format: 'coinbase_pro', time: '2022-01-01T12:00:00.000Z' },
    ...overrides,
  };
}

test('cross-account equality accepts decimal formatting differences', () => {
  assert.equal(recordsMatch(
    row({ base_amount: '100.0' }),
    row({ base_amount: '100.000000000000000000' }),
  ), true);
});

test('cross-account equality rejects changed provider fields', () => {
  assert.equal(recordsMatch(row(), row({ occurred_at: '2022-01-01T12:00:01.000Z' })), false);
  assert.equal(recordsMatch(row(), row({ base_amount: '101' })), false);
  assert.equal(recordsMatch(row(), row({ raw: { _format: 'coinbase_retail' } })), false);
});

test('provenance records the original account alongside the raw source snapshot', () => {
  const snapshot = provenanceSnapshot(row(), { id: 1, name: 'Mixed Coinbase', exchange: 'coinbase' });
  assert.equal(snapshot.exchange_account.id, 1);
  assert.equal(snapshot.exchange_account.exchange, 'coinbase');
  assert.equal(snapshot.raw._format, 'coinbase_pro');
});

test('dependency totals fail closed when any linked evidence exists', () => {
  assert.equal(dependencyTotal({ matches: 0, verdicts: 0, events: 0, suggestions: 0, fiat_matches: 0, dedupe_events: 0 }), 0);
  assert.equal(dependencyTotal({ matches: 0, verdicts: 1, events: 0, suggestions: 0, fiat_matches: 0, dedupe_events: 0 }), 1);
});
