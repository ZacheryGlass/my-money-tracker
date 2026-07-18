'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

// Mock the pg Pool before anything imports it. We inject a fake pool into
// require.cache so that ../config/database returns our mock instead of
// creating a real connection.
const pgModulePath = require.resolve('pg');
const fakePool = {
  query: async () => { throw new Error('No DB in test mode'); },
  on: () => {},
};
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool { query() { return fakePool.query(); } on() {} },
    types: { setTypeParser() {} },
  },
};

// Now it's safe to load the app — database.js will get our fake Pool.
const request = require('supertest');
const app = require('../src/server');

test('GET /api/me outside production returns the dev identity', async () => {
  const response = await request(app).get('/api/me');

  assert.equal(response.status, 200);
  assert.equal(response.body.user.id, 1);
  assert.equal(response.body.user.username, 'zachery');
});

test('GET /api/me in production without Easy Auth headers returns 401', async () => {
  process.env.NODE_ENV = 'production';
  try {
    const response = await request(app).get('/api/me');

    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'Authentication required');
  } finally {
    process.env.NODE_ENV = 'test';
  }
});

test('GET /api/me in production reads the Easy Auth principal headers', async () => {
  process.env.NODE_ENV = 'production';
  try {
    const response = await request(app)
      .get('/api/me')
      .set('X-MS-CLIENT-PRINCIPAL-NAME', 'zacheryglass@pm.me')
      .set('X-MS-CLIENT-PRINCIPAL-ID', 'abc-123');

    assert.equal(response.status, 200);
    assert.equal(response.body.user.username, 'zacheryglass@pm.me');
    assert.equal(response.body.user.principalId, 'abc-123');
  } finally {
    process.env.NODE_ENV = 'test';
  }
});

test('protected API routes reject unauthenticated production requests', async () => {
  process.env.NODE_ENV = 'production';
  try {
    const response = await request(app).get('/api/accounts');

    assert.equal(response.status, 401);
  } finally {
    process.env.NODE_ENV = 'test';
  }
});

test('POST /api/auth/login no longer exists', async () => {
  const response = await request(app)
    .post('/api/auth/login')
    .send({ username: 'x', password: 'y' })
    .set('Content-Type', 'application/json');

  assert.equal(response.status, 404);
});
