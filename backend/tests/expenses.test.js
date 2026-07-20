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

beforeEach(() => {
  queryHandler = async () => {
    throw new Error('Unexpected query');
  };
});

const expenseRow = (overrides = {}) => ({
  id: 1,
  name: 'Rent',
  cost: '2160.99',
  is_fixed_rate: true,
  pay_account: 'Ally Checking',
  company: 'Evernest',
  merchant_key: 'Evernest',
  account_id: 64,
  due_day: 1,
  last_charge_date: '2026-07-01',
  charge_interval_days: 31,
  is_auto_tracked: true,
  is_stale: false,
  ...overrides,
});

test('GET /api/expenses returns rows with computed staleness', async () => {
  queryHandler = async (sql) => {
    assert.match(sql, /is_stale/);
    assert.match(sql, /charge_interval_days/);
    return { rows: [expenseRow(), expenseRow({ id: 16, name: 'Spotify', merchant_key: 'Spotify' })] };
  };

  const response = await request(app).get('/api/expenses');

  assert.equal(response.status, 200);
  assert.equal(response.body.expenses.length, 2);
  assert.equal(response.body.expenses[0].name, 'Rent');
  assert.equal(response.body.expenses[0].is_stale, false);
});

test('GET /api/expenses/ignored lists ignored merchants', async () => {
  queryHandler = async (sql) => {
    assert.match(sql, /FROM ignored_merchants/);
    return { rows: [{ merchant_key: 'Claude.ai', name: 'Claude.ai', last_cost: '100.00', created_at: '2026-07-20' }] };
  };

  const response = await request(app).get('/api/expenses/ignored');

  assert.equal(response.status, 200);
  assert.equal(response.body.ignored[0].merchant_key, 'Claude.ai');
  assert.equal(response.body.ignored[0].last_cost, '100.00');
});

test('POST /api/expenses is no longer supported', async () => {
  const response = await request(app)
    .post('/api/expenses')
    .send({ name: 'Nebula', cost: 5 });

  assert.equal(response.status, 404);
});

test('DELETE /api/expenses/:id ignores the merchant with a snapshot', async () => {
  const queries = [];
  queryHandler = async (sql, params) => {
    queries.push({ sql, params });
    if (/SELECT \* FROM recurring_expenses WHERE id/.test(sql)) {
      return { rows: [expenseRow({ id: 16, name: 'Spotify', cost: '18.99', merchant_key: 'Spotify' })] };
    }
    if (/DELETE FROM recurring_expenses/.test(sql)) {
      return { rows: [{ id: 16 }] };
    }
    if (/INSERT INTO ignored_merchants/.test(sql)) {
      assert.deepEqual(params, ['Spotify', 'Spotify', '18.99']);
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  const response = await request(app).delete('/api/expenses/16');

  assert.equal(response.status, 200);
  assert.equal(response.body.ignoredMerchant, 'Spotify');
  assert.ok(queries.some((q) => /INSERT INTO ignored_merchants/.test(q.sql)));
});

test('DELETE /api/expenses/:id returns 404 for a missing expense', async () => {
  queryHandler = async (sql) => {
    if (/SELECT \* FROM recurring_expenses WHERE id/.test(sql)) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  };

  const response = await request(app).delete('/api/expenses/999');

  assert.equal(response.status, 404);
});

test('DELETE /api/expenses/ignored restores a merchant (query param) and re-runs sync', async () => {
  const queries = [];
  queryHandler = async (sql) => {
    queries.push(sql);
    if (/DELETE FROM ignored_merchants/.test(sql)) return { rows: [] };
    // The sync runs after restore; return empty sets so it completes cleanly.
    return { rows: [] };
  };

  const response = await request(app).delete('/api/expenses/ignored').query({ key: 'City/Water & Co' });

  assert.equal(response.status, 200);
  assert.equal(response.body.restored, 'City/Water & Co');
  assert.equal(response.body.recreated, false);
  assert.ok(queries.some((sql) => /DELETE FROM ignored_merchants/.test(sql)));
  // Proof the sync ran: it queries the transactions and recurring_expenses tables.
  assert.ok(queries.some((sql) => /FROM transactions/.test(sql)));
});

test('DELETE /api/expenses/ignored requires a key', async () => {
  const response = await request(app).delete('/api/expenses/ignored');
  assert.equal(response.status, 400);
});

test('DELETE /api/expenses/:id rejects a non-numeric id', async () => {
  const response = await request(app).delete('/api/expenses/not-a-number');
  assert.equal(response.status, 400);
});

test('PATCH /api/expenses/:id/tag saves a trimmed tag', async () => {
  queryHandler = async (sql, params) => {
    assert.match(sql, /UPDATE recurring_expenses SET tag/);
    assert.deepEqual(params, ['Sewer & Trash', 17]);
    return { rows: [expenseRow({ id: 17, name: 'S & T', tag: 'Sewer & Trash' })] };
  };

  const response = await request(app)
    .patch('/api/expenses/17/tag')
    .send({ tag: '  Sewer & Trash  ' });

  assert.equal(response.status, 200);
  assert.equal(response.body.expense.tag, 'Sewer & Trash');
});

test('PATCH /api/expenses/:id/tag clears the tag with null or blank', async () => {
  queryHandler = async (sql, params) => {
    assert.deepEqual(params, [null, 17]);
    return { rows: [expenseRow({ id: 17, name: 'S & T', tag: null })] };
  };

  const response = await request(app)
    .patch('/api/expenses/17/tag')
    .send({ tag: '   ' });

  assert.equal(response.status, 200);
  assert.equal(response.body.expense.tag, null);
});

test('PATCH /api/expenses/:id/tag rejects non-string tags', async () => {
  const response = await request(app)
    .patch('/api/expenses/17/tag')
    .send({ tag: 42 });

  assert.equal(response.status, 400);
});

test('GET /api/analytics/detected-subscriptions no longer exists', async () => {
  const response = await request(app).get('/api/analytics/detected-subscriptions');
  assert.equal(response.status, 404);
});
