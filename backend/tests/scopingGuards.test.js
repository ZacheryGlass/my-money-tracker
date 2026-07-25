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
const Holding = require('../src/models/Holding');

// The dev auth stub treats user 1 as the admin, so DEV_AUTH_USER_ID=2 is a
// second, non-admin user.
function asUser(id, username) {
  process.env.DEV_AUTH_USER_ID = String(id);
  process.env.DEV_AUTH_USERNAME = username;
}

beforeEach(() => {
  delete process.env.DEV_AUTH_USER_ID;
  delete process.env.DEV_AUTH_USERNAME;
});

// These jobs sync every user's data using each owner's own API credentials, so
// a non-admin triggering them spends other people's Etherscan/Plaid quota and
// rewrites their rows. Hiding the buttons in the Server tab is not a control.
const ADMIN_ONLY_TRIGGERS = ['plaid-sync', 'eth-sync', 'expense-sync', 'snapshot', 'benchmark-update'];

for (const job of ADMIN_ONLY_TRIGGERS) {
  test(`POST /api/jobs/trigger/${job} is 403 for a non-admin`, async () => {
    asUser(2, 'alice');
    const response = await request(app).post(`/api/jobs/trigger/${job}`);
    assert.equal(response.status, 403);
  });

  test(`POST /api/jobs/trigger/${job} is not blocked for the admin`, async () => {
    const response = await request(app).post(`/api/jobs/trigger/${job}`);
    assert.notEqual(response.status, 403);
  });
}

test('POST /api/jobs/trigger/price-update stays open to any authenticated user', async () => {
  // price_cache is shared global market data and the Dashboard refresh button
  // calls this for everyone, so it is deliberately not admin-gated.
  asUser(2, 'alice');
  const response = await request(app).post('/api/jobs/trigger/price-update');
  assert.notEqual(response.status, 403);
});

test('Holding reads refuse to run unscoped', async () => {
  await assert.rejects(() => Holding.findAll({}), /requires a userId/);
  await assert.rejects(() => Holding.findAll({ includeHidden: false }), /requires a userId/);
  await assert.rejects(() => Holding.findById(1), /requires a userId/);
});

test('Holding.findAllForJobs is the explicit cross-user entry point', async () => {
  const rows = await Holding.findAllForJobs();
  assert.deepEqual(rows, []);
});
