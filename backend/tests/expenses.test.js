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
        expenseRow({ id: 12, name: 'YouTube Premium', merchant_key: null }),
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

test('POST /api/expenses creates an entry and lifts any merchant ignore', async () => {
  const queries = [];
  queryHandler = async (sql, params) => {
    queries.push(sql);
    if (/INSERT INTO recurring_expenses/.test(sql)) {
      assert.equal(params[0], 'Nebula');
      return { rows: [expenseRow({ id: 30, name: 'Nebula', merchant_key: null })] };
    }
    if (/DELETE FROM ignored_merchants/.test(sql)) {
      assert.deepEqual(params, ['Nebula']);
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  const response = await request(app)
    .post('/api/expenses')
    .send({ name: 'Nebula', cost: 5 });

  assert.equal(response.status, 201);
  assert.equal(response.body.expense.name, 'Nebula');
  assert.ok(queries.some((sql) => /DELETE FROM ignored_merchants/.test(sql)));
});

test('POST /api/expenses rejects missing fields', async () => {
  const response = await request(app)
    .post('/api/expenses')
    .send({ name: 'No Cost' });

  assert.equal(response.status, 400);
});

test('DELETE /api/expenses/:id ignores the merchant for linked expenses', async () => {
  const queries = [];
  queryHandler = async (sql, params) => {
    queries.push(sql);
    if (/SELECT \* FROM recurring_expenses WHERE id/.test(sql)) {
      return { rows: [expenseRow({ id: 16, name: 'Spotify', merchant_key: 'Spotify' })] };
    }
    if (/DELETE FROM recurring_expenses/.test(sql)) {
      return { rows: [{ id: 16 }] };
    }
    if (/INSERT INTO ignored_merchants/.test(sql)) {
      assert.deepEqual(params, ['Spotify']);
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  const response = await request(app).delete('/api/expenses/16');

  assert.equal(response.status, 200);
  assert.equal(response.body.ignoredMerchant, 'Spotify');
  assert.ok(queries.some((sql) => /INSERT INTO ignored_merchants/.test(sql)));
});

test('DELETE /api/expenses/:id skips the ignore list for unlinked expenses', async () => {
  const queries = [];
  queryHandler = async (sql) => {
    queries.push(sql);
    if (/SELECT \* FROM recurring_expenses WHERE id/.test(sql)) {
      return { rows: [expenseRow({ id: 12, name: 'YouTube Premium', merchant_key: null })] };
    }
    if (/DELETE FROM recurring_expenses/.test(sql)) {
      return { rows: [{ id: 12 }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  const response = await request(app).delete('/api/expenses/12');

  assert.equal(response.status, 200);
  assert.equal(response.body.ignoredMerchant, null);
  assert.ok(!queries.some((sql) => /ignored_merchants/.test(sql)));
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

test('PATCH /api/expenses/:id/tag returns 404 for missing expenses', async () => {
  queryHandler = async () => ({ rows: [] });

  const response = await request(app)
    .patch('/api/expenses/999/tag')
    .send({ tag: 'Anything' });

  assert.equal(response.status, 404);
});

test('PUT /api/expenses/:id no longer exists', async () => {
  const response = await request(app)
    .put('/api/expenses/1')
    .send({ name: 'Rent' });

  assert.equal(response.status, 404);
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
