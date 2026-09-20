'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const RpcClient = require('../src/services/evmAudit/RpcClient');
const EtherscanService = require('../src/services/EtherscanService');
const { sha256 } = require('../src/services/evmAudit/normalizer');

test('sync and audit share JSON-RPC requests while audit retains exact response bytes', async (t) => {
  const raw = '{ "jsonrpc": "2.0", "id": 1, "result": "0x2a" }';
  const calls = [];
  t.mock.method(axios, 'post', async (url, body, options) => {
    calls.push({ url, body, options });
    return { status: 200, data: raw, headers: { 'x-request-id': 'fixture-request' } };
  });
  assert.equal(await EtherscanService._rpcRequest(100, 'eth_getBalance', ['0x1', 'latest']), '0x2a');
  const rpc = new RpcClient(100, { spacingMs: 0 });
  const result = await rpc.requestWithEvidence('eth_getBalance', ['0x1', 'latest']);
  assert.deepEqual(calls[0].body, calls[1].body);
  assert.equal(calls[0].url, calls[1].url);
  assert.equal(calls[0].options.timeout, 15000);
  assert.equal(calls[1].options.timeout, 30000);
  assert.ok(calls.every((call) => call.options.signal instanceof AbortSignal));
  assert.equal(result.result, '0x2a');
  assert.equal(result.rawText, raw);
  assert.equal(result.responseSha256, sha256(raw));
  assert.equal(result.requestId, 'fixture-request');
});

test('audit RPC retains failed responses and its queue recovers after an error', async (t) => {
  const attempts = [];
  const rpc = new RpcClient(10, { spacingMs: 0, onFailedAttempt: async (row) => attempts.push(row) });
  let status = 429;
  let raw = '{"error":{"code":-32005,"message":"fixture quota"}}';
  t.mock.method(axios, 'post', async (_url, _body, options) => {
    assert.equal(options.validateStatus(status), true);
    return { status, data: raw, headers: {} };
  });
  await assert.rejects(rpc.request('eth_getLogs', []), { code: 'RPC_RATE_LIMITED', rpcCode: -32005 });
  assert.equal(attempts[0].responseRaw, raw);
  assert.equal(attempts[0].outcome, 'deferred');
  status = 200;
  raw = 'invalid json';
  await assert.rejects(rpc.request('eth_getLogs', []), { code: 'RPC_API_ERROR' });
  raw = '{"result":[]}';
  assert.deepEqual(await rpc.request('eth_getLogs', []), []);
});

test('audit RPC reports network failure separately from provider responses', async (t) => {
  const attempts = [];
  t.mock.method(axios, 'post', async () => {
    throw Object.assign(new Error('fixture deadline'), { code: 'ECONNABORTED' });
  });
  const rpc = new RpcClient(10, { spacingMs: 0, onFailedAttempt: async (row) => attempts.push(row) });
  await assert.rejects(rpc.request('eth_getLogs', []), { code: 'RPC_TRANSPORT_ERROR' });
  assert.equal(attempts[0].errorCode, 'RPC_TRANSPORT_ERROR');
});

function providerApiError(rpcMessage) {
  return Object.assign(new Error('fixture provider rejected the request'), {
    code: 'RPC_API_ERROR',
    rpcCode: -32000,
    rpcMessage,
  });
}

test('token-log enumeration adaptively splits explicit free-provider range caps', async () => {
  const messages = [
    'ranges over 10000 blocks are not supported on free plan',
    'eth_getLogs is limited to a 10,000 range',
    'range 49999 exceeds limit of 10000',
  ];

  for (const message of messages) {
    const rpc = new RpcClient(10, { spacingMs: 0 });
    const widths = [];
    rpc.requestWithEvidence = async (_method, [filter]) => {
      const fromBlock = Number(BigInt(filter.fromBlock));
      const throughBlock = Number(BigInt(filter.toBlock));
      const width = throughBlock - fromBlock + 1;
      widths.push(width);
      if (width > 1) throw providerApiError(message);
      return { result: [] };
    };

    const pages = [];
    for await (const page of rpc.addressIndexedTokenLogPages(
      '0x1111111111111111111111111111111111111111',
      { fromBlock: 0, throughBlock: 1, initialRange: 2, maxRequests: 20 }
    )) pages.push(page);

    assert.deepEqual(pages.map((page) => [page.fromBlock, page.throughBlock]), [
      [0, 0], [1, 1],
    ]);
    assert.equal(widths[0], 2);
    assert.ok(widths.slice(1).every((width) => width === 1));
  }
});

test('token-log enumeration reports free-provider capability restrictions as unsupported', async () => {
  const messages = [
    'Archive requests require a personal token.',
    'Please specify an address in your request or, to remove restrictions, order a dedicated full node here:',
  ];

  for (const message of messages) {
    const rpc = new RpcClient(10, { spacingMs: 0 });
    let calls = 0;
    const providerError = providerApiError(message);
    rpc.requestWithEvidence = async () => {
      calls += 1;
      throw providerError;
    };
    const iterator = rpc.addressIndexedTokenLogPages(
      '0x1111111111111111111111111111111111111111',
      { fromBlock: 0, throughBlock: 99, initialRange: 100, maxRequests: 4 }
    );

    await assert.rejects(iterator.next(), (error) => {
      assert.equal(error.code, 'RPC_LOG_ENUMERATION_UNSUPPORTED');
      assert.equal(error.cursor, '0');
      assert.equal(error.rpcCode, -32000);
      assert.equal(error.cause, providerError);
      assert.equal(error.cause.rpcMessage, message);
      return true;
    });
    assert.equal(calls, 1);
  }
});
