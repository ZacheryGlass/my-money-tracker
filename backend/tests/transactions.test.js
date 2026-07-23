'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

let queryHandler;
const fakePool = {
  query: (...args) => queryHandler(...args),
  connect: async () => ({
    query: (...args) => queryHandler(...args),
    release: () => {},
  }),
  on: () => {},
};

const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      query(...args) { return fakePool.query(...args); }
      connect() { return fakePool.connect(); }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const request = require('supertest');
const app = require('../src/server');

// Captures the ORDER BY of the data query; the count query has none.
function captureOrderBy(sink) {
  return async (sql) => {
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: '2' }] };
    sink.orderBy = sql.match(/ORDER BY (.*)/)[1].trim();
    return { rows: [] };
  };
}

beforeEach(() => {
  queryHandler = async () => {
    throw new Error('Unexpected query');
  };
});

test('GET /api/transactions defaults to newest first', async () => {
  const sink = {};
  queryHandler = captureOrderBy(sink);

  const response = await request(app).get('/api/transactions');

  assert.equal(response.status, 200);
  assert.equal(sink.orderBy, 't.date DESC NULLS LAST, t.id DESC');
});

test('GET /api/transactions sorts by a whitelisted column and direction', async () => {
  const sink = {};
  queryHandler = captureOrderBy(sink);

  const response = await request(app)
    .get('/api/transactions')
    .query({ sort: 'amount', direction: 'asc' });

  assert.equal(response.status, 200);
  assert.equal(sink.orderBy, 't.amount ASC NULLS LAST, t.id DESC');
});

test('GET /api/transactions rejects an unknown sort column', async () => {
  const response = await request(app)
    .get('/api/transactions')
    .query({ sort: 'amount; DROP TABLE transactions' });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /Invalid sort parameter/);
});

test('GET /api/transactions rejects an unknown sort direction', async () => {
  const response = await request(app)
    .get('/api/transactions')
    .query({ sort: 'date', direction: 'sideways' });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /Invalid direction parameter/);
});
