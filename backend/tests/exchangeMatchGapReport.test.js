'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeUnmatched } = require('../scripts/report-exchange-match-gaps');

test('exchange match-gap summary separates venue, asset, source, chain, and evidence gaps', () => {
  const rows = [
    {
      exchange: 'coinbase', record_type: 'deposit', base_asset: 'eth', source: 'api',
      provider_type: 'send', network: 'Ethereum', chain_id: 1,
      occurred_at: '2017-01-02T00:00:00.000Z', tx_hash: '0xabc', address: '0xdef',
      needs_review: false, duplicate_candidate: false, has_suggestion: true,
    },
    {
      exchange: 'coinbase', record_type: 'withdrawal', base_asset: 'BTC', source: 'csv',
      provider_type: null, network: null, chain_id: null,
      occurred_at: 'not-a-date', tx_hash: null, address: null,
      needs_review: true, duplicate_candidate: true, has_suggestion: false,
    },
    {
      exchange: 'kraken', record_type: 'withdrawal', base_asset: 'ETH', source: null,
      provider_type: null, network: null, chain_id: null,
      occurred_at: '2020-06-01T00:00:00.000Z', tx_hash: null, address: '0x123',
      needs_review: false, duplicate_candidate: false, has_suggestion: false,
    },
  ];

  const summary = summarizeUnmatched(rows);

  assert.equal(summary.unmatched_deposit_withdrawal_records, 3);
  assert.deepEqual(summary.unmatched_by_exchange, { coinbase: 2, kraken: 1 });
  assert.deepEqual(summary.unmatched_by_asset, { ETH: 2, BTC: 1 });
  assert.deepEqual(summary.unmatched_by_exchange_and_asset, {
    coinbase: { ETH: 1, BTC: 1 }, kraken: { ETH: 1 },
  });
  assert.deepEqual(summary.unmatched_by_source, { api: 1, csv: 1, unknown: 1 });
  assert.deepEqual(summary.unmatched_by_chain, { 1: 1, unknown: 2 });
  assert.deepEqual(summary.unmatched_by_year, { 2017: 1, 2020: 1, unknown: 1 });
  assert.deepEqual(summary.evidence_availability, {
    with_tx_hash: 1,
    without_tx_hash: 2,
    with_address: 2,
    without_address: 1,
    with_proven_chain: 1,
    without_proven_chain: 2,
    needs_review: 1,
    duplicate_candidates: 1,
    with_suggestion: 1,
  });
});
