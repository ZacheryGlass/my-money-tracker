'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

let queryHandler;
const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      query(...args) { return queryHandler(...args); }
      connect() { return Promise.resolve({ query: (...a) => queryHandler(...a), release: () => {} }); }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const request = require('supertest');
const app = require('../src/server');

// The route makes up to two queries: an ownership check against eth_wallets
// (only when wallet_id is supplied), then the feed itself. Dispatch on which
// table the SQL reads so a test can assert the feed's WHERE clause.
function captureFeed(sink, { walletRows = [{ id: 7, address: '0xabc', user_id: 1 }] } = {}) {
  return async (sql, params) => {
    if (/FROM eth_wallets WHERE id/.test(sql)) {
      sink.ownershipParams = params;
      return { rows: walletRows };
    }
    sink.sql = sql;
    sink.params = params;
    return { rows: [] };
  };
}

beforeEach(() => {
  queryHandler = async () => { throw new Error('Unexpected query'); };
});

test('GET /api/eth/transfers spans every wallet the user owns', async () => {
  const sink = {};
  queryHandler = captureFeed(sink);

  const response = await request(app).get('/api/eth/transfers');

  assert.equal(response.status, 200);
  assert.ok(sink.sql.includes('w.user_id = $1'), 'feed must be scoped to the caller');
  assert.ok(!sink.sql.includes('t.wallet_id ='), 'no wallet_id filter when none was requested');
  // Direction is per-row in a merged feed, so each row needs its own address.
  assert.ok(sink.sql.includes('w.address AS wallet_address'));
});

test('GET /api/eth/transfers hides ignored tokens but keeps ETH and gas rows', async () => {
  const sink = {};
  queryHandler = captureFeed(sink);

  const response = await request(app).get('/api/eth/transfers');

  assert.equal(response.status, 200);
  // The Ignore button lives on this feed, so an unfiltered feed re-serves the
  // row the user just ignored and the button reads as doing nothing.
  assert.match(
    sink.sql,
    /t\.token_contract NOT IN \(SELECT contract_address FROM eth_ignored_tokens WHERE user_id = \$1\)/
  );
  // ETH and gas rows carry no contract; NOT IN would drop them all on a NULL.
  assert.match(sink.sql, /t\.token_contract IS NULL\s+OR/);
});

test('GET /api/eth/transfers?wallet_id= narrows to that wallet', async () => {
  const sink = {};
  queryHandler = captureFeed(sink);

  const response = await request(app)
    .get('/api/eth/transfers')
    .query({ wallet_id: '7' });

  assert.equal(response.status, 200);
  assert.ok(sink.sql.includes('w.user_id = $1'), 'narrowing must not replace user scoping');
  assert.ok(sink.sql.includes('t.wallet_id = $2'));
  assert.deepEqual(sink.ownershipParams, [7, 1]);
});

test("GET /api/eth/transfers?wallet_id= 404s on another user's wallet", async () => {
  const sink = {};
  // Ownership check finds nothing: the id exists but belongs to someone else.
  queryHandler = captureFeed(sink, { walletRows: [] });

  const response = await request(app)
    .get('/api/eth/transfers')
    .query({ wallet_id: '999' });

  assert.equal(response.status, 404);
  // Must never fall through to the unfiltered feed.
  assert.equal(sink.sql, undefined);
});

test('GET /api/eth/transfers?wallet_id= rejects an unparseable id instead of widening', async () => {
  const sink = {};
  queryHandler = captureFeed(sink);

  const response = await request(app)
    .get('/api/eth/transfers')
    .query({ wallet_id: 'not-a-number' });

  assert.equal(response.status, 404);
  assert.equal(sink.sql, undefined);
});

test('GET /api/eth/transfers applies the requested type facet', async () => {
  const sink = {};
  queryHandler = captureFeed(sink);

  const response = await request(app)
    .get('/api/eth/transfers')
    .query({ type: 'exchange' });

  assert.equal(response.status, 200);
  assert.ok(sink.sql.includes('t.counterparty_exchange IS NOT NULL'));
});

test('GET /api/eth/transfers ignores an unknown type rather than returning nothing', async () => {
  const sink = {};
  queryHandler = captureFeed(sink);

  const response = await request(app)
    .get('/api/eth/transfers')
    .query({ type: 'bogus' });

  assert.equal(response.status, 200);
  assert.ok(!sink.sql.includes('counterparty_exchange IS NOT NULL'));
  assert.ok(!sink.sql.includes('transfer_type ='));
});
