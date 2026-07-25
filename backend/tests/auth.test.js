'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

// Programmable fake pool: tests capture queries and script responses.
const queries = [];
let queryHandler = async () => { throw new Error('No DB in test mode'); };
const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      query(text, params) {
        queries.push({ text, params });
        return queryHandler(text, params);
      }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const request = require('supertest');
const app = require('../src/server');
const requireUser = require('../src/middleware/auth');

const ZACH_ROW = { id: 1, username: 'zachery', display_name: 'Zachery' };

function identityHandler(rowsByEmail) {
  return async (text, params) => {
    if (text.includes('FROM user_identities')) {
      const row = rowsByEmail[params[0]];
      return { rows: row ? [row] : [] };
    }
    return { rows: [] };
  };
}

beforeEach(() => {
  queries.length = 0;
  queryHandler = async () => { throw new Error('No DB in test mode'); };
  requireUser._clearCache();
});

test('GET /api/me outside production returns the dev identity', async () => {
  const response = await request(app).get('/api/me');

  assert.equal(response.status, 200);
  assert.equal(response.body.user.id, 1);
  assert.equal(response.body.user.username, 'zachery');
});

test('GET /api/me in production without Easy Auth headers returns 401 and runs no query', async () => {
  process.env.NODE_ENV = 'production';
  try {
    const response = await request(app).get('/api/me');

    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'Authentication required');
    assert.equal(queries.length, 0);
  } finally {
    process.env.NODE_ENV = 'test';
  }
});

test('allowlisted principal resolves to its users row', async () => {
  process.env.NODE_ENV = 'production';
  process.env.ALLOWED_PRINCIPALS = 'zacheryglass@pm.me';
  queryHandler = identityHandler({ 'zacheryglass@pm.me': ZACH_ROW });
  try {
    const response = await request(app)
      .get('/api/me')
      .set('X-MS-CLIENT-PRINCIPAL-NAME', 'zacheryglass@pm.me')
      .set('X-MS-CLIENT-PRINCIPAL-ID', 'abc-123');

    assert.equal(response.status, 200);
    assert.equal(response.body.user.id, 1);
    assert.equal(response.body.user.username, 'zachery');
    assert.equal(response.body.user.principalId, 'abc-123');
  } finally {
    process.env.NODE_ENV = 'test';
    delete process.env.ALLOWED_PRINCIPALS;
  }
});

test('both seeded emails resolve to the same user', async () => {
  process.env.NODE_ENV = 'production';
  process.env.ALLOWED_PRINCIPALS = 'zacheryeglass@gmail.com,zacheryglass@pm.me';
  queryHandler = identityHandler({
    'zacheryeglass@gmail.com': ZACH_ROW,
    'zacheryglass@pm.me': ZACH_ROW,
  });
  try {
    const first = await request(app).get('/api/me')
      .set('X-MS-CLIENT-PRINCIPAL-NAME', 'zacheryeglass@gmail.com');
    const second = await request(app).get('/api/me')
      .set('X-MS-CLIENT-PRINCIPAL-NAME', 'zacheryglass@pm.me');

    assert.equal(first.body.user.id, 1);
    assert.equal(second.body.user.id, 1);
  } finally {
    process.env.NODE_ENV = 'test';
    delete process.env.ALLOWED_PRINCIPALS;
  }
});

test('allowlist match is case-insensitive and trims entries', async () => {
  process.env.NODE_ENV = 'production';
  process.env.ALLOWED_PRINCIPALS = ' Other@Example.com , ZacheryGlass@PM.me ';
  queryHandler = identityHandler({ 'zacheryglass@pm.me': ZACH_ROW });
  try {
    const response = await request(app)
      .get('/api/me')
      .set('X-MS-CLIENT-PRINCIPAL-NAME', 'zacheryglass@pm.me');

    assert.equal(response.status, 200);
  } finally {
    process.env.NODE_ENV = 'test';
    delete process.env.ALLOWED_PRINCIPALS;
  }
});

