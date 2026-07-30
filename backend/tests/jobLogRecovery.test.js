'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const queries = [];
const pool = {
  async query(text, params) {
    queries.push({ text, params });
    return {
      rows: [{
        id: 17,
        job_name: 'eth-sync',
        started_at: new Date('2026-07-30T20:00:00.000Z'),
      }],
    };
  },
};

const databasePath = require.resolve('../src/config/database');
require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: pool,
};

const JobLog = require('../src/models/JobLog');

test('startup recovery fails only running jobs from an earlier process', async () => {
  queries.length = 0;
  const before = new Date('2026-07-30T21:00:00.000Z');

  const rows = await JobLog.failInterruptedRuns(before);

  assert.equal(rows[0].job_name, 'eth-sync');
  assert.equal(queries.length, 1);
  assert.match(queries[0].text, /WHERE status = 'running'/);
  assert.match(queries[0].text, /started_at < \$1/);
  assert.match(queries[0].text, /status = 'failed'/);
  assert.match(queries[0].text, /completed_at = CURRENT_TIMESTAMP/);
  assert.equal(queries[0].params[0], before);
  assert.deepEqual(JSON.parse(queries[0].params[1]), {
    interrupted: true,
    reason: 'application_process_restarted',
  });
});

test('startup recovery rejects an invalid process boundary', async () => {
  queries.length = 0;
  await assert.rejects(
    () => JobLog.failInterruptedRuns('2026-07-30'),
    (error) => error instanceof TypeError && /valid Date/.test(error.message)
  );
  assert.equal(queries.length, 0);
});
