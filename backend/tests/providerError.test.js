'use strict';

// Provider failures keep their legacy code and gain one provider-neutral kind.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { kindOf, withKind } = require('../src/crypto/infra/http/providerError');

const err = (code, extra = {}) => Object.assign(new Error(code), { code }, extra);

test('legacy codes map to provider-neutral kinds', () => {
  const cases = {
    EXPLORER_RATE_LIMITED: 'rate_limited', KRAKEN_RATE_LIMITED: 'rate_limited', MORALIS_QUOTA_EXHAUSTED: 'rate_limited',
    ETHERSCAN_NOT_CONFIGURED: 'not_configured', EXCHANGE_NOT_CONFIGURED: 'not_configured',
    COINBASE_AUTH_FAILED: 'auth', COINBASE_KEY_FORMAT: 'auth',
    ETHERSCAN_FEED_UNSUPPORTED: 'unsupported', RPC_UNSUPPORTED: 'unsupported',
    ETHERSCAN_CHAIN_UNAVAILABLE: 'chain_unavailable',
    BINANCE_US_HISTORY_INCOMPLETE: 'partial_index',
    EVM_INVALID_RAW_PAGE: 'malformed',
    ETHERSCAN_API_ERROR: 'transient', BLOCKSCOUT_TRANSPORT_ERROR: 'transient', ECONNRESET: 'transient',
  };
  for (const [code, kind] of Object.entries(cases)) assert.equal(kindOf(err(code)), kind, code);
  assert.equal(kindOf(err('EXCHANGE_SYNC_LOCK_LOST')), null, 'an unrelated code has no kind');
});

test('HTTP status answers when the code does not', () => {
  assert.equal(kindOf(err(undefined, { response: { status: 429 } })), 'rate_limited');
  assert.equal(kindOf(err(undefined, { request_summary: { status: 503 } })), 'transient');
  assert.equal(kindOf(err(undefined, { response: { status: 401 } })), 'auth');
});

test('withKind stamps the kind and keeps the code', () => {
  const error = withKind(err('KRAKEN_RATE_LIMITED'));
  assert.equal(error.kind, 'rate_limited');
  assert.equal(error.code, 'KRAKEN_RATE_LIMITED');
  assert.equal(withKind(Object.assign(err('ETHERSCAN_API_ERROR'), { kind: 'malformed' })).kind, 'malformed');
});
