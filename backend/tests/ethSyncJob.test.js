'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      async query() { return { rows: [], rowCount: 0 }; }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const EthSyncJob = require('../src/jobs/ethSyncJob');
const JobLog = require('../src/models/JobLog');
const EthWallet = require('../src/models/EthWallet');
const EthWalletService = require('../src/services/EthWalletService');

test('enqueue claims the job and returns before a cooldown-capable scan finishes', async (t) => {
  const originals = {
    claim: JobLog.createIfNotRunning,
    complete: JobLog.complete,
    fail: JobLog.fail,
    wallets: EthWallet.findAllForJobs,
    sync: EthWalletService.syncAllWallets,
  };
  t.after(() => {
    JobLog.createIfNotRunning = originals.claim;
    JobLog.complete = originals.complete;
    JobLog.fail = originals.fail;
    EthWallet.findAllForJobs = originals.wallets;
    EthWalletService.syncAllWallets = originals.sync;
  });

  let releaseScan;
  const scan = new Promise((resolve) => { releaseScan = resolve; });
  let completeJob;
  const completed = new Promise((resolve) => { completeJob = resolve; });
  JobLog.createIfNotRunning = async () => ({ id: 91 });
  JobLog.complete = async (...args) => { completeJob(args); };
  JobLog.fail = async () => { throw new Error('unexpected job failure'); };
  EthWallet.findAllForJobs = async () => [{ id: 7 }];
  EthWalletService.syncAllWallets = async () => scan;

  const queued = await EthSyncJob.enqueue();
  assert.deepEqual(queued, { started: true, jobLogId: 91 });

  releaseScan({
    processed: 1,
    succeeded: 1,
    failed: 0,
    deferred: 0,
    unsupported: 0,
    unverified: 0,
    skipped: 0,
    results: [{ walletId: 7, status: 'complete' }],
  });
  const completeArgs = await completed;
  assert.deepEqual(completeArgs.slice(0, 4), [91, 1, 1, 0]);
  assert.equal(completeArgs[4].deferred, 0);
});

test('enqueue reports a concurrent scan without scheduling another one', async (t) => {
  const original = JobLog.createIfNotRunning;
  t.after(() => { JobLog.createIfNotRunning = original; });
  JobLog.createIfNotRunning = async () => null;

  assert.deepEqual(await EthSyncJob.enqueue(), {
    skipped: true,
    reason: 'concurrent_execution',
  });
});
