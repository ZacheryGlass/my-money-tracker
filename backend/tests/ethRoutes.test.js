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
  assert.match(response.body.error, /ETHERSCAN_API_KEY/);
});

test('POST /api/eth/ignored-tokens validates the contract address', async () => {
  const response = await request(app)
    .post('/api/eth/ignored-tokens')
    .send({ contract_address: '0x123' })
    .set('Content-Type', 'application/json');

  assert.equal(response.status, 400);
});
