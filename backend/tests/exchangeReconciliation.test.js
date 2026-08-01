'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ExchangeReconciliationService = require('../src/services/ExchangeReconciliationService');

const account = {
  exchange: 'kraken',
  credentials_updated_at: '2026-07-31T12:00:00.000Z',
};

test('a complete equal snapshot is current and preserves exact decimal strings', () => {
  const result = ExchangeReconciliationService.buildReconciliation({
    account,
    derived: { BTC: '1.000000000000000001' },
    snapshot: {
      provider: 'kraken',
      credential_generation: account.credentials_updated_at,
      observed_at: '2026-07-31T12:30:00.000Z',
      complete: true,
      balances: { BTC: '1.000000000000000001' },
    },
    latestRecordAt: '2026-07-31T11:00:00.000Z',
    now: new Date('2026-07-31T13:00:00.000Z'),
  });

  assert.equal(result.status, 'current');
  assert.equal(result.report.mismatch_count, 0);
  assert.deepEqual(result.report.stale_reasons, []);
});

test('a CSV-import recomputation reports a mismatch from the stored provider snapshot', () => {
  const result = ExchangeReconciliationService.buildReconciliation({
    account,
    derived: { ETH: '2' },
    snapshot: {
      provider: 'kraken',
      credential_generation: account.credentials_updated_at,
      observed_at: '2026-07-31T12:30:00.000Z',
      complete: true,
      balances: { ETH: '1' },
    },
    latestRecordAt: '2026-07-31T11:00:00.000Z',
    now: new Date('2026-07-31T13:00:00.000Z'),
  });

  assert.equal(result.status, 'mismatch');
  assert.equal(result.report.mismatch_is_current, true);
  assert.deepEqual(result.report.mismatches.map((row) => row.asset), ['ETH']);
});

test('a snapshot older than the imported ledger is stale even when balances match', () => {
  const result = ExchangeReconciliationService.buildReconciliation({
    account,
    derived: { BTC: '1' },
    snapshot: {
      provider: 'kraken',
      credential_generation: account.credentials_updated_at,
      observed_at: '2026-07-31T12:00:00.000Z',
      complete: true,
      balances: { BTC: '1' },
    },
    latestRecordAt: '2026-07-31T12:01:00.000Z',
    now: new Date('2026-07-31T13:00:00.000Z'),
  });

  assert.equal(result.status, 'stale');
  assert.ok(result.report.stale_reasons.includes('snapshot_predates_ledger'));
  assert.equal(result.report.mismatch_count, 0);
});

test('an incomplete or missing snapshot is unknown and carries only last-known mismatches', () => {
  const result = ExchangeReconciliationService.buildReconciliation({
    account,
    derived: { ETH: '2' },
    snapshot: null,
    latestRecordAt: '2026-07-31T12:01:00.000Z',
    existingReport: {
      mismatch_count: 1,
      mismatches: [{ asset: 'ETH', derived: '1', live: '0' }],
    },
    now: new Date('2026-07-31T13:00:00.000Z'),
  });

  assert.equal(result.status, 'unknown');
  assert.equal(result.report.mismatch_count, 0);
  assert.equal(result.report.mismatch_is_current, false);
  assert.equal(result.report.last_known_mismatch_count, 1);
});

test('snapshot envelopes normalize balances to decimal strings and carry provider metadata', () => {
  const snapshot = ExchangeReconciliationService.snapshotEnvelope(
    account,
    { BTC: 1.25, ETH: '2.000000000000000001' },
    '2026-07-31T12:30:00.000Z'
  );

  assert.deepEqual(snapshot, {
    provider: 'kraken',
    credential_generation: '2026-07-31T12:00:00.000Z',
    observed_at: '2026-07-31T12:30:00.000Z',
    complete: true,
    balances: { BTC: '1.25', ETH: '2.000000000000000001' },
  });
});
