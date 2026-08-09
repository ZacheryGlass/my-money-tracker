'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const CdpClient = require('../src/services/evmAudit/CdpClient');
const CdpHistoryProvider = require('../src/services/evmAudit/CdpHistoryProvider');
const CdpRecoveryProvider = require('../src/services/evmAudit/CdpRecoveryProvider');

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const CONTRACT = '0x3333333333333333333333333333333333333333';
const HASH = `0x${'ab'.repeat(32)}`;
const OTHER_HASH = `0x${'cd'.repeat(32)}`;
const BLOCK_HASH = `0x${'ef'.repeat(32)}`;

function rpcResponse(body, method, params) {
  const rawText = JSON.stringify({ jsonrpc: '2.0', id: 1, result: body });
  return {
    body,
    rawText,
    responseSha256: 'response-hash',
    requestId: `${method}-request`,
    method,
    params,
  };
}

test('CDP Core RPC keeps array parameters and sanitized request evidence', async (t) => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'core-1' },
    });
  };
  t.after(() => { global.fetch = originalFetch; });

  const response = await new CdpClient('key-never-persisted', { spacingMs: 0, maxAttempts: 1 })
    .rpcWithEvidence('eth_getTransactionByHash', [HASH], 'transaction-recovery');

  assert.equal(request.method, 'eth_getTransactionByHash');
  assert.deepEqual(request.params, [HASH]);
  assert.equal(response.body, '0x1');
  assert.equal(response.method, 'eth_getTransactionByHash');
  assert.deepEqual(response.params, [HASH]);
  assert.ok(!JSON.stringify(response).includes('key-never-persisted'));
});

test('CDP Core RPC preserves a valid null lookup result', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    jsonrpc: '2.0', id: 1, result: null,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  t.after(() => { global.fetch = originalFetch; });

  const response = await new CdpClient('key-never-persisted', { spacingMs: 0, maxAttempts: 1 })
    .rpcWithEvidence('eth_getTransactionReceipt', [HASH], 'transaction-recovery');
  assert.equal(response.body, null);
});

test('CDP Core recovery preserves failed zero-value and nested trace evidence', async () => {
  const transaction = {
    hash: HASH,
    from: WALLET,
    to: CONTRACT,
    value: '0x0',
    gas: '0x5208',
    gasPrice: '0x64',
    nonce: '0x0',
    input: '0x095ea7b3',
    blockNumber: '0x7b',
    blockHash: BLOCK_HASH,
    transactionIndex: '0x1',
  };
  const receipt = {
    transactionHash: HASH,
    blockNumber: '0x7b',
    blockHash: BLOCK_HASH,
    transactionIndex: '0x1',
    status: '0x0',
    gasUsed: '0x5208',
    effectiveGasPrice: '0x64',
    logs: [],
  };
  const block = {
    number: '0x7b',
    hash: BLOCK_HASH,
    timestamp: '0x65920080',
    transactions: [OTHER_HASH, transaction],
  };
  const trace = [{ txHash: OTHER_HASH, result: {
    from: OTHER, to: OTHER, value: '0x0',
  } }, { txHash: HASH, result: {
    from: WALLET,
    to: CONTRACT,
    value: '0x0',
    gas: '0x5208',
    gasUsed: '0x5208',
    input: '0x095ea7b3',
    calls: [{
      from: CONTRACT,
      to: OTHER,
      value: '0xde0b6b3a7640000',
      gas: '0x100',
      gasUsed: '0x100',
      input: '0x',
      calls: [],
    }],
  } }];
  const responses = new Map([
    ['eth_getTransactionByHash', rpcResponse(transaction, 'eth_getTransactionByHash', [HASH])],
    ['eth_getTransactionReceipt', rpcResponse(receipt, 'eth_getTransactionReceipt', [HASH])],
    ['eth_getBlockByNumber', rpcResponse(block, 'eth_getBlockByNumber', ['0x7b', true])],
    ['debug_traceBlockByNumber', rpcResponse(trace, 'debug_traceBlockByNumber', [
      '0x7b', { tracer: 'callTracer' },
    ])],
  ]);
  const calls = [];
  const retained = [];
  const client = {
    async rpcWithEvidence(method, params) {
      calls.push({ method, params });
      return responses.get(method);
    },
  };

  const traceCache = new Map();
  const recovered = await CdpRecoveryProvider.recoverTransaction(client, {
    hash: HASH,
    blockNumber: 123,
  }, {
    traceCache,
    onEvidence: async (response) => retained.push(response.method),
  });

  assert.deepEqual(calls.map((call) => call.method), [
    'eth_getTransactionByHash', 'eth_getTransactionReceipt',
    'eth_getBlockByNumber', 'debug_traceBlockByNumber',
  ]);
  assert.deepEqual(calls[2].params, ['0x7b', false]);
  assert.deepEqual(calls[3].params, ['0x7b', { tracer: 'callTracer' }]);
  assert.deepEqual(retained, calls.map((call) => call.method));
  assert.equal(recovered.item.status, 'failed');
  assert.equal(recovered.item.content.ethereum.value, '0x0');
  assert.equal(recovered.item.content.ethereum.tokenTransfers.length, 0);
  assert.equal(recovered.traces.length, 2);
  assert.deepEqual(recovered.traces[0].traceAddress, []);
  assert.deepEqual(recovered.traces[1].traceAddress, [0]);
  assert.equal(recovered.traces[1].value, '0xde0b6b3a7640000');
  assert.match(recovered.response.rawText, /coinbase-cdp-core/);

  const normalized = CdpHistoryProvider.normalizePage(WALLET, [recovered.item]);
  assert.equal(normalized.transactions.length, 1);
  assert.equal(normalized.feeds.normal[0].isError, '1');
  assert.equal(normalized.feeds.normal[0].value, '0');
  assert.equal(normalized.feeds.internal.length, 1);
  assert.equal(normalized.feeds.internal[0].value, '0');

  const cachedEvidence = [];
  await CdpRecoveryProvider.recoverTransaction(client, { hash: HASH }, {
    traceCache,
    onEvidence: async (response) => cachedEvidence.push(response.method),
  });
  assert.equal(
    calls.filter((call) => call.method === 'debug_traceBlockByNumber').length,
    1,
    'one block trace is reused for a second transaction recovery in the same block'
  );
  assert.deepEqual(cachedEvidence, [
    'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber',
  ]);
});

