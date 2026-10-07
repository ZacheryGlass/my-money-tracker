'use strict';

// Receipt acquisition is the only network step in a bridge rebuild. These
// pin when it may call a provider: never for settled (complete + finalized)
// evidence, never twice in quick succession for a failed fetch, never more
// than the per-run cap (oldest first), and never at all when the caller asks
// for a database-only rebuild.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const BridgeMatchingService = require('../src/services/BridgeMatchingService');
const EthBridgeReceipt = require('../src/models/EthBridgeReceipt');
const EtherscanService = require('../src/services/EtherscanService');
const SecretsService = require('../src/services/SecretsService');

const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const activity = (n, overrides = {}) => ({
  wallet_id: 1, chain_id: 1, tx_hash: hash(n), block_time: new Date(Date.UTC(2021, 0, 1) + n * 1000).toISOString(),
  counterparty_address: '0x99c9fc46f92e8a1c0dec1b1747d010903e884be1', ...overrides,
});
const storedReceipt = (n, overrides = {}) => ({
  id: n, wallet_id: 1, chain_id: 1, tx_hash: hash(n), fetch_status: 'complete',
  provider_boundary: { finality: { status: 'finalized' } }, transaction_json: {}, receipt_json: {},
  fetched_at: new Date(0).toISOString(), ...overrides,
});

function harness(t, stored) {
  const fetched = [];
  const saved = [];
  const restore = [];
  const stub = (obj, key, fn) => { restore.push([obj, key, obj[key]]); obj[key] = fn; };
  t.after(() => { for (const [obj, key, fn] of restore.reverse()) obj[key] = fn; });
  stub(EthBridgeReceipt, 'findForUser', async () => stored);
  stub(SecretsService, 'getUserKey', async () => 'key');
  stub(EtherscanService, 'getTransactionEvidence', async (txHash) => {
    fetched.push(txHash);
    return { provider: 'test', providerBoundary: { finality: { status: 'finalized' } }, transaction: {}, receipt: {} };
  });
  stub(EthBridgeReceipt, 'upsertComplete', async ({ txHash }) => {
    saved.push(txHash);
    return { receipt: storedReceipt(0, { tx_hash: txHash }) };
  });
  stub(EthBridgeReceipt, 'upsertFailure', async () => {});
  return { fetched, saved };
}

test('settled receipts are reused with no provider call', async (t) => {
  const { fetched } = harness(t, [storedReceipt(1), storedReceipt(2)]);
  const envelopes = await BridgeMatchingService._acquire(1, [activity(1), activity(2)], [], { acquireReceipts: true });
  assert.deepEqual(fetched, []);
  assert.equal(envelopes.length, 2);
});

test('pending, failed-long-ago and missing receipts are fetched', async (t) => {
  const { fetched } = harness(t, [
    storedReceipt(1, { provider_boundary: { finality: { status: 'pending' } } }),
    storedReceipt(2, { fetch_status: 'failed' }),
  ]);
  await BridgeMatchingService._acquire(1, [activity(1), activity(2), activity(3)], [], { acquireReceipts: true });
  assert.deepEqual(fetched, [hash(1), hash(2), hash(3)]);
});

test('a fetch that failed moments ago is not retried by the next run', async (t) => {
  const { fetched } = harness(t, [storedReceipt(1, { fetch_status: 'failed', fetched_at: new Date().toISOString() })]);
  await BridgeMatchingService._acquire(1, [activity(1)], [], { acquireReceipts: true });
  assert.deepEqual(fetched, []);
});

test('fetches stop at the per-run cap, oldest first, instead of failing the rebuild', async (t) => {
  const cap = BridgeMatchingService.MAX_RECEIPT_FETCHES_PER_RUN;
  const { fetched } = harness(t, []);
  // Newest first on input: acquisition must still take the oldest.
  const activities = Array.from({ length: cap + 5 }, (_, i) => activity(cap + 5 - i));
  await BridgeMatchingService._acquire(1, activities, [], { acquireReceipts: true });
  assert.equal(fetched.length, cap);
  assert.deepEqual(fetched.slice(0, 2), [hash(1), hash(2)]);
  assert.ok(!fetched.includes(hash(cap + 5)));
});

test('a database-only rebuild never calls a provider and uses complete receipts only', async (t) => {
  const { fetched } = harness(t, [storedReceipt(1), storedReceipt(2, { fetch_status: 'failed' })]);
  const envelopes = await BridgeMatchingService._acquire(1, [activity(1), activity(2), activity(3)], [], { acquireReceipts: false });
  assert.deepEqual(fetched, []);
  assert.deepEqual(envelopes.map((e) => e.tx_hash), [hash(1)]);
});

test('more than 250 bridge candidates no longer throw', async (t) => {
  const pool = require('../src/config/database');
  const rows = Array.from({ length: 300 }, (_, i) => activity(i));
  const original = pool.query;
  t.after(() => { pool.query = original; });
  pool.query = async () => ({ rows });
  const result = await BridgeMatchingService._activitiesForUser(1);
  assert.equal(result.length, 300);
});
