'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
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

test('POST /api/auth/login with missing credentials returns 400', async () => {
  const response = await request(app)
    .post('/api/auth/login')
    .send({})
    .set('Content-Type', 'application/json');

  assert.equal(response.status, 400);
  assert.ok(response.body.error, 'error field should be present');
});

test('POST /api/auth/login returns JSON content-type', async () => {
  const response = await request(app)
    .post('/api/auth/login')
    .send({ username: 'bad', password: 'wrong' })
    .set('Content-Type', 'application/json');

  assert.ok(
    response.headers['content-type'].includes('application/json'),
    'response should be JSON'
  );
});

test('POST /api/auth/login with bad credentials returns 401', async () => {
  // The User model calls pool.query; our fake pool throws, which the route
  // catches and returns 500. We override the fake for this test to return
  // an empty result set (user not found), which triggers the 401 path.
  const dbPath = require.resolve('../src/config/database');
  const originalModule = require.cache[dbPath];

  // Replace pool.query with one that returns no rows (user not found)
  const mockPool = {
    query: async () => ({ rows: [] }),
    on: () => {},
  };
  require.cache[dbPath] = {
    ...originalModule,
    exports: mockPool,
  };

  // Clear the User model cache so it re-requires the updated pool mock
  const userPath = require.resolve('../src/models/User');
  delete require.cache[userPath];

  // Clear the auth route cache so it re-requires User
  const authRoutePath = require.resolve('../src/routes/auth');
  delete require.cache[authRoutePath];

  // Clear the server cache so it re-requires the auth route
  const serverPath = require.resolve('../src/server');
  delete require.cache[serverPath];

  const freshApp = require('../src/server');

  const response = await request(freshApp)
    .post('/api/auth/login')
    .send({ username: 'notauser', password: 'badpassword' })
    .set('Content-Type', 'application/json');

  assert.equal(response.status, 401);
  assert.ok(response.body.error, 'error field should be present');

  // Restore original module cache entry
  if (originalModule) {
    require.cache[dbPath] = originalModule;
  } else {
    delete require.cache[dbPath];
  }
});

test('POST /api/auth/login rate limit returns JSON error', async () => {
  let response;

  for (let i = 0; i < 11; i += 1) {
    response = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '203.0.113.10')
      .send({ username: 'bad', password: 'wrong' })
      .set('Content-Type', 'application/json');
  }

  assert.equal(response.status, 429);
  assert.match(response.headers['content-type'], /application\/json/);
  assert.equal(response.body.error, 'Too many login attempts. Please try again later.');
});

test('GET /api/auth/me is not blocked by the login rate limit', async () => {
  const token = jwt.sign({ id: 1, username: 'test' }, process.env.JWT_SECRET);
  let response;

  for (let i = 0; i < 12; i += 1) {
    response = await request(app)
      .get('/api/auth/me')
      .set('X-Forwarded-For', '203.0.113.11')
      .set('Authorization', `Bearer ${token}`);
  }

  assert.notEqual(response.status, 429);
});

test('POST /api/auth/login route exists (not 404)', async () => {
  const response = await request(app)
    .post('/api/auth/login')
    .send({ username: 'x', password: 'y' })
    .set('Content-Type', 'application/json');

  assert.notEqual(response.status, 404);
});
