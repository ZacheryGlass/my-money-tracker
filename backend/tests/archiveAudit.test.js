'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  uniqueAddresses,
  indexLedgerRows,
  matchExchangeRecord,
} = require('../scripts/audit-exchange-archive');

test('archive audit extracts a unique lowercase address inventory', () => {
  const first = `0x${'A'.repeat(40)}`;
  const second = `0x${'b'.repeat(40)}`;
  assert.deepEqual(uniqueAddresses(`${first}\n${second}\n${first.toLowerCase()}`), [
    first.toLowerCase(),
    second,
  ]);
});

test('archive audit prefers provider ids and falls back to canonical fingerprints', () => {
  const ledgerRows = [{
    id: 9,
    exchange: 'coinbase',
    external_id: 'provider-1',
    record_type: 'deposit',
    occurred_at: '2026-01-02T03:04:05Z',
    base_asset: 'ETH',
    base_amount: '1.000',
  }];
  const indexes = indexLedgerRows(ledgerRows);
  assert.equal(matchExchangeRecord('coinbase', { external_id: 'provider-1' }, indexes).method, 'external_id');

  const result = matchExchangeRecord('coinbase', {
    external_id: 'csv-derived-id',
    record_type: 'deposit',
    occurred_at: '2026-01-02T03:04:05Z',
    base_asset: 'ETH2',
    base_amount: '1',
  }, indexes);
  assert.equal(result.method, 'fingerprint');
  assert.deepEqual(result.rows.map((row) => row.id), [9]);
});

test('archive audit leaves an absent source record unexplained', () => {
  const result = matchExchangeRecord('kraken', {
    external_id: 'missing',
    record_type: 'withdrawal',
    occurred_at: '2026-01-02T03:04:05Z',
    base_asset: 'BTC',
    base_amount: '-1',
  }, indexLedgerRows([]));
  assert.equal(result.method, null);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.disagreements, []);
});

test('archive audit reports a same-day fingerprint candidate with conflicting time', () => {
  const indexes = indexLedgerRows([{
    id: 4,
    exchange: 'kraken',
    external_id: 'ledger-id',
    record_type: 'deposit',
    occurred_at: '2026-01-02T03:04:05Z',
    base_asset: 'ETH',
    base_amount: '1',
  }]);
  const result = matchExchangeRecord('kraken', {
    external_id: 'archive-id',
    record_type: 'deposit',
    occurred_at: '2026-01-02T19:00:00Z',
    base_asset: 'ETH',
    base_amount: '1',
  }, indexes);
  assert.equal(result.method, null);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.disagreements, [{ ledger_record_id: 4, fields: ['occurred_at'] }]);
});
