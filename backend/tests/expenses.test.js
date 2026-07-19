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
  type: 'bill',
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
  is_auto_tracked: false,
  is_stale: false,
  ...overrides,
});

test('GET /api/expenses computes staleness and provenance', async () => {
  queryHandler = async (sql) => {
    assert.match(sql, /is_stale/);
    assert.match(sql, /charge_interval_days/);
    return {
      rows: [
        expenseRow(),
        expenseRow({ id: 8, name: 'Food', merchant_key: null, company: null }),
        expenseRow({ id: 12, name: 'YouTube Premium', type: 'subscription', merchant_key: null }),
      ],
    };
  };

  const response = await request(app).get('/api/expenses');

  assert.equal(response.status, 200);
  const byName = Object.fromEntries(response.body.expenses.map((e) => [e.name, e]));
  assert.equal(byName.Rent.provenance, 'merchant');
  assert.equal(byName.Food.provenance, 'budget');
  assert.equal(byName['YouTube Premium'].provenance, 'manual');
  assert.equal(byName.Rent.due_day, 1);
  assert.equal(byName.Rent.is_stale, false);
});

test('POST /api/expenses accepts subscriptions', async () => {
  queryHandler = async (sql, params) => {
    assert.match(sql, /INSERT INTO recurring_expenses/);
    assert.equal(params[0], 'subscription');
    assert.equal(params[1], 'Nebula');
    return { rows: [expenseRow({ id: 30, type: 'subscription', name: 'Nebula', merchant_key: null })] };
  };

  const response = await request(app)
    .post('/api/expenses')
    .send({ type: 'subscription', name: 'Nebula', cost: 5 });

  assert.equal(response.status, 201);
  assert.equal(response.body.expense.name, 'Nebula');
});

test('POST /api/expenses rejects bill creation', async () => {
  const response = await request(app)
    .post('/api/expenses')
    .send({ type: 'bill', name: 'New Bill', cost: 10 });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /subscription/);
});

test('POST /api/expenses rejects missing fields', async () => {
  const response = await request(app)
    .post('/api/expenses')
    .send({ type: 'subscription', name: 'No Cost' });

  assert.equal(response.status, 400);
});

test('PUT /api/expenses/:id updates editable fields only', async () => {
  queryHandler = async (sql, params) => {
    assert.match(sql, /UPDATE recurring_expenses/);
    assert.doesNotMatch(sql, /merchant_key|is_auto_tracked/);
    assert.equal(params[params.length - 1], 1);
    return { rows: [expenseRow({ name: 'Rent (Evernest)' })] };
  };

  const response = await request(app)
    .put('/api/expenses/1')
    .send({ type: 'bill', name: 'Rent (Evernest)', cost: 2160.99, is_fixed_rate: true });

  assert.equal(response.status, 200);
  assert.equal(response.body.expense.name, 'Rent (Evernest)');
});

test('GET /api/analytics/detected-subscriptions uses classifications', async () => {
  queryHandler = async (sql) => {
    assert.match(sql, /transaction_classifications/);
    assert.match(sql, /direction = 'spending'/);
    assert.match(sql, /'depository', 'credit'/);
    return {
      rows: [{
        merchant: 'Spotify', avg_amount: '18.66', occurrence_count: 6,
        last_charge: '2026-07-10', first_charge: '2026-01-10', category: 'ENTERTAINMENT',
      }],
    };
  };

  const response = await request(app).get('/api/analytics/detected-subscriptions');

  assert.equal(response.status, 200);
  assert.equal(response.body.data[0].merchant, 'Spotify');
});