test('CDP Core recovery fails closed on conflicting canonical identity', async () => {
  const response = (body, method) => rpcResponse(body, method, []);
  const client = {
    async rpcWithEvidence(method) {
      if (method === 'eth_getTransactionByHash') return response({
        hash: HASH, from: WALLET, blockNumber: '0x7b', blockHash: BLOCK_HASH,
        transactionIndex: '0x0', value: '0x0', gas: '0x5208', gasPrice: '0x64',
      }, method);
      if (method === 'eth_getTransactionReceipt') return response({
        transactionHash: HASH, blockNumber: '0x7b', blockHash: `0x${'11'.repeat(32)}`,
        transactionIndex: '0x0', status: '0x1', gasUsed: '0x1',
        effectiveGasPrice: '0x1', logs: [],
      }, method);
      if (method === 'eth_getBlockByNumber') return response({
        number: '0x7b', hash: BLOCK_HASH, timestamp: '0x65920080', transactions: [HASH],
      }, method);
      throw new Error(`unexpected method ${method}`);
    },
  };

  await assert.rejects(
    () => CdpRecoveryProvider.recoverTransaction(client, { hash: HASH }),
    (error) => error.code === 'CDP_RECOVERY_IDENTITY_MISMATCH'
  );
});

test('CDP Core recovery retains partial evidence and rejects a trace for another transaction', async () => {
  const transaction = {
    hash: HASH, from: WALLET, to: CONTRACT, blockNumber: '0x7b', blockHash: BLOCK_HASH,
    transactionIndex: '0x0', value: '0x0', gas: '0x5208', gasPrice: '0x64',
  };
  const receipt = {
    transactionHash: HASH, blockNumber: '0x7b', blockHash: BLOCK_HASH,
    transactionIndex: '0x0', status: '0x1', gasUsed: '0x1', effectiveGasPrice: '0x1', logs: [],
  };
  const block = {
    number: '0x7b', hash: BLOCK_HASH, timestamp: '0x65920080', transactions: [HASH],
  };
  const responses = new Map([
    ['eth_getTransactionByHash', rpcResponse(transaction, 'eth_getTransactionByHash', [HASH])],
    ['eth_getTransactionReceipt', rpcResponse(receipt, 'eth_getTransactionReceipt', [HASH])],
    ['eth_getBlockByNumber', rpcResponse(block, 'eth_getBlockByNumber', ['0x7b', false])],
    ['debug_traceBlockByNumber', rpcResponse([
      { txHash: OTHER_HASH, result: { from: OTHER, to: CONTRACT, value: '0x0' } },
    ], 'debug_traceBlockByNumber', ['0x7b', { tracer: 'callTracer' }])],
  ]);
  const retained = [];
  const client = {
    async rpcWithEvidence(method) {
      return responses.get(method);
    },
  };

  await assert.rejects(
    () => CdpRecoveryProvider.recoverTransaction(client, { hash: HASH }, {
      onEvidence: async (response) => retained.push(response.method),
    }),
    (error) => error.code === 'CDP_RECOVERY_TRACE_UNAVAILABLE'
  );
  assert.deepEqual(retained, [
    'eth_getTransactionByHash', 'eth_getTransactionReceipt',
    'eth_getBlockByNumber', 'debug_traceBlockByNumber',
  ]);
});

