'use strict';

// Provider-call counting attributes every dispatched request to the measured
// scopes it runs inside, so a rebuild's log can say how many network calls it
// made (S1's database-only label refresh must report zero).

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const providerCalls = require('../src/crypto/infra/providerCalls');
const etherscan = require('../src/config/etherscan');

test('nested scopes count into every parent; unscoped calls count nowhere', async () => {
  providerCalls.record('outside');
  const outer = await providerCalls.measure(async () => {
    providerCalls.record('a');
    const inner = await providerCalls.measure(async () => {
      providerCalls.record('b');
      providerCalls.record('b');
    });
    assert.deepEqual(inner.calls, { total: 2, byKey: { b: 2 } });
    return 'done';
  });
  assert.equal(outer.result, 'done');
  assert.deepEqual(outer.calls, { total: 3, byKey: { a: 1, b: 2 } });
});

test('the shared provider queue records each dispatched request under its key', async () => {
  etherscan.resetRateLimits();
  const { calls } = await providerCalls.measure(async () => {
    await etherscan.throttled(async () => 1, { key: 'host-a', spacingMs: 0 });
    await etherscan.throttled(async () => 2, { key: 'host-a', spacingMs: 0 });
    await etherscan.throttled(async () => 3, { key: 'host-b', spacingMs: 0 });
  });
  assert.deepEqual(calls, { total: 3, byKey: { 'host-a': 2, 'host-b': 1 } });
});

test('the audit RPC client and the sync side share one queue per RPC origin', async () => {
  process.env.ETH_CHAINS = '1';
  const chains = require('../src/config/chains');
  const RpcClient = require('../src/services/evmAudit/RpcClient');
  const jsonRpc = require('../src/utils/jsonRpc');
  const original = jsonRpc.request;
  jsonRpc.request = async () => ({ rawText: '{"result":"0x1"}', responseJson: { jsonrpc: '2.0', id: 1, result: '0x1' }, httpStatus: 200 });
  try {
    const client = new RpcClient(1, { spacingMs: 0 });
    const { calls } = await providerCalls.measure(() => client.requestWithEvidence('eth_blockNumber', []));
    const origin = new URL(chains.getChain(1).consensusRpcUrl).origin;
    assert.deepEqual(calls.byKey, { [`rpc:${origin}`]: 1 });
  } finally {
    jsonRpc.request = original;
  }
});
