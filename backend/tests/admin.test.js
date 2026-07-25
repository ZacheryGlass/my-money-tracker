'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const queries = [];
let queryHandler = async () => ({ rows: [] });
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
const SecretsService = require('../src/services/SecretsService');

const TEST_KEY = crypto.randomBytes(32).toString('base64');

function asUser(id, username) {
  process.env.DEV_AUTH_USER_ID = String(id);
  process.env.DEV_AUTH_USERNAME = username;
}

beforeEach(() => {
  queries.length = 0;
  queryHandler = async () => ({ rows: [] });
  SecretsService.clearCache();
  process.env.SECRETS_ENCRYPTION_KEY = TEST_KEY;
  process.env.MCP_API_KEY = 'mcp-secret-abcd';
  delete process.env.DEV_AUTH_USER_ID;
  delete process.env.DEV_AUTH_USERNAME;
  delete process.env.CG_API_KEY;
  delete process.env.CMC_PRO_API_KEY;
});

test('GET /api/admin/overview returns env, users, jobs, and health for the admin', async () => {
  queryHandler = async (text) => {
    if (text.includes('FROM users u')) {
      return {
        rows: [{
          id: 1, username: 'zachery', display_name: 'Zachery', is_admin: true,
          created_at: '2026-05-03', emails: ['zacheryglass@pm.me'],
          account_count: 3, wallet_count: 1, plaid_item_count: 2,
          configured_keys: ['etherscan'],
        }],
      };
    }
    if (text.includes('MAX(fetched_at)')) return { rows: [{ latest: '2026-07-24T08:00:00Z' }] };
    return { rows: [] };
  };

  const response = await request(app).get('/api/admin/overview');

  assert.equal(response.status, 200);
  assert.equal(response.body.encryptionConfigured, true);

  const envByName = Object.fromEntries(response.body.env.map((e) => [e.name, e]));
  assert.equal(envByName.SECRETS_ENCRYPTION_KEY.valid, true);
  assert.equal(envByName.MCP_API_KEY.set, true);
  assert.equal(envByName.MCP_API_KEY.masked, '••••abcd');
  // Never the full value, anywhere in the payload.
  assert.ok(!JSON.stringify(response.body).includes('mcp-secret-abcd'));
  assert.equal(envByName.DATABASE_URL.host, 'localhost');

  assert.equal(response.body.users[0].username, 'zachery');
  assert.deepEqual(response.body.users[0].configured_keys, ['etherscan']);
  assert.ok(response.body.health.dbReachable);
  assert.ok(response.body.health.migrationCount >= 30);
  assert.ok(Array.isArray(response.body.jobs) || typeof response.body.jobs === 'object');
});

test('GET /api/admin/overview is 403 for non-admins', async () => {
  asUser(2, 'alice');
  const response = await request(app).get('/api/admin/overview');
  assert.equal(response.status, 403);
});

test('GET /api/keys omits shared app settings for non-admins', async () => {
  asUser(2, 'alice');
  const response = await request(app).get('/api/keys');

  assert.equal(response.status, 200);
  assert.ok(response.body.userKeys);
  assert.equal(response.body.appSettings, undefined);
});

test('non-admins cannot set or clear shared keys', async () => {
  asUser(2, 'alice');
  const put = await request(app)
    .put('/api/keys/cg_api_key')
    .send({ value: 'nice-try' })
    .set('Content-Type', 'application/json');
  assert.equal(put.status, 403);

  const del = await request(app).delete('/api/keys/cmc_api_key');
  assert.equal(del.status, 403);

  // Their own keys still work.
  const own = await request(app)
    .put('/api/keys/etherscan')
    .send({ value: 'alice-key-1234' })
    .set('Content-Type', 'application/json');
  assert.equal(own.status, 200);
});