test('CDP recovery cursors accept only the versioned known-ledger shape', () => {
  const state = {
    version: 1, phase: 'known-ledger', afterKey: '001:hash',
    retryKeys: ['000:retry-hash'],
    addressHistoryCursor: 'opaque-page-token',
  };
  assert.deepEqual(CdpRecoveryProvider.recoveryCursor(JSON.stringify(state)), state);
  assert.deepEqual(
    CdpRecoveryProvider.recoveryCursor('opaque-address-history-token', state),
    state
  );
  assert.equal(CdpRecoveryProvider.recoveryCursor(JSON.stringify({ version: 2 }), null), null);
  assert.equal(
    CdpRecoveryProvider.recoveryCursor(JSON.stringify({
      version: 1, phase: 'known-ledger', retryKeys: { invalid: true },
    }), null),
    null
  );
  assert.equal(CdpRecoveryProvider.candidateKey({ blockNumber: 12, hash: HASH }), `00000000000000000012:${HASH}`);
});

test('CDP recovery reuses durable traces only for the validated block identity', async () => {
  const transaction = {
    hash: HASH, from: WALLET, to: CONTRACT, blockNumber: '0x7b', blockHash: BLOCK_HASH,
    transactionIndex: '0x0', value: '0x0', gas: '0x5208', gasPrice: '0x64',
  };
  const receipt = {
    transactionHash: HASH, blockNumber: '0x7b', blockHash: BLOCK_HASH,
    transactionIndex: '0x0', status: '0x1', gasUsed: '0x1', effectiveGasPrice: '0x1', logs: [],
  };
  const block = {
    number: '0x7b', hash: BLOCK_HASH, timestamp: '0x65920080', transactions: [HASH],
  };
  const durableTrace = [{ txHash: HASH, result: {
    from: WALLET, to: CONTRACT, value: '0x0', gas: '0x1', gasUsed: '0x1',
  } }];
  const responses = new Map([
    ['eth_getTransactionByHash', rpcResponse(transaction, 'eth_getTransactionByHash', [HASH])],
    ['eth_getTransactionReceipt', rpcResponse(receipt, 'eth_getTransactionReceipt', [HASH])],
    ['eth_getBlockByNumber', rpcResponse(block, 'eth_getBlockByNumber', ['0x7b', false])],
  ]);
  const calls = [];
  const client = {
    async rpcWithEvidence(method, params) {
      calls.push({ method, params });
      const response = responses.get(method);
      if (!response) throw new Error(`unexpected method ${method}`);
      return response;
    },
  };
  const durable = rpcResponse(durableTrace, 'debug_traceBlockByNumber', [
    '0x7b', { tracer: 'callTracer' },
  ]);
  const cache = new Map();
  await CdpRecoveryProvider.recoverTransaction(client, { hash: HASH }, {
    traceCache: cache,
    loadTrace: async () => durable,
  });
  assert.deepEqual(calls.map((call) => call.method), [
    'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber',
  ]);
  assert.notEqual(
    CdpRecoveryProvider.traceCacheKey('0x7b', BLOCK_HASH),
    CdpRecoveryProvider.traceCacheKey('0x7b', `0x${'11'.repeat(32)}`),
    'a same-height reorg cannot reuse another block hash trace'
  );
});
