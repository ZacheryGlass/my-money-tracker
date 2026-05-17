'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
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

const token = jwt.sign({ id: 1, username: 'test' }, process.env.JWT_SECRET);

beforeEach(() => {
  queryHandler = async () => {
    throw new Error('Unexpected query');
  };
});

test('GET /api/accounts returns raw and effective account names', async () => {
  queryHandler = async (sql) => {
    assert.match(sql, /display_name/);
    assert.match(sql, /effective_name/);
    assert.match(sql, /is_hidden/);
    assert.match(sql, /WHERE a\.is_hidden = FALSE/);
    return {
      rows: [
        {
          id: 7,
          name: 'Very Long Plaid Account Name',
          display_name: 'Checking',
          effective_name: 'Checking',
          is_hidden: false,
          type: 'depository',
          plaid_item_id: 3,
          holdings_count: 2,
        },
      ],
    };
  };

  const response = await request(app)
    .get('/api/accounts')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.accounts[0].name, 'Very Long Plaid Account Name');
  assert.equal(response.body.accounts[0].display_name, 'Checking');
  assert.equal(response.body.accounts[0].effective_name, 'Checking');
  assert.equal(response.body.accounts[0].is_hidden, false);
});

test('GET /api/accounts can include hidden accounts for settings', async () => {
  queryHandler = async (sql) => {
    assert.doesNotMatch(sql, /WHERE a\.is_hidden = FALSE/);
    return {
      rows: [
        {
          id: 7,
          name: 'Old Brokerage',
          display_name: null,
          effective_name: 'Old Brokerage',
          is_hidden: true,
          type: 'investment',
          plaid_item_id: 3,
          holdings_count: 0,
        },
      ],
    };
  };

  const response = await request(app)
    .get('/api/accounts?include_hidden=true')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.accounts[0].is_hidden, true);
});

test('PATCH /api/accounts/:id/display-name saves a trimmed display name', async () => {
  queryHandler = async (sql, params) => {
    assert.match(sql, /UPDATE accounts/);
    assert.deepEqual(params, ['Checking', 7]);
    return {
      rows: [
        {
          id: 7,
          name: 'Very Long Plaid Account Name',
          display_name: 'Checking',
          effective_name: 'Checking',
          is_hidden: false,
          type: 'depository',
          plaid_item_id: 3,
        },
      ],
    };
  };

  const response = await request(app)
    .patch('/api/accounts/7/display-name')
    .set('Authorization', `Bearer ${token}`)
    .send({ display_name: '  Checking  ' });

  assert.equal(response.status, 200);
  assert.equal(response.body.account.display_name, 'Checking');
  assert.equal(response.body.account.effective_name, 'Checking');
});

test('PATCH /api/accounts/:id/display-name clears blank display names', async () => {
  queryHandler = async (_sql, params) => {
    assert.deepEqual(params, [null, 7]);
    return {
      rows: [
        {
          id: 7,
          name: 'Very Long Plaid Account Name',
          display_name: null,
          effective_name: 'Very Long Plaid Account Name',
          is_hidden: false,
          type: 'depository',
          plaid_item_id: 3,
        },
      ],
    };
  };

  const response = await request(app)
    .patch('/api/accounts/7/display-name')
    .set('Authorization', `Bearer ${token}`)
    .send({ display_name: '   ' });

  assert.equal(response.status, 200);
  assert.equal(response.body.account.display_name, null);
  assert.equal(response.body.account.effective_name, 'Very Long Plaid Account Name');
});

test('PATCH /api/accounts/:id/display-name rejects invalid payloads', async () => {
  const response = await request(app)
    .patch('/api/accounts/7/display-name')
    .set('Authorization', `Bearer ${token}`)
    .send({ display_name: 42 });

  assert.equal(response.status, 400);
});

test('PATCH /api/accounts/:id/display-name returns 404 for missing accounts', async () => {
  queryHandler = async () => ({ rows: [] });

  const response = await request(app)
    .patch('/api/accounts/999/display-name')
    .set('Authorization', `Bearer ${token}`)
    .send({ display_name: 'Checking' });

  assert.equal(response.status, 404);
});

test('PATCH /api/accounts/:id/visibility hides an account', async () => {
  queryHandler = async (sql, params) => {
    assert.match(sql, /UPDATE accounts/);
    assert.match(sql, /is_hidden/);
    assert.deepEqual(params, [true, 7]);
    return {
      rows: [
        {
          id: 7,
          name: 'Old Brokerage',
          display_name: null,
          effective_name: 'Old Brokerage',
          is_hidden: true,
          type: 'investment',
          plaid_item_id: 3,
        },
      ],
    };
  };

  const response = await request(app)
    .patch('/api/accounts/7/visibility')
    .set('Authorization', `Bearer ${token}`)
    .send({ is_hidden: true });

  assert.equal(response.status, 200);
  assert.equal(response.body.account.is_hidden, true);
});

test('PATCH /api/accounts/:id/visibility rejects invalid payloads', async () => {
  const response = await request(app)
    .patch('/api/accounts/7/visibility')
    .set('Authorization', `Bearer ${token}`)
    .send({ is_hidden: 'true' });

  assert.equal(response.status, 400);
});
