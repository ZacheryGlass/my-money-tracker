'use strict';

// The derived digest is the refactor's equality gate (G1): it must ignore what
// a rebuild churns (surrogate ids, bookkeeping timestamps, a finality boundary
// that moved forward) and catch every change in what a row says.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hashRows, diffDigests, canonicalize } = require('../scripts/lib/derivedDigest');

const activity = (overrides = {}) => ({
  wallet: '0xaaa',
  row: {
    id: 41,
    wallet_id: 7,
    chain_id: 1,
    tx_hash: '0xabc',
    category: 'send',
    classified_at: '2026-10-01T00:00:00Z',
    legs: [{ asset: 'ETH', amount: '-1' }],
    protocol_interpretation: null,
    ...overrides,
  },
});

const member = (overrides = {}) => ({
  movement: 'op-stack:v1:0x01',
  row: {
    id: 9,
    movement_id: 3,
    receipt_id: 12,
    role: 'initiation',
    evidence: {
      receipt_id: 12,
      block_hash: '0xbeef',
      finality: { status: 'finalized', method: 'eth_getBlockByNumber', finalized_block_number: 100, checked_at: 'x' },
    },
    created_at: '2026-10-01T00:00:00Z',
    ...overrides,
  },
});

test('id churn and refreshed timestamps hash identically', () => {
  const before = hashRows([activity(), activity({ tx_hash: '0xdef', id: 42 })]);
  const after = hashRows([
    activity({ tx_hash: '0xdef', id: 900 }),
    activity({ id: 901, wallet_id: 7, classified_at: '2026-10-07T00:00:00Z' }),
  ]);
  assert.equal(before.sha256, after.sha256);
  assert.equal(before.rows, 2);
});

test('a finality refresh hashes identically, a finality verdict change does not', () => {
  const refreshed = member({
    id: 77,
    receipt_id: 13,
    evidence: {
      receipt_id: 13,
      block_hash: '0xbeef',
      finality: { status: 'finalized', method: 'eth_getBlockByNumber', finalized_block_number: 250, checked_at: 'y' },
    },
  });
  assert.equal(hashRows([member()]).sha256, hashRows([refreshed]).sha256);

  const pending = member({
    evidence: { block_hash: '0xbeef', finality: { status: 'pending', method: 'eth_getBlockByNumber' } },
  });
  assert.notEqual(hashRows([member()]).sha256, hashRows([pending]).sha256);
});

test('a category change changes the hash', () => {
  assert.notEqual(
    hashRows([activity()]).sha256,
    hashRows([activity({ category: 'exchange_deposit' })]).sha256
  );
});

test('numeric spelling and leg content are significant', () => {
  assert.notEqual(
    hashRows([activity()]).sha256,
    hashRows([activity({ legs: [{ asset: 'ETH', amount: '-1.5' }] })]).sha256
  );
});

test('canonicalize drops churn keys at every depth and sorts keys', () => {
  assert.deepEqual(
    canonicalize({ b: 1, id: 3, a: { wallet_id: 2, created_at: 'x', z: [{ activity_id: 1, k: 'v' }] } }),
    { a: { z: [{ k: 'v' }] }, b: 1 }
  );
});

test('diffDigests names only changed tables and the differing rows', () => {
  const a = hashRows([activity()]);
  const b = hashRows([activity({ category: 'receive' })]);
  const same = hashRows([member()]);
  const diff = diffDigests(
    { derived: { eth_activity: a, members: same }, inputs: {} },
    { derived: { eth_activity: b, members: same }, inputs: {} }
  );
  assert.deepEqual(Object.keys(diff.derived), ['eth_activity']);
  assert.equal(diff.derived.eth_activity.only_before.length, 1);
  assert.match(diff.derived.eth_activity.only_after[0], /"receive"/);
});
