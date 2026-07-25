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
const secretCrypto = require('../src/utils/secretCrypto');

const TEST_KEY = crypto.randomBytes(32).toString('base64');

beforeEach(() => {
  queries.length = 0;
  queryHandler = async () => ({ rows: [] });
  SecretsService.clearCache();
  process.env.SECRETS_ENCRYPTION_KEY = TEST_KEY;
  // The server require ran dotenv, which loads the developer's real .env;
  // clear every fallback var so statuses are deterministic.
  delete process.env.ETHERSCAN_API_KEY;
  delete process.env.CG_API_KEY;
  delete process.env.CMC_PRO_API_KEY;
  delete process.env.PLAID_CLIENT_ID;
  delete process.env.PLAID_SECRET;
});

test('PUT rejects an unknown service', async () => {
  const response = await request(app)
    .put('/api/keys/nonsense')
    .send({ value: 'abc' })
    .set('Content-Type', 'application/json');

  assert.equal(response.status, 400);
  assert.match(response.body.error, /Unknown service/);
});

test('PUT rejects empty and oversized values', async () => {
  const empty = await request(app)
    .put('/api/keys/etherscan')
    .send({ value: '   ' })
    .set('Content-Type', 'application/json');
  assert.equal(empty.status, 400);

  const oversized = await request(app)
    .put('/api/keys/etherscan')
    .send({ value: 'x'.repeat(513) })
    .set('Content-Type', 'application/json');
  assert.equal(oversized.status, 400);
});

test('PUT and DELETE return 503 when encryption is unconfigured', async () => {
  delete process.env.SECRETS_ENCRYPTION_KEY;

  const put = await request(app)
    .put('/api/keys/etherscan')
    .send({ value: 'abc' })
    .set('Content-Type', 'application/json');
  assert.equal(put.status, 503);

  const del = await request(app).delete('/api/keys/cg_api_key');
  assert.equal(del.status, 503);
});

test('GET reports statuses without ever returning plaintext', async () => {
  process.env.ETHERSCAN_API_KEY = 'env-super-secret';
  const response = await request(app).get('/api/keys');

  assert.equal(response.status, 200);
  assert.equal(response.body.encryptionConfigured, true);
  assert.deepEqual(response.body.userKeys.etherscan, { source: 'env', masked: null });
  assert.deepEqual(response.body.userKeys.plaid_client_id, { source: 'none', masked: null });
  assert.deepEqual(response.body.appSettings.cg_api_key, { source: 'none', masked: null });
  assert.ok(!JSON.stringify(response.body).includes('env-super-secret'));
});

test('GET flags a missing encryption key but still answers', async () => {
  delete process.env.SECRETS_ENCRYPTION_KEY;
  const response = await request(app).get('/api/keys');

  assert.equal(response.status, 200);
  assert.equal(response.body.encryptionConfigured, false);
  assert.equal(queries.length, 0, 'no DB reads without an encryption key');
});

test('PUT routes user services to user_api_keys and app keys to app_settings', async () => {
  queryHandler = async (text) => (
    text.startsWith('SELECT encrypted_value, last4')
      ? { rows: [{ encrypted_value: secretCrypto.encrypt('abcd1234'), last4: '1234' }] }
      : { rows: [] }
  );

  const userPut = await request(app)
    .put('/api/keys/etherscan')
    .send({ value: 'abcd1234' })
    .set('Content-Type', 'application/json');
  assert.equal(userPut.status, 200);
  assert.equal(userPut.body.source, 'db');
  assert.equal(userPut.body.masked, '••••1234');
  assert.ok(queries.some((q) => q.text.includes('INSERT INTO user_api_keys')));

  queries.length = 0;
  const appPut = await request(app)
    .put('/api/keys/cg_api_key')
    .send({ value: 'wxyz1234' })
    .set('Content-Type', 'application/json');
  assert.equal(appPut.status, 200);
  assert.ok(queries.some((q) => q.text.includes('INSERT INTO app_settings')));
  assert.ok(!queries.some((q) => q.text.includes('user_api_keys')));
});

test('a stored key that no longer decrypts reports db_unreadable, not db or none', async () => {
  // Simulates a rotated SECRETS_ENCRYPTION_KEY: the row and its last4 survive,
  // but the ciphertext is unreadable. Reporting 'db' would show a key nothing
  // can use; reporting 'none' would hide the row -- and with it the Clear
  // button that is the only way to remove it from the UI.
  queryHandler = async (text) => (
    text.startsWith('SELECT encrypted_value, last4')
      ? { rows: [{ encrypted_value: 'v1:00:00:deadbeef', last4: '1234' }] }
      : { rows: [] }
  );

  const response = await request(app).get('/api/keys');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.userKeys.etherscan, { source: 'db_unreadable', masked: '••••1234' });
});

test('an unreadable stored key still falls back to the env value for resolution', async () => {
  process.env.ETHERSCAN_API_KEY = 'env-fallback-value';
  queryHandler = async (text) => (
    text.startsWith('SELECT encrypted_value, last4')
      ? { rows: [{ encrypted_value: 'v1:00:00:deadbeef', last4: '1234' }] }
      : { rows: [] }
  );

  const value = await SecretsService.getUserKey(1, 'etherscan');
  assert.equal(value, 'env-fallback-value');
});

test('DELETE falls back to env status after removal', async () => {
  process.env.ETHERSCAN_API_KEY = 'env-value';
  const response = await request(app).delete('/api/keys/etherscan');

  assert.equal(response.status, 200);
  assert.deepEqual({ source: response.body.source, masked: response.body.masked }, { source: 'env', masked: null });
  assert.ok(queries.some((q) => q.text.includes('DELETE FROM user_api_keys')));
});
