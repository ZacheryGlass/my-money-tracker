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

const secretCrypto = require('../src/utils/secretCrypto');
const SecretsService = require('../src/services/SecretsService');

const TEST_KEY = crypto.randomBytes(32).toString('base64');

beforeEach(() => {
  queries.length = 0;
  queryHandler = async () => ({ rows: [] });
  SecretsService.clearCache();
  process.env.SECRETS_ENCRYPTION_KEY = TEST_KEY;
  delete process.env.ETHERSCAN_API_KEY;
  delete process.env.CG_API_KEY;
});

test('encrypt/decrypt roundtrip', () => {
  const payload = secretCrypto.encrypt('super-secret-value');
  assert.match(payload, /^v1:/);
  assert.ok(!payload.includes('super-secret-value'));
  assert.equal(secretCrypto.decrypt(payload), 'super-secret-value');
});

test('tampered ciphertext fails to decrypt', () => {
  const payload = secretCrypto.encrypt('super-secret-value');
  const parts = payload.split(':');
  const data = Buffer.from(parts[3], 'base64');
  data[0] ^= 0xff;
  parts[3] = data.toString('base64');
  assert.throws(() => secretCrypto.decrypt(parts.join(':')));
});

test('unset or malformed encryption key reports unconfigured', () => {
  delete process.env.SECRETS_ENCRYPTION_KEY;
  assert.equal(secretCrypto.isConfigured(), false);
  process.env.SECRETS_ENCRYPTION_KEY = 'too-short';
  assert.equal(secretCrypto.isConfigured(), false);
  assert.throws(() => secretCrypto.encrypt('x'));
});

test('mask shows only the last four characters', () => {
  assert.equal(secretCrypto.mask(secretCrypto.last4('abcdef123456')), '••••3456');
});

test('getUserKey prefers a decryptable DB row over env', async () => {
  process.env.ETHERSCAN_API_KEY = 'env-value';
  const stored = secretCrypto.encrypt('db-value');
  queryHandler = async () => ({ rows: [{ encrypted_value: stored, last4: 'alue' }] });

  const value = await SecretsService.getUserKey(1, 'etherscan');
  assert.equal(value, 'db-value');
});

test('getUserKey falls back to env when no row exists', async () => {
  process.env.ETHERSCAN_API_KEY = 'env-value';
  const value = await SecretsService.getUserKey(1, 'etherscan');
  assert.equal(value, 'env-value');
});

test('getUserKey returns null with no row and no env', async () => {
  assert.equal(await SecretsService.getUserKey(1, 'etherscan'), null);
});

test('Moralis is a per-user encrypted key with no shared env fallback', async () => {
  process.env.MORALIS_API_KEY = 'must-not-be-used';
  assert.ok(SecretsService.USER_SERVICES.includes('moralis'));
  assert.equal(await SecretsService.getUserKey(1, 'moralis'), null);

  await SecretsService.setUserKey(2, 'moralis', 'user-two-moralis-key');
  const insert = queries.find((q) => q.text.includes('INSERT INTO user_api_keys'));
  assert.equal(insert.params[0], 2);
  assert.equal(insert.params[1], 'moralis');
  assert.ok(!insert.params[2].includes('user-two-moralis-key'));
  delete process.env.MORALIS_API_KEY;
});

test('reads skip the DB entirely when encryption is unconfigured', async () => {
  delete process.env.SECRETS_ENCRYPTION_KEY;
  process.env.ETHERSCAN_API_KEY = 'env-value';
  const value = await SecretsService.getUserKey(1, 'etherscan');
  assert.equal(value, 'env-value');
  assert.equal(queries.length, 0);
});

test('writes throw SECRETS_NOT_CONFIGURED without an encryption key', async () => {
  delete process.env.SECRETS_ENCRYPTION_KEY;
  await assert.rejects(
    () => SecretsService.setUserKey(1, 'etherscan', 'x'),
    (err) => err.code === 'SECRETS_NOT_CONFIGURED'
  );
  await assert.rejects(
    () => SecretsService.deleteAppSetting('cg_api_key'),
    (err) => err.code === 'SECRETS_NOT_CONFIGURED'
  );
});

test('setUserKey upserts on (user_id, service) and stores no plaintext', async () => {
  await SecretsService.setUserKey(1, 'etherscan', 'my-plain-key');
  const insert = queries.find((q) => q.text.includes('INSERT INTO user_api_keys'));
  assert.ok(insert);
  assert.match(insert.text.replace(/\s+/g, ' '), /ON CONFLICT \(user_id, service\)/);
  assert.equal(insert.params[0], 1);
  assert.equal(insert.params[1], 'etherscan');
  assert.ok(!insert.params[2].includes('my-plain-key'));
  assert.equal(insert.params[3], '-key');
});

test('undecryptable stored value falls back to env', async () => {
  process.env.ETHERSCAN_API_KEY = 'env-value';
  queryHandler = async () => ({ rows: [{ encrypted_value: 'v1:garbage:garbage:garbage', last4: 'xxxx' }] });
  const value = await SecretsService.getUserKey(1, 'etherscan');
  assert.equal(value, 'env-value');
});

test('resolved values are cached and invalidated on write', async () => {
  process.env.ETHERSCAN_API_KEY = 'env-value';
  await SecretsService.getUserKey(1, 'etherscan');
  const afterFirst = queries.length;
  await SecretsService.getUserKey(1, 'etherscan');
  assert.equal(queries.length, afterFirst, 'second read served from cache');

  await SecretsService.setUserKey(1, 'etherscan', 'fresh');
  const stored = secretCrypto.encrypt('fresh');
  queryHandler = async (text) => (
    text.startsWith('SELECT encrypted_value')
      ? { rows: [{ encrypted_value: stored, last4: 'resh' }] }
      : { rows: [] }
  );
  assert.equal(await SecretsService.getUserKey(1, 'etherscan'), 'fresh');
});
