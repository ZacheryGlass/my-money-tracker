'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('logger removes explorer credentials and addresses from Axios error metadata', () => {
  const secret = 'synthetic-api-key-must-not-appear';
  const address = `0x${'12'.repeat(20)}`;
  const script = `
    const logger = require('./src/config/logger');
    const makeError = () => {
      const error = new Error('synthetic explorer failure');
      error.config = {
        headers: { Authorization: 'Bearer ${secret}' },
        data: 'payload-${secret}',
        params: { apikey: '${secret}', address: '${address}' },
        url: 'https://example.invalid/addresses/${address}/transactions?apikey=${secret}',
      };
      error.request = { path: '/?address=${address}&apikey=${secret}' };
      error.response = {
        config: { ...error.config },
        request: { path: '/?address=${address}&apikey=${secret}' },
      };
      return error;
    };
    logger.warn({ err: makeError(), error: makeError() }, 'redaction-regression');
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'production', LOG_LEVEL: 'warn' },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /redaction-regression/);
  assert.doesNotMatch(result.stdout, new RegExp(secret));
  assert.doesNotMatch(result.stdout, new RegExp(address, 'i'));
});
