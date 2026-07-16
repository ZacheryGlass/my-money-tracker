'use strict';

const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const authenticateToken = require('../src/middleware/auth');

const originalEnvironment = {
  nodeEnv: process.env.NODE_ENV,
  bypass: process.env.DEV_BYPASS_AUTH,
  userId: process.env.DEV_AUTH_USER_ID,
  username: process.env.DEV_AUTH_USERNAME,
};

function restoreEnvironmentVariable(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

after(() => {
  restoreEnvironmentVariable('NODE_ENV', originalEnvironment.nodeEnv);
  restoreEnvironmentVariable('DEV_BYPASS_AUTH', originalEnvironment.bypass);
  restoreEnvironmentVariable('DEV_AUTH_USER_ID', originalEnvironment.userId);
  restoreEnvironmentVariable('DEV_AUTH_USERNAME', originalEnvironment.username);
});

test('development auth bypass supplies the configured local user', () => {
  process.env.NODE_ENV = 'development';
  process.env.DEV_BYPASS_AUTH = 'true';
  process.env.DEV_AUTH_USER_ID = '42';
  process.env.DEV_AUTH_USERNAME = 'dev-user';

  const request = {};
  let nextCalled = false;

  authenticateToken(request, {}, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.deepEqual(request.user, {
    id: 42,
    username: 'dev-user',
    developmentBypass: true,
  });
});
