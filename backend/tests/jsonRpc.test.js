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