test('principal not in the allowlist gets 403 before any DB access', async () => {
  process.env.NODE_ENV = 'production';
  process.env.ALLOWED_PRINCIPALS = 'zacheryglass@pm.me';
  try {
    const response = await request(app)
      .get('/api/me')
      .set('X-MS-CLIENT-PRINCIPAL-NAME', 'stranger@gmail.com');

    assert.equal(response.status, 403);
    assert.equal(response.body.error, 'Not authorized');
    assert.equal(queries.length, 0);
  } finally {
    process.env.NODE_ENV = 'test';
    delete process.env.ALLOWED_PRINCIPALS;
  }
});

test('production with no allowlist configured fails closed with 403', async () => {
  process.env.NODE_ENV = 'production';
  delete process.env.ALLOWED_PRINCIPALS;
  try {
    const response = await request(app)
      .get('/api/me')
      .set('X-MS-CLIENT-PRINCIPAL-NAME', 'zacheryglass@pm.me');

    assert.equal(response.status, 403);
    assert.equal(queries.length, 0);
  } finally {
    process.env.NODE_ENV = 'test';
  }
});

test('unknown allowlisted email is auto-provisioned', async () => {
  process.env.NODE_ENV = 'production';
  process.env.ALLOWED_PRINCIPALS = 'new@example.com';
  const provisioned = { id: 7, username: 'new@example.com', display_name: null };
  let lookups = 0;
  queryHandler = async (text, params) => {
    if (text.includes('FROM user_identities')) {
      lookups += 1;
      // First lookup misses; the post-provision lookup hits.
      return { rows: lookups > 1 ? [provisioned] : [] };
    }
    return { rows: [] };
  };
  try {
    const response = await request(app)
      .get('/api/me')
      .set('X-MS-CLIENT-PRINCIPAL-NAME', 'New@Example.com');

    assert.equal(response.status, 200);
    assert.equal(response.body.user.id, 7);
    const inserts = queries.filter((q) => q.text.startsWith('INSERT INTO'));
    assert.equal(inserts.length, 2);
    assert.match(inserts[0].text, /INSERT INTO users/);
    assert.match(inserts[1].text, /INSERT INTO user_identities/);
    assert.equal(inserts[0].params[0], 'new@example.com');
  } finally {
    process.env.NODE_ENV = 'test';
    delete process.env.ALLOWED_PRINCIPALS;
  }
});

test('resolved identities are cached: second request runs no query', async () => {
  process.env.NODE_ENV = 'production';
  process.env.ALLOWED_PRINCIPALS = 'zacheryglass@pm.me';
  queryHandler = identityHandler({ 'zacheryglass@pm.me': ZACH_ROW });
  try {
    await request(app).get('/api/me')
      .set('X-MS-CLIENT-PRINCIPAL-NAME', 'zacheryglass@pm.me');
    const before = queries.length;
    const response = await request(app).get('/api/me')
      .set('X-MS-CLIENT-PRINCIPAL-NAME', 'zacheryglass@pm.me');

    assert.equal(response.status, 200);
    assert.equal(queries.length, before);
  } finally {
    process.env.NODE_ENV = 'test';
    delete process.env.ALLOWED_PRINCIPALS;
  }
});

test('identity lookup failure returns 503, not 401', async () => {
  process.env.NODE_ENV = 'production';
  process.env.ALLOWED_PRINCIPALS = 'zacheryglass@pm.me';
  queryHandler = async () => { throw new Error('connection refused'); };
  try {
    const response = await request(app)
      .get('/api/me')
      .set('X-MS-CLIENT-PRINCIPAL-NAME', 'zacheryglass@pm.me');

    assert.equal(response.status, 503);
    assert.equal(response.body.error, 'Identity lookup failed');
  } finally {
    process.env.NODE_ENV = 'test';
    delete process.env.ALLOWED_PRINCIPALS;
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
