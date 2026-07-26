'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
delete process.env.ETHERSCAN_API_KEY;

const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      query() { throw new Error('No DB in test mode'); }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const request = require('supertest');
const app = require('../src/server');

// Requiring the server runs dotenv, which repopulates these from a real .env
// if one is present. Clear both so the "not configured" path is actually
// exercised regardless of the developer's local environment: without them,
// SecretsService resolves keys env-only (no DB read against the fake pool)
// and finds nothing.
delete process.env.ETHERSCAN_API_KEY;
delete process.env.SECRETS_ENCRYPTION_KEY;

test('POST /api/eth/wallets without an address returns 400', async () => {
  const response = await request(app)
    .post('/api/eth/wallets')
    .send({})
    .set('Content-Type', 'application/json');

  assert.equal(response.status, 400);
  assert.match(response.body.error, /address is required/);
});

test('POST /api/eth/wallets with a malformed address returns 400', async () => {
  const response = await request(app)
    .post('/api/eth/wallets')
    .send({ address: 'not-an-address' })
    .set('Content-Type', 'application/json');

  assert.equal(response.status, 400);
  assert.match(response.body.error, /0x-prefixed/);
});

test('POST /api/eth/wallets without ETHERSCAN_API_KEY returns 503', async () => {
  const response = await request(app)
    .post('/api/eth/wallets')
    .send({ address: '0x1111111111111111111111111111111111111111' })
    .set('Content-Type', 'application/json');

  assert.equal(response.status, 503);
  assert.match(response.body.error, /Etherscan is not configured/);
});

test('POST /api/eth/ignored-tokens validates the contract address', async () => {
  const response = await request(app)
    .post('/api/eth/ignored-tokens')
    .send({ contract_address: '0x123' })
    .set('Content-Type', 'application/json');

  assert.equal(response.status, 400);
});

test('POST /api/eth/address-labels validates the address', async () => {
  const response = await request(app)
    .post('/api/eth/address-labels')
    .send({ address: '0x123', name: 'Coinbase' })
    .set('Content-Type', 'application/json');

  assert.equal(response.status, 400);
  assert.match(response.body.error, /0x-prefixed/);
});

test('POST /api/eth/address-labels requires a name', async () => {
  const response = await request(app)
    .post('/api/eth/address-labels')
    .send({ address: '0x1111111111111111111111111111111111111111' })
    .set('Content-Type', 'application/json');

  // No kind means 'exchange', which still demands a deliberately typed name.
  assert.equal(response.status, 400);
  assert.match(response.body.error, /name is required/);
});

test('POST /api/eth/address-labels rejects an unknown kind', async () => {
  const response = await request(app)
    .post('/api/eth/address-labels')
    .send({ address: '0x1111111111111111111111111111111111111111', name: 'X', kind: 'bogus' })
    .set('Content-Type', 'application/json');

  assert.equal(response.status, 400);
  assert.match(response.body.error, /kind must be/);
});

// The verdict selectors in the UI (Settings' label form, the Crypto page's
// inline Label button) are the only way to correct a wrong builtin, so the
// values they can send are a contract, not an implementation detail.
test('POST /api/eth/address-labels rejects a non-string kind rather than coercing it', async () => {
  for (const kind of [['own'], { kind: 'own' }, 3]) {
    const response = await request(app)
      .post('/api/eth/address-labels')
      .send({ address: '0x1111111111111111111111111111111111111111', name: 'X', kind })
      .set('Content-Type', 'application/json');

    // ['own'].toString() is 'own': coercing would let an array vote.
    assert.equal(response.status, 400, `kind ${JSON.stringify(kind)} should not be accepted`);
    assert.match(response.body.error, /kind must be/);
  }
});

// A <select> sends its value verbatim; ' OWN ' only shows up via a caller that
// pads or shouts, and normalizing it here is what keeps the allowlist the
// single definition of a valid verdict.
for (const kind of ['exchange', 'external', 'own', ' OWN ']) {
  test(`POST /api/eth/address-labels accepts the verdict '${kind}'`, async () => {
    const response = await request(app)
      .post('/api/eth/address-labels')
      .send({ address: '0x1111111111111111111111111111111111111111', name: 'Coinbase', kind })
      .set('Content-Type', 'application/json');

    // No DB in this suite, so validation passing (not 400) is the assertion.
    assert.notEqual(response.status, 400);
  });
}

// Omitting kind entirely is how a rename avoids re-voting: the model reads NULL
// as "keep the current verdict" and only defaults to 'exchange' on insert.
test('POST /api/eth/address-labels accepts an omitted kind', async () => {
  const response = await request(app)
    .post('/api/eth/address-labels')
    .send({ address: '0x1111111111111111111111111111111111111111', name: 'Coinbase' })
    .set('Content-Type', 'application/json');

  assert.notEqual(response.status, 400);
});

// The triage queue's two one-click verdicts carry no name. Their labels never
// reach classification as text, so a short-address fallback is enough -- only
// 'exchange' names must be typed, because that name IS the assertion that
// turns real spending into an internal transfer.
for (const kind of ['external', 'own']) {
  test(`POST /api/eth/address-labels accepts kind='${kind}' with no name`, async () => {
    const response = await request(app)
      .post('/api/eth/address-labels')
      .send({ address: '0x1111111111111111111111111111111111111111', kind })
      .set('Content-Type', 'application/json');

    // The fake pool has no rows to return, so this cannot reach 201 -- passing
    // validation is the whole assertion, matching the other route tests here.
    assert.notEqual(response.status, 400);
  });
}

// The balance audit (#62). Its filter is fail-closed for the same reason the
// activity route's category is: `?status=drift` silently returning every row,
// matched ones included, reads as "nothing drifted" -- the exact opposite of
// what a filter on an audit must promise.
test('GET /api/eth/reconciliation rejects an unknown status', async () => {
  const response = await request(app).get('/api/eth/reconciliation?status=drift');

  assert.equal(response.status, 400);
  assert.match(response.body.error, /Unknown status/);
});

test('GET /api/eth/reconciliation accepts a known status', async () => {
  const response = await request(app).get('/api/eth/reconciliation?status=mismatch');

  // The fake pool throws, so this cannot reach 200; passing validation without
  // being rejected as a bad request is the assertion, as elsewhere in this file.
  assert.notEqual(response.status, 400);
});

test('GET /api/eth/reconciliation 404s on a wallet the caller does not own', async () => {
  const response = await request(app).get('/api/eth/reconciliation?wallet_id=abc');

  assert.equal(response.status, 404);
  assert.match(response.body.error, /Wallet not found/);
});
