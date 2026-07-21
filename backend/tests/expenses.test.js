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
  is_dropped: false,
  ...overrides,
});

test('GET /api/expenses returns rows with computed staleness and drop flags', async () => {
  queryHandler = async (sql) => {
    assert.match(sql, /1\.5 \* COALESCE\(charge_interval_days, 30\).*is_stale/s);
    assert.match(sql, /2\.0 \* COALESCE\(charge_interval_days, 30\).*is_dropped/s);
    return { rows: [expenseRow(), expenseRow({ id: 16, name: 'Spotify', merchant_key: 'Spotify' })] };
  };

  const response = await request(app).get('/api/expenses');

  assert.equal(response.status, 200);
  assert.equal(response.body.expenses.length, 2);
  assert.equal(response.body.expenses[0].name, 'Rent');
  assert.equal(response.body.expenses[0].is_stale, false);
  assert.equal(response.body.expenses[0].is_dropped, false);
});

test('GET /api/expenses/ignored lists the expenses scope by default', async () => {
  queryHandler = async (sql, params) => {
    assert.match(sql, /FROM ignored_merchants WHERE scope = \$1/);
    assert.deepEqual(params, ['expenses']);
    return { rows: [{ merchant_key: 'Claude.ai', name: 'Claude.ai', last_cost: '100.00', created_at: '2026-07-20' }] };
  };

  const response = await request(app).get('/api/expenses/ignored');

  assert.equal(response.status, 200);
  assert.equal(response.body.ignored[0].merchant_key, 'Claude.ai');
  assert.equal(response.body.ignored[0].last_cost, '100.00');
});

test('GET /api/expenses/ignored serves the merchants scope separately', async () => {
  queryHandler = async (sql, params) => {
    assert.deepEqual(params, ['merchants']);
    return { rows: [{ merchant_key: 'Costco', name: 'Costco', last_cost: null, created_at: '2026-07-20' }] };
  };

  const response = await request(app).get('/api/expenses/ignored').query({ scope: 'merchants' });

  assert.equal(response.status, 200);
  assert.equal(response.body.ignored[0].merchant_key, 'Costco');
});

test('GET /api/expenses/ignored rejects an unknown scope', async () => {
  const response = await request(app).get('/api/expenses/ignored').query({ scope: 'everything' });
  assert.equal(response.status, 400);
});

