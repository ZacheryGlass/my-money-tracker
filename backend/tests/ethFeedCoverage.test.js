'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const queries = [];
let returnedRows = [];
const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      async query(text, params) {
        queries.push({ text, params });
        return { rows: returnedRows, rowCount: returnedRows.length };
      }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const EthFeedCoverage = require('../src/models/EthFeedCoverage');
const EtherscanService = require('../src/services/EtherscanService');

const sqlOf = (query) => query.text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

test('migration creates six-feed durable coverage without blessing old cursors as complete', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '055_eth_feed_coverage.sql'),
    'utf8'
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS eth_feed_coverage/);
  for (const feed of ['normal', 'internal', 'token', 'nft', 'nft1155', 'statesync']) {
    assert.match(migration, new RegExp(`'${feed}'`));
  }
  assert.match(migration, /'unverified'/);
  assert.doesNotMatch(
    migration,
    /pre-coverage migration'[\s\S]{0,100}'complete'/,
    'legacy rolled-up state is never promoted to a proven feed boundary'
  );
  assert.match(migration, /PRIMARY KEY \(wallet_id, chain_id, feed\)/);
  assert.match(migration, /REFERENCES eth_wallets\(id\) ON DELETE CASCADE/);
  assert.match(migration, /coverage_recapture_version < 1/);
  assert.match(migration, /ALTER COLUMN coverage_recapture_version SET DEFAULT 1/);
  assert.match(migration, /last_block_normal = 0/);

  const deferredMigration = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '075_eth_feed_coverage_deferred.sql'),
    'utf8'
  );
  assert.match(deferredMigration, /ADD COLUMN IF NOT EXISTS retry_after_at TIMESTAMPTZ/);
  assert.match(deferredMigration, /'deferred'/);
  assert.match(deferredMigration, /pg_get_constraintdef\(oid\) LIKE '%deferred%'/);
});

test('one chain attempt is written as one six-feed snapshot with exact errors', async () => {
  queries.length = 0;
  returnedRows = [];
  const entries = [
    {
      feed: 'normal',
      provider: 'Etherscan V2',
      status: 'complete',
      coveredFromBlock: 0,
      coveredThroughBlock: 123,
      indexedHead: 123,
      attemptedFromBlock: 64,
    },
    {
      feed: 'internal',
      provider: 'Etherscan V2',
      status: 'unsupported',
      indexedHead: 123,
      attemptedFromBlock: 64,
      errorCode: 'ETHERSCAN_FEED_UNSUPPORTED',
      errorMessage: 'internal traces are unavailable for blocks 0-123',
    },
    ...['token', 'nft', 'nft1155'].map((feed) => ({
      feed,
      provider: 'Etherscan V2',
      status: 'complete',
      coveredFromBlock: 0,
      coveredThroughBlock: 123,
      indexedHead: 123,
      attemptedFromBlock: 64,
    })),
    {
      feed: 'statesync',
      provider: 'Etherscan V2',
      status: 'not_applicable',
    },
  ];

  await EthFeedCoverage.recordAttempts(7, 1, entries);

  assert.equal(queries.length, 1);
  assert.match(sqlOf(queries[0]), /INSERT INTO eth_feed_coverage/);
  assert.match(sqlOf(queries[0]), /\$6::varchar\(20\)/, 'status parameters are explicitly typed for PostgreSQL inference');
  assert.match(sqlOf(queries[0]), /ON CONFLICT \(wallet_id, chain_id, feed\) DO UPDATE/);
  assert.match(sqlOf(queries[0]), /ELSE eth_feed_coverage\.covered_through_block/);
  assert.equal(queries[0].params.length, 6 * 15);
  assert.ok(queries[0].params.includes('ETHERSCAN_FEED_UNSUPPORTED'));
  assert.ok(queries[0].params.includes('internal traces are unavailable for blocks 0-123'));
  assert.match(sqlOf(queries[0]), /WHEN EXCLUDED\.status = 'deferred' THEN EXCLUDED\.retry_after_at ELSE NULL/,
    'a later success or standing limitation clears stale provider cooldown state');
});

test('failed coverage entries cannot omit their exact reason', async () => {
  await assert.rejects(
    EthFeedCoverage.recordAttempts(7, 1, [{
      feed: 'normal',
      provider: 'Etherscan V2',
      status: 'failed',
    }]),
    /requires an error message/
  );
});

test('deferred coverage requires and stores a durable retry time', async () => {
  await assert.rejects(
    EthFeedCoverage.recordAttempts(7, 1, [{
      feed: 'normal',
      provider: 'Blockscout',
      status: 'deferred',
      errorMessage: 'rate limited',
    }]),
    /requires a retry time/
  );

  queries.length = 0;
  const retryAt = new Date('2026-08-07T01:00:00Z');
  await EthFeedCoverage.recordAttempts(7, 8453, [{
    feed: 'normal',
    provider: 'Coinbase CDP address history (Base)',
    status: 'deferred',
    errorCode: 'CDP_RATE_LIMITED',
    errorMessage: 'CDP rate limited',
    retryAfterAt: retryAt,
  }]);
  assert.ok(queries[0].params.includes(retryAt));
});

test('coverage report reads only wallets owned by the requesting user', async () => {
  queries.length = 0;
  returnedRows = [{ wallet_id: 7, chain_id: 1, feed: 'normal' }];
  const rows = await EthFeedCoverage.findForUser(42);
  assert.equal(rows.length, 1);
  assert.match(sqlOf(queries[0]), /JOIN eth_wallets w ON w\.id = c\.wallet_id/);
  assert.match(sqlOf(queries[0]), /WHERE w\.user_id = \$1/);
  assert.deepEqual(queries[0].params, [42]);
});

test('history audit counts deferred coverage as an incomplete gap', () => {
  const auditScript = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'audit-history.js'),
    'utf8'
  );
  assert.match(
    auditScript,
    /c\.status IN \('failed', 'deferred', 'unsupported'\)/
  );
});

test('an explicit shared-scan head bounds every feed without taking a newer head', async (t) => {
  const originalLatest = EtherscanService._latestBlockNumber;
  const originalTimestamp = EtherscanService._blockTimestamp;
  const timestamps = [];
  EtherscanService._latestBlockNumber = async () => {
    throw new Error('must not take a second head after a shared scan');
  };
  EtherscanService._blockTimestamp = async (apiKey, chainId, block) => {
    timestamps.push({ apiKey, chainId, block });
    return new Date(block === 0 ? '2015-07-30T00:00:00Z' : '2026-07-30T00:00:00Z');
  };
  t.after(() => {
    EtherscanService._latestBlockNumber = originalLatest;
    EtherscanService._blockTimestamp = originalTimestamp;
  });

  const boundary = await EtherscanService.coverageBoundary('key', 100, 321);
  assert.equal(boundary.throughBlock, 321);
  assert.deepEqual(timestamps.map((row) => row.block), [0, 321]);
});
