'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ExchangeBackfillService = require('../src/services/ExchangeBackfillService');
const ExchangeSyncJob = require('../src/models/ExchangeSyncJob');

test('exchange backoff grows across consecutive rate-limit failures and honors Retry-After', () => {
  const first = ExchangeBackfillService.backoffDelay(1, 0);
  const second = ExchangeBackfillService.backoffDelay(2, 0);
  const third = ExchangeBackfillService.backoffDelay(3, 0);

  assert.ok(first >= 5000);
  assert.ok(second > first);
  assert.ok(third > second);
  assert.ok(ExchangeBackfillService.backoffDelay(1, 12345) >= 12345);
  assert.ok(ExchangeBackfillService.backoffDelay(99, 0) <= 15 * 60 * 1000);
});

test('job public snapshots omit credentials and expose cumulative progress', () => {
  const snapshot = ExchangeSyncJob.toPublic({
    id: 12,
    exchange_account_id: 7,
    status: 'running',
    requested_at: '2026-07-31T12:00:00.000Z',
    started_at: '2026-07-31T12:00:01.000Z',
    completed_at: null,
    next_run_at: '2026-07-31T12:00:02.000Z',
    batches: 2,
    fetched_rows: 120,
    imported_rows: 100,
    upgraded_rows: 3,
    duplicate_rows: 17,
    flagged_rows: 4,
    backfill_pending: true,
    backoff_attempts: 0,
    last_batch: { fetched: 50 },
    last_error_code: null,
    last_error: null,
    api_key_encrypted: 'must-never-escape',
  });

  assert.deepEqual(snapshot, {
    id: 12,
    account_id: 7,
    status: 'running',
    requested_at: '2026-07-31T12:00:00.000Z',
    started_at: '2026-07-31T12:00:01.000Z',
    completed_at: null,
    next_run_at: '2026-07-31T12:00:02.000Z',
    batches: 2,
    fetched: 120,
    imported: 100,
    upgraded: 3,
    duplicates: 17,
    flagged: 4,
    backfill_pending: true,
    backoff_attempts: 0,
    last_batch: { fetched: 50 },
    last_error: null,
  });
  assert.equal(JSON.stringify(snapshot).includes('must-never-escape'), false);
});
