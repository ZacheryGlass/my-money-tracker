'use strict';

// A scrubbed provider error keeps its URL for debugging, but never a value
// derived from a credential: Binance.US signs the query itself and Etherscan
// takes its key as a query parameter.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { redactUrl } = require('../src/crypto/infra/http/redact');
const scrubHttpError = require('../src/utils/scrubHttpError');

test('signature, timestamp and api keys are redacted; other params and names survive', () => {
  assert.equal(
    redactUrl('https://api.binance.us/api/v3/myTrades?symbol=ETHUSD&recvWindow=5000&timestamp=1700000000000&signature=abc123'),
    'https://api.binance.us/api/v3/myTrades?symbol=ETHUSD&recvWindow=REDACTED&timestamp=REDACTED&signature=REDACTED'
  );
  assert.equal(
    redactUrl('https://api.etherscan.io/v2/api?chainid=1&module=account&apikey=SECRETKEY'),
    'https://api.etherscan.io/v2/api?chainid=1&module=account&apikey=REDACTED'
  );
  assert.equal(redactUrl('https://example.com/path'), 'https://example.com/path');
  assert.equal(redactUrl(null), null);
});

test('scrubHttpError keeps a redacted URL in request_summary', () => {
  const err = new Error('timeout');
  err.config = { method: 'get', url: 'https://api.binance.us/sapi/v1/x?timestamp=1&signature=deadbeef', headers: { 'X-MBX-APIKEY': 'k' } };
  scrubHttpError(err);
  assert.equal(err.config, undefined);
  assert.equal(err.request_summary.url, 'https://api.binance.us/sapi/v1/x?timestamp=REDACTED&signature=REDACTED');
  assert.doesNotMatch(JSON.stringify(err), /deadbeef/);
});