test('GET /api/expenses/:id/transactions returns the charges behind an expense', async () => {
  queryHandler = async (sql, params) => {
    if (/SELECT \* FROM recurring_expenses WHERE id/.test(sql)) {
      return { rows: [expenseRow({ id: 16, name: 'Spotify', merchant_key: 'Spotify' })] };
    }
    if (/FROM transactions/.test(sql)) {
      assert.match(sql, /COALESCE\(t\.merchant_name, t\.name\) = \$1/);
      assert.equal(params[0], 'Spotify');
      return {
        rows: [
          { id: 5, date: '2026-07-02', amount: 18.99, name: 'Spotify', merchant_name: 'Spotify', category: 'ENTERTAINMENT', account: 'Ally Checking' },
        ],
      };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  const response = await request(app).get('/api/expenses/16/transactions');

  assert.equal(response.status, 200);
  assert.equal(response.body.transactions.length, 1);
  assert.equal(response.body.transactions[0].amount, 18.99);
  assert.equal(response.body.transactions[0].account, 'Ally Checking');
});

test('GET /api/expenses/:id/transactions returns [] when the expense has no merchant', async () => {
  queryHandler = async (sql) => {
    if (/SELECT \* FROM recurring_expenses WHERE id/.test(sql)) {
      return { rows: [expenseRow({ id: 20, merchant_key: null })] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  const response = await request(app).get('/api/expenses/20/transactions');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.transactions, []);
});

test('GET /api/expenses/:id/transactions returns 404 for a missing expense', async () => {
  queryHandler = async (sql) => {
    if (/SELECT \* FROM recurring_expenses WHERE id/.test(sql)) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  };

  const response = await request(app).get('/api/expenses/999/transactions');

  assert.equal(response.status, 404);
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
      // Expense ignores land in the expenses scope only.
      assert.deepEqual(params, ['Spotify', 'expenses', 'Spotify', '18.99']);
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

test('DELETE /api/expenses/ignored restores an expense ignore and re-runs sync', async () => {
  const queries = [];
  queryHandler = async (sql, params) => {
    queries.push({ sql, params });
    if (/DELETE FROM ignored_merchants/.test(sql)) {
      assert.deepEqual(params, ['City/Water & Co', 'expenses']);
      return { rows: [] };
    }
    // The sync runs after restore; return empty sets so it completes cleanly.
    return { rows: [] };
  };

  const response = await request(app).delete('/api/expenses/ignored').query({ key: 'City/Water & Co' });

  assert.equal(response.status, 200);
  assert.equal(response.body.restored, 'City/Water & Co');
  assert.equal(response.body.recreated, false);
  assert.ok(queries.some((q) => /DELETE FROM ignored_merchants/.test(q.sql)));
  // Proof the sync ran: it queries the transactions and recurring_expenses tables.
  assert.ok(queries.some((q) => /FROM transactions/.test(q.sql)));
});

test('DELETE /api/expenses/ignored merchants scope skips the expense sync', async () => {
  const queries = [];
  queryHandler = async (sql, params) => {
    queries.push(sql);
    if (/DELETE FROM ignored_merchants/.test(sql)) {
      assert.deepEqual(params, ['Costco', 'merchants']);
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  const response = await request(app).delete('/api/expenses/ignored').query({ key: 'Costco', scope: 'merchants' });

  assert.equal(response.status, 200);
  assert.equal(response.body.restored, 'Costco');
  assert.equal(response.body.recreated, false);
  assert.ok(!queries.some((sql) => /FROM transactions/.test(sql)));
});

test('DELETE /api/expenses/ignored requires a key and a known scope', async () => {
  const missingKey = await request(app).delete('/api/expenses/ignored');
  assert.equal(missingKey.status, 400);

  const badScope = await request(app).delete('/api/expenses/ignored').query({ key: 'Costco', scope: 'everything' });
  assert.equal(badScope.status, 400);
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

// --- Top Merchants (merchant spend aggregation + ignore-by-key) ---

test('GET /api/expenses/merchants aggregates spend excluding ignored merchants', async () => {
  queryHandler = async (sql, params) => {
    assert.match(sql, /GROUP BY COALESCE\(t\.merchant_name, t\.name\)/);
    assert.match(sql, /NOT IN \(SELECT merchant_key FROM ignored_merchants WHERE scope = 'merchants'\)/);
    assert.match(sql, /t\.date >= CURRENT_DATE - \$1::int/);
    assert.equal(params[0], 60);
    return {
      rows: [
        { merchant_key: 'Costco', total: 812.44, charge_count: 6, last_date: '2026-07-18', account_count: 1, account: 'Amex' },
        { merchant_key: 'Whole Foods', total: 401.02, charge_count: 9, last_date: '2026-07-19', account_count: 2, account: 'Ally Checking' },
      ],
    };
  };

  const response = await request(app).get('/api/expenses/merchants?days=60');

  assert.equal(response.status, 200);
  assert.equal(response.body.days, 60);
  assert.equal(response.body.merchants.length, 2);
  assert.equal(response.body.merchants[0].merchant_key, 'Costco');
  assert.equal(response.body.merchants[0].total, 812.44);
});

test('GET /api/expenses/merchants defaults to 30 days and rejects other windows', async () => {
  queryHandler = async (sql, params) => {
    assert.equal(params[0], 30);
    return { rows: [] };
  };
  const ok = await request(app).get('/api/expenses/merchants');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.days, 30);

  const bad = await request(app).get('/api/expenses/merchants?days=45');
  assert.equal(bad.status, 400);
});

test('GET /api/expenses/merchants/transactions windows the merchant charges', async () => {
  queryHandler = async (sql, params) => {
    assert.match(sql, /COALESCE\(t\.merchant_name, t\.name\) = \$1/);
    assert.match(sql, /\$3::int IS NULL OR t\.date >= CURRENT_DATE - \$3::int/);
    assert.deepEqual(params, ['Trader Joe\'s', 100, 90]);
    return {
      rows: [
        { id: 9, date: '2026-07-15', amount: 64.1, name: 'Trader Joes', merchant_name: 'Trader Joe\'s', category: 'FOOD_AND_DRINK', account: 'Amex' },
      ],
    };
  };

  const response = await request(app)
    .get('/api/expenses/merchants/transactions')
    .query({ key: 'Trader Joe\'s', days: 90 });

  assert.equal(response.status, 200);
  assert.equal(response.body.transactions.length, 1);
  assert.equal(response.body.transactions[0].amount, 64.1);
});

test('GET /api/expenses/merchants/transactions requires a key', async () => {
  const response = await request(app).get('/api/expenses/merchants/transactions?days=30');
  assert.equal(response.status, 400);
});

test('POST /api/expenses/ignored ignores the merchant scope only, leaving tracked expenses alone', async () => {
  const calls = [];
  queryHandler = async (sql, params) => {
    calls.push(sql);
    if (/INSERT INTO ignored_merchants/.test(sql)) {
      assert.deepEqual(params, ['Costco', 'merchants', 'Costco', null]);
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  const response = await request(app)
    .post('/api/expenses/ignored')
    .send({ key: 'Costco' });

  assert.equal(response.status, 200);
  assert.equal(response.body.ignoredMerchant, 'Costco');
  // No recurring_expenses queries: the Monthly Expenses list is unaffected.
  assert.equal(calls.length, 1);
});

test('POST /api/expenses/ignored rejects a missing key', async () => {
  const response = await request(app).post('/api/expenses/ignored').send({});
  assert.equal(response.status, 400);
});
