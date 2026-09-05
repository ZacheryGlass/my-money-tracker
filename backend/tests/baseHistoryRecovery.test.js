'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CHAIN_ID,
  TABLE_SPECS,
  UNSUPPORTED_SOURCE_SURFACES,
  quoteIdent,
  mergeChains,
  sanitizeRecoveredJob,
  buildInsertStatement,
  encodeInsertParams,
  sourceSelectList,
} = require('../scripts/recover-base-history');

test('Base recovery is pinned to Base and restores raw evidence before transfers', () => {
  assert.equal(CHAIN_ID, 8453);
  const order = TABLE_SPECS.map((spec) => spec.table);
  assert.ok(order.indexOf('evm_audit_scopes') < order.indexOf('evm_provider_pages'));
  assert.ok(order.indexOf('evm_provider_observations') < order.indexOf('evm_job_observations'));
  assert.ok(order.indexOf('evm_provider_observations') < order.indexOf('evm_mined_transactions'));
  assert.ok(order.indexOf('evm_mined_transactions') < order.indexOf('evm_transaction_evidence'));
  assert.ok(order.indexOf('evm_canonical_effects') < order.indexOf('evm_effect_evidence'));
  assert.ok(order.indexOf('evm_provider_observations') < order.indexOf('eth_transfers'));
  assert.ok(order.indexOf('eth_wallet_chains') < order.indexOf('eth_transfers'));
  assert.ok(order.indexOf('eth_transfers') < order.indexOf('eth_activity'));
  assert.ok(order.indexOf('eth_activity') < order.indexOf('eth_activity_overrides'));
  assert.ok(order.indexOf('eth_transfers') < order.indexOf('eth_activity_overrides'));
  const source = require('node:fs').readFileSync(
    require.resolve('../scripts/recover-base-history'), 'utf8'
  );
  assert.doesNotMatch(source, /EthDerivedPipeline|refreshHoldings|matchBridgeTransfersForUser/);
});

test('unsupported user-state surfaces fail closed instead of being skipped', () => {
  const names = new Set(UNSUPPORTED_SOURCE_SURFACES.map(([table]) => table));
  for (const table of [
    'eth_bridge_verdicts', 'eth_bridge_suggestions', 'eth_discovery_candidates',
    'exchange_match_verdicts', 'exchange_records',
  ]) assert.ok(names.has(table), table);
});

test('chain arrays merge in stable order and discard malformed values', () => {
  assert.deepEqual(mergeChains([1, 10, '8453'], [8453, 42161, 'bad', 0]), [1, 10, 8453, 42161]);
});

test('stale active jobs become inert while historical terminal jobs stay unchanged', () => {
  const now = new Date('2026-09-05T12:00:00Z');
  const stale = sanitizeRecoveredJob({
    status: 'deferred',
    lease_owner: 'dead-worker',
    lease_expires_at: new Date('2026-08-21T00:00:00Z'),
    heartbeat_at: new Date('2026-08-21T00:00:00Z'),
    superseded_by_job_id: 7,
    cdp_credential_generation: new Date('2026-08-01T00:00:00Z'),
  }, now);
  assert.equal(stale.status, 'cancelled');
  assert.equal(stale.finished_at, now);
  assert.equal(stale.lease_owner, null);
  assert.equal(stale.lease_expires_at, null);
  assert.equal(stale.heartbeat_at, null);
  assert.equal(stale.superseded_by_job_id, null);
  assert.equal('cdp_credential_generation' in stale, false);

  const complete = sanitizeRecoveredJob({ status: 'complete', finished_at: now }, now);
  assert.equal(complete.status, 'complete');
  assert.equal(complete.finished_at, now);
});

test('insert builder quotes identifiers and produces positional parameters', () => {
  assert.equal(
    buildInsertStatement('rows', ['id', 'payload'], 2),
    'INSERT INTO "rows" ("id", "payload") VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING'
  );
  assert.throws(() => quoteIdent('rows; DROP TABLE rows'), /Unsafe SQL identifier/);
  assert.throws(() => buildInsertStatement('rows', ['id'], 0), /rowCount must be positive/);
});

test('JSON arrays are encoded as JSON rather than PostgreSQL arrays', () => {
  assert.deepEqual(
    encodeInsertParams(
      ['id', 'requested_chains', 'progress'],
      [{ id: 7, requested_chains: [1, 8453], progress: { page: 2 } }],
      new Set(['requested_chains', 'progress'])
    ),
    [7, '[1,8453]', '{"page":2}']
  );
  assert.deepEqual(
    encodeInsertParams(['payload'], [{ payload: 'null' }], new Set(['payload'])),
    ['null']
  );
  assert.equal(
    sourceSelectList(['id', 'payload'], new Set(['payload'])),
    '"id", "payload"::text AS "payload"'
  );
});
