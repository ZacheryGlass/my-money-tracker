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

test('POST /api/eth/address-notes validates both address and note before writing', async () => {
  const badAddress = await request(app)
    .post('/api/eth/address-notes')
    .send({ address: '0x123', note: 'Known service' })
    .set('Content-Type', 'application/json');
  assert.equal(badAddress.status, 400);

  const blankNote = await request(app)
    .post('/api/eth/address-notes')
    .send({ address: '0x1111111111111111111111111111111111111111', note: '   ' })
    .set('Content-Type', 'application/json');
  assert.equal(blankNote.status, 400);
  assert.match(blankNote.body.error, /note is required/);
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
for (const kind of ['exchange', 'external', 'own', 'bridge', 'service', ' OWN ']) {
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

// The one-click verdicts carry no name. Their labels never reach
// classification as text, so a short-address fallback is enough -- only
// 'exchange' names must be typed, because that name IS the assertion that
// turns real spending into an internal transfer.
for (const kind of ['external', 'own', 'bridge']) {
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

// Bulk wallet add. The contract worth pinning is per-address verdicts: a bad
// line must not reject the good ones, and a line must never be silently
// dropped.
test('POST /api/eth/wallets/bulk rejects a non-array body', async () => {
  const response = await request(app)
    .post('/api/eth/wallets/bulk')
    .send({ addresses: '0x1111111111111111111111111111111111111111' })
    .set('Content-Type', 'application/json');

  assert.equal(response.status, 400);
  assert.match(response.body.error, /non-empty array/);
});

test('POST /api/eth/wallets/bulk rejects an empty list', async () => {
  const response = await request(app)
    .post('/api/eth/wallets/bulk')
    .send({ addresses: [] })
    .set('Content-Type', 'application/json');

  assert.equal(response.status, 400);
});

test('POST /api/eth/wallets/bulk caps the batch size', async () => {
  const addresses = Array.from({ length: 101 }, (_, i) => `0x${String(i).padStart(40, '0')}`);
  const response = await request(app)
    .post('/api/eth/wallets/bulk')
    .send({ addresses })
    .set('Content-Type', 'application/json');

  assert.equal(response.status, 400);
  assert.match(response.body.error, /At most 100/);
});

// The key belongs to the user, not to any one line, so it answers the whole
// request once instead of failing every address with the same message.
test('POST /api/eth/wallets/bulk without ETHERSCAN_API_KEY returns 503', async () => {
  const response = await request(app)
    .post('/api/eth/wallets/bulk')
    .send({ addresses: ['0x1111111111111111111111111111111111111111'] })
    .set('Content-Type', 'application/json');

  assert.equal(response.status, 503);
  assert.match(response.body.error, /Etherscan is not configured/);
});

test('POST /api/eth/wallets/bulk allows a keyless-only chain set', async () => {
  const EthWalletService = require('../src/services/EthWalletService');
  const originalAddWallet = EthWalletService.addWallet;
  const originalSyncWallet = EthWalletService.syncWallet;
  const priorChains = process.env.ETH_CHAINS;
  process.env.ETH_CHAINS = '100';
  EthWalletService.addWallet = async (userId, address) => ({
    wallet: { id: 77, user_id: userId, address },
    account: { id: 88 },
  });
  EthWalletService.syncWallet = async () => ({});
  try {
    const response = await request(app)
      .post('/api/eth/wallets/bulk')
      .send({ addresses: ['0x1111111111111111111111111111111111111111'] })
      .set('Content-Type', 'application/json');

    assert.equal(response.status, 201);
    assert.equal(response.body.summary.added, 1);
  } finally {
    EthWalletService.addWallet = originalAddWallet;
    EthWalletService.syncWallet = originalSyncWallet;
    if (priorChains === undefined) delete process.env.ETH_CHAINS;
    else process.env.ETH_CHAINS = priorChains;
  }
});

test('POST /api/eth/wallets/bulk reports each address and adds the good ones', async () => {
  const SecretsService = require('../src/services/SecretsService');
  const EthWalletService = require('../src/services/EthWalletService');
  const originalGetUserKey = SecretsService.getUserKey;
  const originalAddWallet = EthWalletService.addWallet;
  const originalSyncWallet = EthWalletService.syncWallet;

  const good = '0x1111111111111111111111111111111111111111';
  const tracked = '0x2222222222222222222222222222222222222222';
  const bad = 'not-an-address';
  const synced = [];

  SecretsService.getUserKey = async () => 'test-key';
  EthWalletService.addWallet = async (userId, address) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      const error = new Error('address must be a 0x-prefixed 40-hex-character EVM address');
      error.code = 'INVALID_ADDRESS';
      throw error;
    }
    if (address.toLowerCase() === tracked) {
      const error = new Error('That address is already tracked');
      error.code = 'DUPLICATE_WALLET';
      throw error;
    }
    return { wallet: { id: 7, address }, account: { id: 9 } };
  };
  EthWalletService.syncWallet = async (id) => { synced.push(id); };

  try {
    const response = await request(app)
      .post('/api/eth/wallets/bulk')
      // The repeated `good` is the in-paste duplicate: it must be reported as
      // repeated, not added twice and not reported as already tracked.
      .send({ addresses: [good, bad, tracked, good, '   '] })
      .set('Content-Type', 'application/json');

    assert.equal(response.status, 201);
    assert.deepEqual(response.body.summary, { added: 1, duplicate: 2, failed: 1 });
    assert.deepEqual(
      response.body.results.map((r) => [r.address, r.status]),
      [[good, 'added'], [bad, 'failed'], [tracked, 'duplicate'], [good, 'duplicate']]
    );
    assert.match(response.body.results[1].error, /0x-prefixed/);
  } finally {
    SecretsService.getUserKey = originalGetUserKey;
    EthWalletService.addWallet = originalAddWallet;
    EthWalletService.syncWallet = originalSyncWallet;
  }
});

test('POST /api/eth/wallets/:id/recapture starts a background replay for an owned wallet', async () => {
  const EthWallet = require('../src/models/EthWallet');
  const EthWalletService = require('../src/services/EthWalletService');
  const originalFind = EthWallet.findByIdForUser;
  const originalQueue = EthWalletService.queueRecaptureWallet;
  const queued = [];
  EthWallet.findByIdForUser = async (id, userId) => (
    id === 7 ? { id, user_id: userId } : null
  );
  EthWalletService.queueRecaptureWallet = (id) => {
    queued.push(id);
    return { started: true };
  };
  try {
    const response = await request(app).post('/api/eth/wallets/7/recapture');
    assert.equal(response.status, 202);
    assert.deepEqual(queued, [7]);
    assert.equal(response.body.started, true);
    assert.equal(response.body.annotations_preserved, true);
  } finally {
    EthWallet.findByIdForUser = originalFind;
    EthWalletService.queueRecaptureWallet = originalQueue;
  }
});

test('POST /api/eth/wallets/:id/recapture cannot replay another user’s wallet', async () => {
  const EthWallet = require('../src/models/EthWallet');
  const EthWalletService = require('../src/services/EthWalletService');
  const originalFind = EthWallet.findByIdForUser;
  const originalQueue = EthWalletService.queueRecaptureWallet;
  let queued = false;
  EthWallet.findByIdForUser = async () => null;
  EthWalletService.queueRecaptureWallet = () => {
    queued = true;
    return { started: true };
  };
  try {
    const response = await request(app).post('/api/eth/wallets/7/recapture');
    assert.equal(response.status, 404);
    assert.equal(queued, false);
  } finally {
    EthWallet.findByIdForUser = originalFind;
    EthWalletService.queueRecaptureWallet = originalQueue;
  }
});

test('POST /api/eth/wallets/:id/audits queues a durable optional audit', async () => {
  const EvmAuditService = require('../src/services/EvmAuditService');
  const originalRequest = EvmAuditService.request;
  const calls = [];
  EvmAuditService.request = async (...args) => {
    calls.push(args);
    return { created: true, job: { id: '41', status: 'queued', stage: 'queued' } };
  };
  try {
    const response = await request(app)
      .post('/api/eth/wallets/7/audits')
      .send({ mode: 'full', chain_ids: [100, 10] });
    assert.equal(response.status, 202);
    assert.equal(response.body.created, true);
    assert.equal(response.body.job.status, 'queued');
    assert.deepEqual(calls, [[1, 7, { mode: 'full', requestedChains: [100, 10] }]]);
  } finally {
    EvmAuditService.request = originalRequest;
  }
});

test('POST /api/eth/wallets/:id/audits never widens an invalid chain list', async () => {
  const EvmAuditService = require('../src/services/EvmAuditService');
  const originalRequest = EvmAuditService.request;
  let called = false;
  EvmAuditService.request = async () => { called = true; };
  try {
    const response = await request(app)
      .post('/api/eth/wallets/7/audits')
      .send({ chain_ids: ['base'] });
    assert.equal(response.status, 400);
    assert.equal(called, false);
  } finally {
    EvmAuditService.request = originalRequest;
  }
});

test('POST /api/eth/wallets/:id/audits rejects vacuous or ambiguous scope', async () => {
  for (const body of [
    { mode: 'everything' },
    { chain_ids: [] },
    { chain_ids: [0] },
    { chain_ids: [999] },
    { chain_ids: [999] },
  ]) {
    const response = await request(app).post('/api/eth/wallets/7/audits').send(body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
});

test('GET /api/eth/audits is scoped to the signed-in user', async () => {
  const EvmAudit = require('../src/models/EvmAudit');
  const originalList = EvmAudit.listForUser;
  const calls = [];
  EvmAudit.listForUser = async (...args) => {
    calls.push(args);
    return [{ id: '41', user_id: 1, status: 'complete_with_gaps' }];
  };
  try {
    const response = await request(app).get('/api/eth/audits?wallet_id=7');
    assert.equal(response.status, 200);
    assert.equal(response.body.audits[0].status, 'complete_with_gaps');
    assert.deepEqual(calls, [[1, { walletId: 7, limit: 100 }]]);
  } finally {
    EvmAudit.listForUser = originalList;
  }
});

test('GET /api/eth/audits/:id returns exact enriched evidence without a recent-list cutoff', async () => {
  const EvmAudit = require('../src/models/EvmAudit');
  const originalFind = EvmAudit.findDetailedByIdForUser;
  EvmAudit.findDetailedByIdForUser = async (id, userId) => ({
    id, user_id: userId, scopes: [{ capability: 'wallet_history' }], nonce_audits: [], balance_audits: [],
  });
  try {
    const response = await request(app).get('/api/eth/audits/141');
    assert.equal(response.status, 200);
    assert.equal(response.body.audit.id, 141);
    assert.equal(response.body.audit.scopes[0].capability, 'wallet_history');
  } finally {
    EvmAudit.findDetailedByIdForUser = originalFind;
  }
});

test('POST /api/eth/audits/full queues every owned wallet without cross-user widening', async () => {
  const EvmAuditService = require('../src/services/EvmAuditService');
  const EthWallet = require('../src/models/EthWallet');
  const originalWallets = EthWallet.findAllByUser;
  const originalRequest = EvmAuditService.request;
  EthWallet.findAllByUser = async (userId) => {
    assert.equal(userId, 1);
    return [{ id: 7 }, { id: 8 }];
  };
  const calls = [];
  EvmAuditService.request = async (...args) => {
    calls.push(args);
    return { job: { id: String(args[1]), status: 'queued' } };
  };
  try {
    const response = await request(app).post('/api/eth/audits/full');
    assert.equal(response.status, 202);
    assert.equal(response.body.queued, 2);
    assert.deepEqual(calls, [
      [1, 7, { mode: 'full' }],
      [1, 8, { mode: 'full' }],
    ]);
  } finally {
    EthWallet.findAllByUser = originalWallets;
    EvmAuditService.request = originalRequest;
  }
});

test('GET /api/eth/coverage returns a user-scoped gap summary', async () => {
  const EthFeedCoverage = require('../src/models/EthFeedCoverage');
  const originalFind = EthFeedCoverage.findForUser;
  EthFeedCoverage.findForUser = async (userId) => {
    assert.equal(userId, 1);
    return [
      { wallet_id: 7, chain_id: 1, feed: 'normal', status: 'complete' },
      {
        wallet_id: 7,
        chain_id: 100,
        feed: 'internal',
        status: 'unsupported',
        error_code: 'ETHERSCAN_FEED_UNSUPPORTED',
        error_message: 'trace index incomplete for blocks 0-123',
      },
      { wallet_id: 7, chain_id: 1, feed: 'statesync', status: 'not_applicable' },
    ];
  };
  try {
    const response = await request(app).get('/api/eth/coverage');
    assert.equal(response.status, 200);
    assert.equal(response.body.summary.rows, 3);
    assert.equal(response.body.summary.complete, 1);
    assert.equal(response.body.summary.deferred, 0);
    assert.equal(response.body.summary.unsupported, 1);
    assert.equal(response.body.summary.not_applicable, 1);
    assert.equal(response.body.summary.gaps, 1);
    assert.equal(response.body.coverage[1].chain_name, 'Gnosis Chain');
    assert.equal(response.body.coverage[1].enabled, true);
  } finally {
    EthFeedCoverage.findForUser = originalFind;
  }
});
