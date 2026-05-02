'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const app = require('../src/server');

test('GET /health returns 200 with status OK', async () => {
  const response = await request(app).get('/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'OK');
});

test('GET /health response body has timestamp', async () => {
  const response = await request(app).get('/health');
  assert.ok(response.body.timestamp, 'timestamp field should be present');
});
