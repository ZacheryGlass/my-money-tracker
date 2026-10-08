'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      async query() { return { rows: [] }; }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const request = require('supertest');
const app = require('../src/server');
const pool = require('../src/config/database');

let queries;
beforeEach(() => {
  queries = [];
  pool.query = async (sql, params) => {
    queries.push({ sql, params });
    return { rows: [{ total: '0' }] };
  };
});

test('GET /api/history/accounts?type=crypto narrows to that account type', async () => {
  const response = await request(app).get('/api/history/accounts?type=crypto&limit=10000&withCount=false');
  assert.equal(response.status, 200);
  const data = queries.find((q) => /FROM account_snapshots/.test(q.sql));
  assert.match(data.sql, /a\.user_id = \$1 AND a\.type = \$2/);
  assert.deepEqual(data.params.slice(1, 2), ['crypto']);
});

test('GET /api/history/accounts without a type reads every account type', async () => {
  const response = await request(app).get('/api/history/accounts?withCount=false');
  assert.equal(response.status, 200);
  assert.doesNotMatch(queries[0].sql, /a\.type/);
});

test('GET /api/history/accounts rejects a malformed type', async () => {
  const response = await request(app).get('/api/history/accounts?type=crypto%27%20OR%201%3D1');
  assert.equal(response.status, 400);
  assert.equal(queries.length, 0);
});
