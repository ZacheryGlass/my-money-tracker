'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const normalizer = require('../src/services/evmAudit/normalizer');
const MoralisClient = require('../src/services/evmAudit/MoralisClient');
const RpcClient = require('../src/services/evmAudit/RpcClient');
const EvmAuditService = require('../src/services/EvmAuditService');
const EtherscanService = require('../src/services/EtherscanService');
const EvmAudit = require('../src/models/EvmAudit');
const EthWallet = require('../src/models/EthWallet');
const SecretsService = require('../src/services/SecretsService');
const database = require('../src/config/database');
const {
  TOPICS, effectsFromInternalObservations, effectsFromRpc,
} = require('../src/services/evmAudit/effectDecoder');
const chains = require('../src/config/chains');
const {
  matchesLegacyTransfer, matchesIndexedTransfer,
} = require('../src/services/evmAudit/corroboratedIdentity');
const {
  BASE_EXCLUSION_ENDPOINTS, INDEPENDENT_ENUMERATION_PROVIDERS,
} = require('../src/services/evmAudit/completionPolicy');

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const CONTRACT = '0x3333333333333333333333333333333333333333';
const HASH = `0x${'ab'.repeat(32)}`;
const BLOCK_HASH = `0x${'cd'.repeat(32)}`;
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const addressTopic = (value) => `0x${value.slice(2).padStart(64, '0')}`;

const context = (chainId = 10) => ({
  jobId: 9,
  subjectId: 3,
  chainId,
  address: WALLET,
  provider: 'consensus-rpc',
  chain: chains.getChain(chainId),
});

function gnosisWorkerHarness(t, runChain, { userKey = null, activeChains = null } = {}) {
  const job = {
    id: 71, user_id: 1, subject_id: 3, requested_wallet_id: 5,
    requested_chains: [100], address: WALLET, mode: 'full',
    credential_generation: null,
  };
  const discoveredSnapshots = [];
  const finishes = [];
  const deferredScopes = [];
  t.mock.method(EvmAudit, 'acquireRunLock', async () => ({ id: 'fixture-lock' }));
  t.mock.method(EvmAudit, 'releaseRunLock', async () => {});
  t.mock.method(EvmAudit, 'claim', async () => true);
  t.mock.method(EvmAudit, 'findById', async () => job);
  t.mock.method(EvmAudit, 'heartbeat', async () => true);
  t.mock.method(EvmAudit, 'credentialGeneration', async () => null);
  t.mock.method(EvmAudit, 'setDiscoveredChains', async (_jobId, _owner, rows) => {
    discoveredSnapshots.push(structuredClone(rows));
  });
  t.mock.method(EvmAudit, 'deferOpenScopes', async (...args) => {
    deferredScopes.push(args);
  });
  t.mock.method(EvmAudit, 'finish', async (_jobId, _owner, status, options) => {
    const result = { status, ...options };
    finishes.push(result);
    return result;
  });
  t.mock.method(SecretsService, 'getUserKey', async () => userKey);
  if (activeChains) t.mock.method(MoralisClient.prototype, 'activeChains', activeChains);
  t.mock.method(EvmAuditService, 'runChain', runChain);
  return {
    execute: () => EvmAuditService.run(job.id),
    discoveredSnapshots,
    finishes,
    deferredScopes,
  };
}

test('history audit enumerates every configured chain', () => {
  const original = process.env.ETH_CHAINS;
  try {
    delete process.env.ETH_CHAINS;
    assert.deepEqual(EvmAuditService.supportedChainIds(), [
      1, 10, 100, 137, 324, 42161, 42170, 59144, 32401,
    ]);
    assert.deepEqual(EvmAuditService.configuredChainIds(), [
      1, 10, 100, 137, 324, 42161, 42170, 59144, 32401,
    ]);
  } finally {
    if (original == null) delete process.env.ETH_CHAINS;
    else process.env.ETH_CHAINS = original;
  }
});

test('bridge audit treats only exact excluded-Base evidence as a scoped limitation', async (t) => {
  const baseEvidence = {
    reason: 'excluded_counterparty_chain', excluded_chain_id: 8453,
    source: {
      type: 'decoded_protocol_identity', protocol: 'optimism', family_version: 'bedrock',
      correlation_key: 'optimism:fixture', identity_fields: { destination_chain_id: '8453' },
    },
    decoder_event: {
      protocol: 'optimism', family_version: 'bedrock', correlation_key: 'optimism:fixture',
      evidence: { identity_fields: { destination_chain_id: '8453' } },
    },
  };
  const bridgeHashes = Array.from(
    { length: 8 }, (_, index) => `0x${String(index + 1).repeat(64)}`
  );
  t.mock.method(database, 'query', async (sql) => {
    assert.match(sql, /bm\.evidence AS movement_evidence/);
    return {
      rows: [
        {
          tx_hash: bridgeHashes[0], category: 'bridge_out', movement_id: '1',
          movement_status: 'unsupported', verification_method: 'protocol_identity',
          movement_evidence: baseEvidence,
        },
        {
          tx_hash: bridgeHashes[1], category: 'bridge_out', movement_id: '2',
          movement_status: 'unsupported', verification_method: 'protocol_identity',
          movement_evidence: {},
        },
        {
          tx_hash: bridgeHashes[2], category: 'bridge_out', movement_id: '3',
          movement_status: 'unsupported', verification_method: 'protocol_identity',
          movement_evidence: { ...baseEvidence, excluded_chain_id: 10 },
        },
        {
          tx_hash: bridgeHashes[3], category: 'bridge_out', movement_id: '4',
          movement_status: 'unsupported', verification_method: 'protocol_identity',
          movement_evidence: { ...baseEvidence, reason: 'unsupported_protocol_path' },
        },
        {
          tx_hash: bridgeHashes[4], category: 'bridge_out', movement_id: '5',
          movement_status: 'unsupported', verification_method: 'protocol_identity',
          movement_evidence: { ...baseEvidence, excluded_chain_id: '8453' },
        },
        {
          tx_hash: bridgeHashes[5], category: 'bridge_out', movement_id: '6',
          movement_status: 'pending', verification_method: 'protocol_identity',
          movement_evidence: baseEvidence,
        },
        {
          tx_hash: bridgeHashes[6], category: 'bridge_out', movement_id: '7',
          movement_status: 'unsupported', verification_method: 'user_verdict',
          movement_evidence: baseEvidence,
        },
        {
          tx_hash: bridgeHashes[7], category: 'bridge_out', movement_id: '8',
          movement_status: 'unsupported', verification_method: 'protocol_identity',
          movement_evidence: {
            reason: 'excluded_counterparty_chain', excluded_chain_id: 8453,
          },
        },
      ],
    };
  });

  const result = await EvmAudit.bridgeAudit(7, 70, 1, 100);

  assert.equal(result.total, 8);
  assert.deepEqual(
    result.unresolved.map((row) => row.transaction_hash),
    bridgeHashes.slice(1)
  );
  assert.equal(result.unresolved[0].movement_references[0].movement_id, '2');
  assert.deepEqual(result.unresolved[0].movement_references[0].evidence, {});
});

test('an exact excluded-Base movement cannot hide a generic unsupported movement', async (t) => {
  const portal = BASE_EXCLUSION_ENDPOINTS.find((endpoint) => endpoint.role === 'portal');
  t.mock.method(database, 'query', async () => ({
    rows: [
      {
        tx_hash: HASH, category: 'bridge_out', movement_id: '1',
        movement_status: 'unsupported', verification_method: 'protocol_identity',
        movement_evidence: {
          reason: 'excluded_counterparty_chain', excluded_chain_id: 8453,
          source: {
            type: 'source_backed_endpoint', chain_id: 1,
            ...portal,
          },
        },
      },
      {
        tx_hash: HASH, category: 'bridge_out', movement_id: '2',
        movement_status: 'unsupported', verification_method: 'protocol_identity',
        movement_evidence: { reason: 'unsupported_protocol_path' },
      },
    ],
  }));

  const result = await EvmAudit.bridgeAudit(7, 70, 1, 100);

  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].movement_status, 'unsupported');
  assert.equal(result.unresolved[0].movement_references.length, 2);
});

test('Gnosis Blockscout fallback completes while retaining the Moralis limitation', async (t) => {
  let runOptions;
  const fixture = gnosisWorkerHarness(t, async (options) => {
    runOptions = options;
    const row = options.discovered.find((entry) => entry.chain_id === 100);
    row.status = 'bounded';
    row.bounded = true;
    return { gaps: 0, deferred: false, unsupported: false, failed: false };
  });

  const result = await fixture.execute();
  assert.equal(result.status, 'complete');
  assert.equal(runOptions.moralis, null);
  assert.equal(runOptions.explorerApiKey, null);
  assert.equal(runOptions.moralisUnavailable.code, 'MORALIS_NOT_CONFIGURED');
  const discovery = fixture.discoveredSnapshots[0][0];
  assert.equal(discovery.source, 'blockscout');
  assert.equal(discovery.status, 'configured');
  assert.deepEqual(discovery.active_discovery, {
    status: 'deferred',
    source: 'moralis',
    error_code: 'MORALIS_NOT_CONFIGURED',
    error_detail: runOptions.moralisUnavailable.detail,
  });
  assert.equal(fixture.finishes.at(-1).errorCode, null);
  assert.equal(fixture.finishes.at(-1).retryAt, null);
});

test('Gnosis falls through to Blockscout after a configured Moralis rate limit', async (t) => {
  let runOptions;
  const retryAt = new Date('2030-01-02T03:04:05.000Z');
  const fixture = gnosisWorkerHarness(t, async (options) => {
    runOptions = options;
    const row = options.discovered.find((entry) => entry.chain_id === 100);
    row.status = 'bounded';
    row.bounded = true;
    return { gaps: 0, deferred: false, unsupported: false, failed: false };
  }, {
    userKey: 'fixture-key',
    activeChains: async () => {
      throw Object.assign(new Error('Moralis fixture throttle'), {
        code: 'MORALIS_RATE_LIMITED', retryAt,
      });
    },
  });

  const result = await fixture.execute();
  assert.equal(result.status, 'complete');
  assert.equal(runOptions.moralis, null);
  assert.equal(runOptions.moralisUnavailable.code, 'MORALIS_RATE_LIMITED');
  assert.equal(runOptions.moralisUnavailable.retryAt, retryAt);
  const discovery = fixture.discoveredSnapshots[0][0];
  assert.equal(discovery.source, 'blockscout');
  assert.equal(discovery.active_discovery.error_code, 'MORALIS_RATE_LIMITED');
  assert.equal(fixture.finishes.at(-1).errorCode, null);
});

test('request upgrades a future Moralis deferral when Gnosis can run on Blockscout', async (t) => {
  const retryAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const deferredJob = {
    id: 88,
    user_id: 7,
    status: 'deferred',
    error_code: 'MORALIS_NOT_CONFIGURED',
    retry_after_at: retryAfter,
    requested_chains: [100],
  };
  const queuedJob = {
    ...deferredJob,
    status: 'queued',
    error_code: null,
    error_detail: null,
    retry_after_at: null,
  };
  let createOptions;
  const queued = [];
  const updates = [];

  t.mock.method(EthWallet, 'findByIdForUser', async () => ({ id: 5, address: WALLET }));
  t.mock.method(EvmAudit, 'credentialGeneration', async () => null);
  t.mock.method(SecretsService, 'getUserKey', async () => null);
  t.mock.method(EvmAudit, 'createOrFindActiveJob', async (_userId, _wallet, options) => {
    createOptions = options;
    return { created: false, job: deferredJob };
  });
  t.mock.method(database, 'query', async (sql, params) => {
    updates.push({ sql, params });
    return { rows: [queuedJob] };
  });
  t.mock.method(EvmAuditService, 'enqueue', (jobId) => queued.push(jobId));

  const result = await EvmAuditService.request(7, 5, {
    mode: 'full', requestedChains: [100],
  });

  assert.equal(Object.hasOwn(createOptions, 'requestedProviders'), false);
  assert.equal(result.job.status, 'queued');
  assert.deepEqual(queued, [88]);
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /error_code = 'MORALIS_NOT_CONFIGURED'/);
  assert.match(updates[0].sql, /retry_after_at > CURRENT_TIMESTAMP/);
  assert.deepEqual(updates[0].params, [88, 7]);
});

test('Gnosis Blockscout fallback deferral preserves retry and provider fields', async (t) => {
  const retryAt = new Date('2030-01-02T03:04:05.000Z');
  const fixture = gnosisWorkerHarness(t, async () => {
    throw Object.assign(new Error('Blockscout fixture throttle'), {
      code: 'BLOCKSCOUT_RATE_LIMITED',
      auditProvider: 'blockscout',
      httpStatus: 429,
      retryAt,
    });
  });

  const result = await fixture.execute();
  assert.equal(result.status, 'deferred');
  assert.equal(result.errorCode, 'BLOCKSCOUT_RATE_LIMITED');
  assert.equal(result.errorDetail, 'Blockscout fixture throttle');
  assert.equal(result.retryAt, retryAt);
  assert.deepEqual(result.progress, { chains_finished: 1, gaps: 1 });
  const [, chainId, failure] = fixture.deferredScopes[0];
  assert.equal(chainId, 100);
  assert.equal(failure.provider, 'blockscout');
  assert.equal(failure.scopeStatus, 'deferred');
  assert.equal(failure.errorCode, 'BLOCKSCOUT_RATE_LIMITED');
  const finalDiscovery = fixture.discoveredSnapshots.at(-1)[0];
  assert.equal(finalDiscovery.status, 'deferred');
  assert.equal(finalDiscovery.error_code, 'BLOCKSCOUT_RATE_LIMITED');
  assert.equal(finalDiscovery.active_discovery.error_code, 'MORALIS_NOT_CONFIGURED');
});

test('chain-level RPC failures remain attributed to consensus RPC', async (t) => {
  const fixture = gnosisWorkerHarness(t, async () => {
    throw Object.assign(new Error('consensus fixture unavailable'), {
      code: 'RPC_TRANSPORT_ERROR', retryAt: new Date('2030-01-02T03:04:05.000Z'),
    });
  });

  const result = await fixture.execute();
  assert.equal(result.status, 'deferred');
  assert.equal(result.errorCode, 'RPC_TRANSPORT_ERROR');
  const [, , failure] = fixture.deferredScopes[0];
  assert.equal(failure.provider, 'consensus-rpc');
  assert.equal(failure.scopeStatus, 'deferred');
});

test('a chain without consensus RPC is deferred without blocking other audit chains', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/EvmAuditService.js'), 'utf8');
  const guard = source.indexOf("provider: 'consensus-rpc'");
  const runnable = source.indexOf('runnable.push(chainId)', guard);
  assert.ok(guard >= 0);
  assert.ok(runnable > guard);
  assert.match(source.slice(guard - 500, runnable + 80), /code: 'RPC_UNSUPPORTED'/);
  assert.match(source.slice(guard - 500, runnable + 80), /continue;/);
});

test('unsupported audit chains become explicit amber scopes without a provider request', async () => {
  const originalUpsertScope = EvmAudit.upsertScope;
  const scopes = [];
  EvmAudit.upsertScope = async (_jobId, scope) => {
    scopes.push(scope);
    return scope;
  };
  try {
    assert.equal(await EvmAuditService.runUnsupportedChain({ job: { id: 7 }, chainId: 32401 }), 1);
    assert.equal(scopes.length, 14);
    assert.ok(scopes.every((scope) => scope.status === 'unsupported'));
    assert.ok(scopes.every((scope) => scope.errorCode === 'NON_EVM_CHAIN'));
  } finally {
    EvmAudit.upsertScope = originalUpsertScope;
  }
});

test('zkSync Era uses bounded split-explorer audit coverage instead of unsupported status', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/EvmAuditService.js'), 'utf8');
  assert.equal(chains.accountApiHistoryProvider(324), 'explorer-composite');
  assert.match(source, /\[324, \{/);
  assert.doesNotMatch(source, /\[324, \{\s*unsupported:/);
});

test('stable evidence hashes ignore object key order but not payload changes', () => {
  assert.equal(normalizer.sha256({ b: 2, a: 1 }), normalizer.sha256({ a: 1, b: 2 }));
  assert.notEqual(normalizer.sha256({ a: 1 }), normalizer.sha256({ a: 2 }));
});

test('finishing an audit casts the status parameter consistently for PostgreSQL', async () => {
  const originalQuery = database.query;
  let sql;
  database.query = async (query) => {
    sql = query;
    return { rows: [{ id: 1, status: 'complete' }] };
  };
  try {
    await EvmAudit.finish(1, 'test-owner', 'complete');
    assert.match(sql, /SET status = \$3::varchar/);
    assert.match(sql, /CASE WHEN \$3::varchar IN/);
    assert.match(sql, /UPDATE evm_audit_scopes sc/);
    assert.match(sql, /sc\.status IN \('queued', 'running'\)/);
  } finally {
    database.query = originalQuery;
  }
});

test('new audit scopes persist unknown provider order instead of SQL NULL', async () => {
  const originalQuery = database.query;
  let sql;
  let params;
  database.query = async (query, queryParams) => {
    sql = query;
    params = queryParams;
    return { rows: [{ id: 1, provider_order: 'unknown' }] };
  };
  try {
    await EvmAudit.upsertScope(1, {
      chainId: 10,
      provider: 'consensus-rpc',
      capability: 'active_chain',
      providerOrder: null,
    });
    assert.equal(params[9], null);
    assert.match(sql, /COALESCE\(\$10, 'unknown'\)/);
    assert.match(sql, /CASE WHEN \$10 IS NULL/);
  } finally {
    database.query = originalQuery;
  }
});

test('source coverage persists unknown provider order without erasing known order', async () => {
  const originalQuery = database.query;
  let sql;
  let params;
  database.query = async (query, queryParams) => {
    sql = query;
    params = queryParams;
    return { rows: [{ id: 1, provider_order: 'unknown' }] };
  };
  try {
    await EvmAudit.acceptCoverage({
      subjectId: 3,
      chainId: 10,
      provider: 'consensus-rpc',
      capability: 'wallet_history',
      fromBlock: 0,
      throughBlock: 1,
      providerOrder: null,
      paginationExhausted: true,
      status: 'complete',
      jobId: 1,
    });
    assert.equal(params[7], null);
    assert.match(sql, /COALESCE\(\$8, 'unknown'\)/);
    assert.match(sql, /CASE WHEN \$8 IS NULL/);
  } finally {
    database.query = originalQuery;
  }
});

test('identity repair keeps its canonical-effect query user-scoped', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/models/EvmAudit.js'), 'utf8');
  const methodStart = source.indexOf('static async repairCorroboratedTransferIdentities');
  const methodEnd = source.indexOf('\n  static async', methodStart + 1);
  const method = source.slice(methodStart, methodEnd);
  assert.match(method, /jo\.job_id = \$1/);
  assert.match(method, /s\.user_id = \$2/);
  assert.match(method, /jobId, userId, subjectId, chainId, throughBlock,/);
  assert.match(method, /o\.provider = ANY\(\$7::text\[\]\)/);
});

test('native-credit duplicate invalidation requires one exact verified log match', async (t) => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/WITH candidates AS/.test(sql)) {
        return { rows: [{ id: 9, subject_id: 3, chain_id: 137, credit_observation_id: 15 }] };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  t.mock.method(database, 'connect', async () => client);
  const count = await EvmAudit.invalidateSupersededNativeCreditEffects(
    1, 3, 137, chains.getChain(137).stateSyncDeposits.contract, 100
  );
  assert.equal(count, 1);
  const statement = queries.find((query) => /WITH candidates AS/.test(query.sql));
  assert.deepEqual(statement.params, [
    1, 3, 137, chains.getChain(137).stateSyncDeposits.contract, 100,
  ]);
  assert.match(statement.sql, /subject\.user_id = \$1/);
  assert.match(statement.sql, /internal\.effect_type = 'internal'/);
  assert.match(statement.sql, /internal\.resolution_status = 'provisional'/);
  assert.match(statement.sql, /credit\.effect_type = 'native_credit'/);
  assert.match(statement.sql, /credit\.resolution_status = 'verified'/);
  assert.match(statement.sql, /proof\.provider = 'consensus-rpc'/);
  assert.match(statement.sql, /proof\.evidence_kind = 'log'/);
  assert.match(statement.sql, /source_log_index'[\s\S]*credit\.log_index/);
  assert.match(statement.sql, /HAVING COUNT\(credit\.id\) = 1/);
  assert.ok(queries.some((query) => /INSERT INTO evm_effect_evidence/.test(query.sql)));
});

test('Moralis history keeps receipt, log, internal and token evidence independently', () => {
  const observations = normalizer.historyObservations(context(100), {
    hash: HASH,
    block_number: '10',
    block_hash: BLOCK_HASH,
    transaction_index: '2',
    receipt_status: '1',
    logs: [{ log_index: '4', address: CONTRACT, topics: [], data: '0x' }],
    internal_transactions: [{ from: OTHER, to: WALLET, value: '7' }],
    erc20_transfers: [{ log_index: '5', from_address: OTHER, to_address: WALLET, value: '8' }],
    nft_transfers: [{ log_index: '6', contract_type: 'ERC1155', token_id: '9' }],
  });
  assert.deepEqual(observations.map((row) => row.evidenceKind), [
    'transaction', 'receipt', 'log', 'internal_trace', 'erc20_transfer', 'erc1155_transfer',
  ]);
  assert.match(observations[3].providerObjectKey, /provider:/,
    'an internal call without trace coordinates stays provider-scoped');
});

test('Blockscout account-feed evidence preserves internal trace identity and raw rows', () => {
  const rows = normalizer.explorerFeedObservations({ ...context(324), provider: 'blockscout' }, 'internal', [{
    hash: HASH, blockNumber: '12', blockHash: BLOCK_HASH, transactionIndex: '3',
    traceId: '3_1', from: OTHER, to: WALLET, value: '7', isError: '0',
  }]);
  assert.equal(rows[0].provider, 'blockscout');
  assert.equal(rows[0].evidenceKind, 'internal_trace');
  assert.deepEqual(rows[0].traceAddress, [3, 1]);
  assert.equal(rows[0].payload.value, '7');
});

test('stored state-sync legs retain native-credit log identity in the evidence plane', () => {
  const chain = chains.getChain(137);
  const rows = normalizer.legacyTransferObservations({
    ...context(137), provider: 'existing-ledger', chain,
  }, [{
    transfer_type: 'internal', tx_hash: HASH, ordinal: 0, block_number: 10,
    from_address: chain.stateSyncDeposits.contract, to_address: WALLET,
    value_wei: '17', source_log_index: 7, source_trace_address: null,
    is_error: false,
  }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].evidenceKind, 'native_credit');
  assert.equal(rows[0].logIndex, 7);
  assert.equal(rows[0].payload.native_credit, true);
  assert.equal(rows[0].providerObjectKey, `legacy:native-credit:${HASH}:7`);
  const effects = effectsFromInternalObservations(context(137), [{
    id: 19,
    provider: rows[0].provider,
    evidence_kind: rows[0].evidenceKind,
    provider_object_key: rows[0].providerObjectKey,
    tx_hash: rows[0].txHash,
    log_index: rows[0].logIndex,
    payload_json: rows[0].payload,
  }]);
  assert.equal(effects[0].effectType, 'native_credit');
  assert.equal(effects[0].effectKey, `native-credit:${HASH}:7`);
});

test('ordinary stored internal legs keep execution-trace identity', () => {
  const rows = normalizer.legacyTransferObservations({
    ...context(137), provider: 'existing-ledger', chain: chains.getChain(137),
  }, [{
    transfer_type: 'internal', tx_hash: HASH, ordinal: 0, block_number: 10,
    from_address: OTHER, to_address: WALLET, value_wei: '17',
    source_log_index: null, source_trace_address: [2, 1], is_error: false,
  }]);
  assert.equal(rows[0].evidenceKind, 'internal_trace');
  assert.deepEqual(rows[0].traceAddress, [2, 1]);
});

test('Blockscout normal and token feeds use the additive account-feed evidence kind', () => {
  const feeds = ['normal', 'erc20', 'erc721', 'erc1155'];
  for (const feed of feeds) {
    const [observation] = normalizer.explorerFeedObservations(
      { ...context(324), provider: 'blockscout' },
      feed,
      [{ hash: HASH, blockNumber: '10', logIndex: '2', tokenID: '9' }]
    );
    assert.equal(observation.evidenceKind, 'account_feed');
  }
  const migration = fs.readFileSync(
    path.join(__dirname, '../migrations/078_evm_account_feed_evidence.sql'), 'utf8'
  );
  assert.match(migration, /'account_feed'/);
});

test('native-credit observations are accepted by the durable evidence constraint', () => {
  const [observation] = normalizer.explorerFeedObservations(
    { ...context(137), provider: 'blockscout' },
    'internal',
    [{
      hash: HASH,
      blockNumber: '10',
      blockHash: BLOCK_HASH,
      transactionIndex: '2',
      logIndex: '3',
      nativeCredit: true,
      from: OTHER,
      to: WALLET,
      value: '7',
    }]
  );
  assert.equal(observation.evidenceKind, 'native_credit');
  const migration = fs.readFileSync(
    path.join(__dirname, '../migrations/095_evm_native_credit_evidence.sql'), 'utf8'
  );
  assert.match(migration, /pg_get_constraintdef\(c\.oid\) LIKE '%native_credit%'/);
  assert.match(migration, /'account_feed', 'native_credit'/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS evm_provider_observations_evidence_kind_check/);
});

test('zkSync audit provenance follows the split native and token providers', () => {
  assert.equal(chains.accountApiHistoryProvider(324), 'explorer-composite');
  assert.equal(chains.accountApiProviderForAction(324, 'txlist'), 'zksync explorer');
  assert.equal(
    chains.accountApiProviderForAction(324, 'txlistinternal'),
    'zksync explorer'
  );
  assert.equal(chains.accountApiProviderForAction(324, 'tokentx'), 'blockscout');
  assert.equal(chains.accountApiProviderForAction(324, 'tokennfttx'), 'blockscout');
  assert.deepEqual(chains.accountApiProviderManifest(324), {
    active_chain: 'explorer-composite',
    wallet_history: 'explorer-composite',
    coverage_boundary: 'explorer-composite',
    native_indexed_head: 'zksync explorer',
    token_indexed_head: 'blockscout',
    normal: 'zksync explorer',
    internal: 'zksync explorer',
    erc20: 'blockscout',
    erc721: 'blockscout',
    erc1155: 'blockscout',
  });
  assert.equal(EvmAuditService._explorerProviderFromError(324, {
    response: { config: { url: 'https://zksync.blockscout.com/api/v2/blocks' } },
  }, 'getblockreward'), 'blockscout');
  assert.equal(EvmAuditService._explorerProviderFromError(324, {
    message: 'official indexed head fixture failure',
  }, 'getblockreward'), 'zksync explorer');
  assert.equal(EvmAuditService._auditProviderForError(324, {
    code: 'RPC_TRANSPORT_ERROR',
  }), 'consensus-rpc');
  assert.equal(EvmAuditService._auditProviderForError(324, {
    code: 'RPC_TRACE_SCAN_BUDGET_EXHAUSTED',
  }), 'trace-rpc');
  assert.equal(EvmAuditService._auditProviderForError(324, {
    code: 'ZKSYNC_EXPLORER_RATE_LIMITED', auditProvider: 'zksync explorer',
  }), 'zksync explorer');
});

test('coverage timestamp validation retains the zkSync provider that answered', async (t) => {
  t.mock.method(EtherscanService, '_rpcRequest', async () => null);
  t.mock.method(EtherscanService, '_request', async () => ({ timestamp: 'not-hex' }));
  await assert.rejects(
    EtherscanService.coverageBoundary(null, 324, 987654321),
    (error) => {
      assert.equal(error.code, 'ETHERSCAN_API_ERROR');
      assert.equal(error.provider, 'Blockscout');
      assert.equal(error.auditProvider, 'blockscout');
      return true;
    }
  );
});

test('zkSync indexed-head validation retains consensus and Blockscout identities', async (t) => {
  t.mock.method(EtherscanService, '_rpcRequest', async () => 'not-hex');
  await assert.rejects(EtherscanService._latestBlockNumber(null, 324), (error) => {
    assert.equal(error.auditProvider, 'consensus-rpc');
    assert.match(String(error.provider), /JSON-RPC/);
    return true;
  });
});

test('zkSync invalid token-index head remains attributed to Blockscout', async (t) => {
  t.mock.method(require('axios'), 'get', async () => {
    throw Object.assign(new Error('fixture V2 route unavailable'), {
      response: { status: 400 },
    });
  });
  t.mock.method(EtherscanService, '_request', async () => 'not-a-block');
  await assert.rejects(EtherscanService._blockscoutLatestBlockNumber(
    null, 324, chains.getChain(324).accountApi
  ), (error) => {
    assert.equal(error.auditProvider, 'blockscout');
    assert.equal(error.provider, 'Blockscout');
    return true;
  });
});

test('Blockscout internal-status hydration attributes malformed traces to consensus RPC', async (t) => {
  t.mock.method(EtherscanService, '_rpcBatchRequest', async () => [[]]);
  await assert.rejects(EtherscanService._hydrateBlockscoutV2InternalStatus([{
    hash: HASH,
  }], 100), (error) => {
    assert.equal(error.code, 'ETHERSCAN_API_ERROR');
    assert.equal(error.auditProvider, 'consensus-rpc');
    assert.match(String(error.provider), /JSON-RPC/);
    return true;
  });
});

test('transient explorer failures defer instead of becoming permanent gaps', () => {
  assert.equal(EvmAuditService._isExplorerTransient({ response: { status: 408 } }), true);
  assert.equal(EvmAuditService._isExplorerTransient({ response: { status: 503 } }), true);
  assert.equal(EvmAuditService._isExplorerTransient({ code: 'EAI_AGAIN' }), true);
  assert.equal(EvmAuditService._isExplorerTransient({ response: { status: 400 } }), false);
});

test('standing explorer feed limitations defer only that chain', () => {
  assert.equal(EvmAuditService._isStandingExplorerLimitation({
    code: 'ETHERSCAN_FEED_UNSUPPORTED',
  }), true);
  assert.equal(EvmAuditService._isStandingExplorerLimitation({
    code: 'ETHERSCAN_CHAIN_UNAVAILABLE',
  }), true);
  assert.equal(EvmAuditService._isStandingExplorerLimitation({
    code: 'ETHERSCAN_FEED_FAILED',
  }), false);
  assert.equal(EvmAuditService._isStandingExplorerLimitation({
    code: 'BLOCKSCOUT_FEED_FAILED',
    message: 'Blockscout does not serve txlistinternal: Some internal transactions within this block range have not yet been processed',
  }), true);
  const source = fs.readFileSync(
    path.join(__dirname, '../src/services/EvmAuditService.js'), 'utf8'
  );
  assert.match(source, /deferOpenScopes\(job\.id, chainId/);
  assert.match(source, /for \(const chainId of runnable\)[\s\S]*?try \{[\s\S]*?runChain/);
  assert.match(source, /scopeStatus: standing \? 'unsupported' : deferred \? 'deferred' : 'failed'/);
  assert.match(source, /capabilities: AUDIT_CAPABILITIES/);
  assert.match(source, /isStandingExplorerLimitation\(error\) \? `\$\{prefix\}_CHAIN_UNAVAILABLE`/);
  assert.match(source, /failed: !deferred && !standing/);
});

test('required capability proof excludes the existing-ledger projection', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/models/EvmAudit.js'), 'utf8');
  const start = source.indexOf('static async requiredScopeGapCount');
  const end = source.indexOf('static async provisionalEffectCount', start);
  assert.ok(start >= 0 && end > start);
  const section = source.slice(start, end);
  assert.deepEqual(INDEPENDENT_ENUMERATION_PROVIDERS, [
    'moralis', 'blockscout', 'etherscan', 'zksync explorer', 'trace-rpc',
  ]);
  assert.equal(INDEPENDENT_ENUMERATION_PROVIDERS.includes('existing-ledger'), false);
  assert.match(section, /sc\.provider = ANY\(\$3::text\[\]\)/);
});

test('consensus canonicalization retains failed mined outgoing transactions and gas', () => {
  const transaction = {
    hash: HASH, blockNumber: '0xa', blockHash: BLOCK_HASH, transactionIndex: '0x2',
    from: WALLET, to: OTHER, nonce: '0x7', value: '0x0', input: '0xdeadbeef',
    type: '0x2', gas: '0x5208', gasPrice: '0x2',
  };
  const receipt = { status: '0x0', gasUsed: '0x5208', effectiveGasPrice: '0x3', logs: [] };
  const canonical = normalizer.transactionFromRpc(context(), transaction, receipt, 44);
  assert.equal(canonical.receiptStatus, 0);
  assert.equal(canonical.signedness, 'user_signed');
  const effects = effectsFromRpc(context(), transaction, receipt);
  assert.deepEqual(effects.map((effect) => effect.effectType), ['gas']);
  assert.equal(effects[0].valueUnits, String(21000n * 3n));
});

test('ordinary inbound transactions are externally signed and do not become nonce uncertainty', () => {
  const canonical = normalizer.transactionFromRpc(context(), {
    hash: HASH, blockNumber: '0xa', blockHash: BLOCK_HASH, transactionIndex: '0x2',
    from: OTHER, to: WALLET, nonce: '0x4', value: '0x1', input: '0x',
    type: '0x2', gas: '0x5208', gasPrice: '0x2',
  }, { status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x3', logs: [] }, 44);
  assert.equal(canonical.signedness, 'external_signed');
});

test('a reverted value-bearing transaction emits gas but no native effect', () => {
  const transaction = {
    hash: HASH, from: WALLET, to: OTHER, value: '0xde0b6b3a7640000', gasPrice: '0x2',
  };
  const effects = effectsFromRpc(context(), transaction, {
    status: '0x0', gasUsed: '0x5208', effectiveGasPrice: '0x3', logs: [],
  });
  assert.deepEqual(effects.map((effect) => effect.effectType), ['gas']);
});

test('internal effects remain provisional unless Moralis and stored evidence match unambiguously', () => {
  const payload = { from: OTHER, to: WALLET, value: '7' };
  const moralis = {
    id: 11, provider: 'moralis', provider_object_key: `internal:${HASH}:provider:a`,
    tx_hash: HASH, trace_address: null, payload_json: payload,
  };
  const provisional = effectsFromInternalObservations(context(100), [moralis]);
  assert.equal(provisional[0].effectType, 'internal');
  assert.equal(provisional[0].resolutionStatus, 'provisional');
  const matched = effectsFromInternalObservations(context(100), [moralis, {
    id: 12, provider: 'existing-ledger', provider_object_key: `legacy:internal:${HASH}:0`,
    tx_hash: HASH, trace_address: null,
    payload_json: { from_address: OTHER, to_address: WALLET, value_wei: '7', is_error: false },
  }]);
  assert.equal(matched[0].resolutionStatus, 'provisional',
    'amount and counterparties cannot substitute for trace identity');
});

test('Blockscout internal evidence can corroborate the existing ledger when Moralis is unavailable', () => {
  const payload = { from: OTHER, to: WALLET, value: '7', isError: '0' };
  const blockscout = {
    id: 11, provider: 'blockscout', provider_object_key: `account:internal:${HASH}:3`,
    tx_hash: HASH, trace_address: [3, 1], payload_json: payload,
  };
  const ledger = {
    id: 12, provider: 'existing-ledger', provider_object_key: `legacy:internal:${HASH}:0`,
    tx_hash: HASH, trace_address: [3, 1],
    payload_json: { from_address: OTHER, to_address: WALLET, value_wei: '7', is_error: false },
  };
  const effects = effectsFromInternalObservations(context(324), [blockscout, ledger]);
  assert.equal(effects[0].resolutionStatus, 'verified');
  assert.deepEqual(effects[0].evidenceObservationIds, [11, 12]);
});

test('zkSync Explorer internal evidence can corroborate the existing ledger', () => {
  const explorer = {
    id: 21, provider: 'zksync explorer', provider_object_key: `account:internal:${HASH}:3`,
    tx_hash: HASH, trace_address: [3, 1],
    payload_json: { from: OTHER, to: WALLET, value: '7', isError: '0' },
  };
  const ledger = {
    id: 22, provider: 'existing-ledger', provider_object_key: `legacy:internal:${HASH}:0`,
    tx_hash: HASH, trace_address: [3, 1],
    payload_json: { from_address: OTHER, to_address: WALLET, value_wei: '7', is_error: false },
  };
  const effects = effectsFromInternalObservations(context(324), [explorer, ledger]);
  assert.equal(effects[0].resolutionStatus, 'verified');
  assert.deepEqual(effects[0].evidenceObservationIds, [21, 22]);
});

test('Etherscan internal evidence is selected and native-credit logs retain log identity', () => {
  const etherscan = {
    id: 14, provider: 'etherscan', provider_object_key: `account:internal:${HASH}:0`,
    tx_hash: HASH, trace_address: [0],
    payload_json: { from: OTHER, to: WALLET, value: '9', isError: '0' },
  };
  const effects = effectsFromInternalObservations(context(1), [etherscan]);
  assert.equal(effects.length, 1);
  assert.equal(effects[0].effectType, 'internal');

  const nativeCredit = {
    id: 15, provider: 'etherscan', evidence_kind: 'native_credit', tx_hash: HASH,
    log_index: 7, payload_json: {
      native_credit: true, from: OTHER, to: WALLET, value: '11', log_index: '7',
    },
  };
  const nativeEffects = effectsFromInternalObservations(context(100), [nativeCredit]);
  assert.equal(nativeEffects[0].effectType, 'native_credit');
  assert.equal(nativeEffects[0].effectKey, `native-credit:${HASH}:7`);
});

test('failed Blockscout internal traces never become economic effects', () => {
  const effects = effectsFromInternalObservations(context(324), [{
    id: 13, provider: 'blockscout', tx_hash: HASH, trace_address: [3, 1],
    payload_json: { from: OTHER, to: WALLET, value: '7', isError: '1' },
  }]);
  assert.deepEqual(effects, []);
});

test('OP Stack protocol deposits never consume the user nonce sequence', () => {
  const canonical = normalizer.transactionFromRpc(context(), {
    hash: HASH, blockNumber: '0xa', blockHash: BLOCK_HASH, transactionIndex: '0x0',
    from: '0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001', to: WALLET,
    nonce: '0x0', value: '0x1', input: '0x', type: '0x7e', gas: '0x0', gasPrice: '0x0',
  }, { status: '0x1', gasUsed: '0x0', effectiveGasPrice: '0x0', logs: [] }, 1);
  assert.equal(canonical.signedness, 'protocol_system');
});

test('OP Stack deposit mint survives failed execution and is separate from call value', () => {
  const transaction = {
    hash: HASH, from: WALLET, to: OTHER, value: '0x5', mint: '0x7', type: '0x7e', gasPrice: '0x1',
  };
  const effects = effectsFromRpc(context(), transaction, {
    status: '0x0', gasUsed: '0x1', effectiveGasPrice: '0x1', logs: [],
  });
  assert.deepEqual(effects.map((effect) => [effect.effectKey, effect.valueUnits]), [
    [`protocol-mint:${HASH}`, '7'],
  ]);
});

test('ERC-20, ERC-721, and ERC-1155 receipt effects use log identity without merging ids', () => {
  const transaction = { hash: HASH, from: OTHER, to: CONTRACT, value: '0x0', gasPrice: '0x1' };
  const batchData = `0x${word(64)}${word(160)}${word(2)}${word(7)}${word(8)}${word(2)}${word(70)}${word(80)}`;
  const receipt = { gasUsed: '0x0', logs: [
    { logIndex: '0x1', address: CONTRACT, topics: [TOPICS.transfer, addressTopic(OTHER), addressTopic(WALLET)], data: `0x${word(5)}` },
    { logIndex: '0x2', address: CONTRACT, topics: [TOPICS.transfer, addressTopic(OTHER), addressTopic(WALLET), `0x${word(6)}`], data: '0x' },
    { logIndex: '0x3', address: CONTRACT, topics: [TOPICS.transferBatch, addressTopic(OTHER), addressTopic(OTHER), addressTopic(WALLET)], data: batchData },
  ] };
  const effects = effectsFromRpc(context(), transaction, receipt);
  assert.deepEqual(effects.map((effect) => effect.effectType), ['erc20', 'erc721', 'erc1155', 'erc1155']);
  assert.equal(new Set(effects.map((effect) => effect.effectKey)).size, 4);
});

test('Moralis Retry-After supports seconds and dates without exposing the key', () => {
  assert.equal(MoralisClient.parseRetryAfter('1.5'), 1500);
  assert.equal(MoralisClient.parseRetryAfter('junk'), null);
  assert.throws(() => new MoralisClient(null), (error) => error.code === 'MORALIS_NOT_CONFIGURED');
});

test('Moralis pagination advances opaque cursors and exhausts exactly once', async () => {
  const originalFetch = global.fetch;
  const seen = [];
  global.fetch = async (url) => {
    const parsed = new URL(url);
    seen.push(parsed.searchParams.get('cursor'));
    const cursor = parsed.searchParams.get('cursor');
    return new Response(JSON.stringify(cursor
      ? { result: [{ hash: `0x${'02'.repeat(32)}` }], cursor: null }
      : { result: [{ hash: `0x${'01'.repeat(32)}` }], cursor: 'opaque-next' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const pages = [];
    for await (const page of new MoralisClient('test-key', { spacingMs: 0 }).walletHistoryPages(
      WALLET, { chain: 'gnosis', fromBlock: 0, throughBlock: 10 }
    )) pages.push(page);
    assert.deepEqual(seen, [null, 'opaque-next']);
    assert.deepEqual(pages.map((page) => [page.cursorIn, page.cursorOut]), [
      [null, 'opaque-next'], ['opaque-next', null],
    ]);
    assert.match(pages[0].rawText, /opaque-next/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Moralis JSON parsing preserves large numeric token quantities', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(
    '{"result":[{"value":650000000000000000}],"cursor":null}',
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
  try {
    const response = await new MoralisClient('test-key', { spacingMs: 0 })
      .activeChains(WALLET, ['gnosis']);
    assert.equal(response.body.result[0].value, '650000000000000000');
    assert.deepEqual(response.body.result[0].__evm_json_numeric_fields, ['value']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Moralis plan quota exhaustion is deferred instead of reported as bad credentials', async () => {
  const originalFetch = global.fetch;
  const attempts = [];
  global.fetch = async () => new Response(
    JSON.stringify({ message: 'Validation service blocked: Your plan: free-plan-daily total included usage has been consumed' }),
    { status: 401, headers: { 'content-type': 'application/json' } }
  );
  try {
    await assert.rejects(
      new MoralisClient('test-key', {
        spacingMs: 0,
        onFailedAttempt: async (attempt) => attempts.push(attempt),
      }).activeChains(WALLET, ['gnosis']),
      (error) => error.code === 'MORALIS_QUOTA_EXHAUSTED'
        && error.retryAt instanceof Date
    );
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].errorCode, 'MORALIS_QUOTA_EXHAUSTED');
    assert.equal(attempts[0].outcome, 'deferred');
  } finally {
    global.fetch = originalFetch;
  }
});

test('Moralis paused usage preserves the plan limitation while invalid keys remain authentication failures', async () => {
  const originalFetch = global.fetch;
  try {
    for (const scenario of [
      { message: 'Your Moralis Free usage is paused. Upgrade to resume usage.', code: 'MORALIS_QUOTA_EXHAUSTED', outcome: 'deferred' },
      { message: 'API key is invalid', code: 'MORALIS_AUTH_FAILED', outcome: 'failed' },
    ]) {
      const attempts = [];
      let requests = 0;
      global.fetch = async () => {
        requests += 1;
        return new Response(JSON.stringify({ message: scenario.message }), {
          status: 401, headers: { 'content-type': 'application/json' },
        });
      };
      await assert.rejects(new MoralisClient('test-key', {
        spacingMs: 0, onFailedAttempt: async (attempt) => attempts.push(attempt),
      }).activeChains(WALLET, ['gnosis']), (error) => {
        assert.equal(error.code, scenario.code);
        if (scenario.outcome === 'deferred') {
          assert.match(error.message, /plan usage is paused/);
          assert.doesNotMatch(error.message, /daily|credential/);
        }
        return true;
      });
      assert.equal(requests, 1);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].outcome, scenario.outcome);
      assert.equal(attempts[0].errorCode, scenario.code);
      assert.equal(attempts[0].responseJson.message, scenario.message);
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test('Moralis requests have an explicit deadline even when fetch never settles', async () => {
  const originalFetch = global.fetch;
  const signals = [];
  global.fetch = (_url, { signal }) => {
    signals.push(signal);
    return new Promise(() => {});
  };
  try {
    await assert.rejects(
      new MoralisClient('test-key', { spacingMs: 0, requestTimeoutMs: 1, requestTimeoutGraceMs: 0 })
        .activeChains(WALLET, ['gnosis']),
      (error) => error.code === 'MORALIS_TRANSPORT_ERROR'
        && /deadline|request failed/.test(error.message)
    );
    assert.equal(signals.length, 1, 'a non-cooperative request must not be retried while pending');
    assert.equal(signals[0].aborted, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Moralis request deadlines cover body reads and abort before retrying', async () => {
  const originalFetch = global.fetch;
  const signals = [];
  global.fetch = async (_url, { signal }) => {
    signals.push(signal);
    return {
      ok: true,
      headers: new Headers(),
      text: () => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    };
  };
  try {
    await assert.rejects(
      new MoralisClient('test-key', { spacingMs: 0, requestTimeoutMs: 1, requestTimeoutGraceMs: 0 })
        .activeChains(WALLET, ['gnosis']),
      (error) => error.code === 'MORALIS_TRANSPORT_ERROR'
    );
    assert.equal(signals.length, 1, 'a hard deadline must not overlap another attempt');
    assert.ok(signals.every((signal) => signal.aborted));
  } finally {
    global.fetch = originalFetch;
  }
});

test('deferred audits can be reopened after a credential generation change', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/models/EvmAudit.js'), 'utf8');
  assert.match(source, /activeJob\.status === 'deferred'/);
  assert.match(source, /startsWith\('MORALIS_'\)/);
  assert.match(source, /errorCode === 'ETHERSCAN_NOT_CONFIGURED'/);
  assert.match(source, /etherscanConfigured/);
  assert.match(source, /etherscanCredentialReady/);
  assert.match(source, /SET status = 'queued'/);
  assert.match(source, /credential_generation = \$2/);
  assert.match(source, /deferredProviderGenerationChanged/);
  assert.match(source, /credentialChanged/);
  assert.match(source, /retry_after_at = NULL/);
  assert.match(source, /error_code = NULL/);
});

test('a deferred narrow audit can be widened to full without bypassing cooldown', async (t) => {
  const originalConnect = database.connect;
  const originalEnsureSubject = EvmAudit.ensureSubject;
  const calls = [];
  const narrow = {
    id: 44,
    status: 'deferred',
    mode: 'incremental',
    requested_chains: [1],
    error_code: 'MORALIS_QUOTA_EXHAUSTED',
    retry_after_at: new Date(Date.now() + 60_000),
  };
  const widened = { ...narrow, mode: 'full', requested_chains: [1, 42161] };
  const partialScope = {
    provider: 'moralis', provider_cursor: 'cursor-17',
    requested_from_block: 123, requested_through_block: 456,
    requested_through_hash: `0x${'ef'.repeat(32)}`,
    pagination_exhausted: true,
  };
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM evm_audit_jobs/.test(sql) && /FOR UPDATE/.test(sql)) return { rows: [narrow] };
      if (/SET mode = 'full'/.test(sql)) return { rows: [widened] };
      if (/UPDATE evm_audit_scopes/.test(sql)) {
        Object.assign(partialScope, {
          status: 'queued', provider_cursor: null,
          requested_from_block: 0, requested_through_block: null,
          requested_through_hash: null, pagination_exhausted: false,
          error_code: null, error_detail: null,
        });
        return { rows: [partialScope] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  t.after(() => {
    database.connect = originalConnect;
    EvmAudit.ensureSubject = originalEnsureSubject;
  });
  database.connect = async () => client;
  EvmAudit.ensureSubject = async () => ({ id: 8, address: WALLET });

  const result = await EvmAudit.createOrFindActiveJob(7, { id: 3, address: WALLET }, {
    mode: 'full', requestedChains: [1, 42161], credentialGeneration: null,
  });

  assert.equal(result.created, false);
  assert.equal(result.job.mode, 'full');
  assert.deepEqual(result.job.requested_chains, [1, 42161]);
  assert.equal(result.job.status, 'deferred');
  const update = calls.find(({ sql }) => /SET mode = 'full'/.test(sql));
  assert.ok(update);
  assert.match(update.sql, /status <> 'running'/);
  const reset = calls.find(({ sql }) => /UPDATE evm_audit_scopes/.test(sql));
  assert.ok(reset);
  assert.match(reset.sql, /requested_from_block = CASE WHEN provider = 'consensus-rpc' THEN NULL ELSE 0 END/);
  assert.match(reset.sql, /provider_cursor = NULL/);
  assert.match(reset.sql, /pagination_exhausted = FALSE/);
  assert.match(reset.sql, /provider <> 'existing-ledger'/);
  assert.equal(partialScope.provider_cursor, null);
  assert.equal(partialScope.requested_from_block, 0);
  assert.equal(partialScope.pagination_exhausted, false);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

async function requestAgainstDeferredBroadJob(t, {
  activeJob,
  requestedChains,
}) {
  const originalConnect = database.connect;
  const originalEnsureSubject = EvmAudit.ensureSubject;
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM evm_audit_jobs/.test(sql) && /FOR UPDATE/.test(sql)) {
        return { rows: [activeJob] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  t.after(() => {
    database.connect = originalConnect;
    EvmAudit.ensureSubject = originalEnsureSubject;
  });
  database.connect = async () => client;
  EvmAudit.ensureSubject = async () => ({ id: 8, address: WALLET });

  const result = await EvmAudit.createOrFindActiveJob(7, { id: 3, address: WALLET }, {
    mode: 'incremental', requestedChains,
  });
  return { result, calls };
}

test('a narrower request cannot bypass a deferred broad cooldown when scope evidence is absent', async (t) => {
  const retryAfter = new Date(Date.now() + 60_000);
  const activeJob = {
    id: 44,
    status: 'deferred',
    mode: 'full',
    requested_chains: [1, 100],
    error_code: 'MORALIS_QUOTA_EXHAUSTED',
    retry_after_at: retryAfter,
  };
  const { result, calls } = await requestAgainstDeferredBroadJob(t, {
    activeJob,
    requestedChains: [100],
  });

  assert.equal(result.created, false);
  assert.equal(result.job, activeJob);
  assert.equal(result.job.retry_after_at, retryAfter);
  assert.equal(calls.some(({ sql }) => /FROM evm_audit_scopes/.test(sql)), false);
  assert.equal(calls.some(({ sql }) => /SET status = 'cancelled'/.test(sql)), false);
  assert.equal(calls.some(({ sql }) => /INSERT INTO evm_audit_jobs/.test(sql)), false);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('a complete-looking scope subset cannot supersede a deferred broad job', async (t) => {
  const activeJob = {
    id: 44,
    status: 'deferred',
    mode: 'full',
    requested_chains: [1, 100],
    error_code: 'MORALIS_QUOTA_EXHAUSTED',
    retry_after_at: new Date(Date.now() + 60_000),
  };
  const { result, calls } = await requestAgainstDeferredBroadJob(t, {
    activeJob,
    requestedChains: [1],
  });

  assert.equal(result.created, false);
  assert.equal(result.job, activeJob);
  assert.equal(calls.some(({ sql }) => /FROM evm_audit_scopes/.test(sql)), false);
  assert.equal(calls.some(({ sql }) => /SET status = 'cancelled'/.test(sql)), false);
  assert.equal(calls.some(({ sql }) => /INSERT INTO evm_audit_jobs/.test(sql)), false);
});

test('an apparently unrelated provider deferral cannot be bypassed by narrowing', async (t) => {
  const activeJob = {
    id: 44,
    status: 'deferred',
    mode: 'full',
    requested_chains: [1, 100],
    error_code: 'MORALIS_QUOTA_EXHAUSTED',
    error_detail: 'Moralis deferred while Blockscout remains configured.',
    retry_after_at: new Date(Date.now() + 60_000),
  };
  const { result, calls } = await requestAgainstDeferredBroadJob(t, {
    activeJob,
    requestedChains: [100],
  });

  assert.equal(result.created, false);
  assert.equal(result.job, activeJob);
  assert.equal(calls.some(({ sql }) => /FROM evm_audit_scopes/.test(sql)), false);
  assert.equal(calls.some(({ sql }) => /SET status = 'cancelled'/.test(sql)), false);
  assert.equal(calls.some(({ sql }) => /INSERT INTO evm_audit_jobs/.test(sql)), false);
});


test('same-credential deferred retries preserve provider cooldown', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/EvmAuditService.js'), 'utf8');
  assert.match(source, /if \(result\.job\.status !== 'deferred'\) this\.enqueue\(result\.job\.id\);/);
});

test('audit claims cannot bypass a deferred retry deadline', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/models/EvmAudit.js'), 'utf8');
  assert.match(source, /j\.status <> 'deferred'/);
  assert.match(source, /j\.retry_after_at <= CURRENT_TIMESTAMP/);
});

test('consensus RPC requires matching receipt identity and canonical block membership', async () => {
  const rpc = new RpcClient(10, { spacingMs: 0 });
  rpc.requestWithEvidence = async (method, params) => {
    const result = {
      eth_getTransactionByHash: { hash: HASH, blockNumber: '0xa', blockHash: BLOCK_HASH },
      eth_getTransactionReceipt: { transactionHash: HASH, blockNumber: '0xa', blockHash: BLOCK_HASH },
      eth_getBlockByNumber: { number: '0xa', hash: BLOCK_HASH },
    }[method];
    const rawText = JSON.stringify({ jsonrpc: '2.0', id: 1, result });
    return {
      result, rawText, responseJson: JSON.parse(rawText), responseSha256: normalizer.sha256(rawText),
      requestId: null, method, params,
    };
  };
  const result = await rpc.transactionAndReceipt(HASH);
  assert.equal(result.block.hash, BLOCK_HASH);
  assert.equal(result.evidence.length, 3);
  rpc.requestWithEvidence = async (method, params) => {
    const result = {
      eth_getTransactionByHash: { hash: HASH, blockNumber: '0xa', blockHash: BLOCK_HASH },
      eth_getTransactionReceipt: { transactionHash: `0x${'ef'.repeat(32)}`, blockNumber: '0xa', blockHash: BLOCK_HASH },
    }[method];
    const rawText = JSON.stringify({ jsonrpc: '2.0', id: 1, result });
    return {
      result, rawText, responseJson: JSON.parse(rawText), responseSha256: normalizer.sha256(rawText),
      requestId: null, method, params,
    };
  };
  await assert.rejects(rpc.transactionAndReceipt(HASH), (error) => error.code === 'RPC_IDENTITY_MISMATCH');
});

test('consensus RPC rejects malformed or unsafe canonical coordinates', async () => {
  const rpc = new RpcClient(10, { spacingMs: 0 });
  rpc.request = async () => ({
    number: '0x20000000000000', hash: BLOCK_HASH, timestamp: '0x1',
  });
  await assert.rejects(rpc.finalizedBoundary(), (error) => error.code === 'RPC_INVALID_RESPONSE');

  const responses = {
    eth_getTransactionByHash: {
      hash: HASH, blockNumber: '12', blockHash: BLOCK_HASH,
    },
    eth_getTransactionReceipt: {
      transactionHash: HASH, blockNumber: '0xa', blockHash: BLOCK_HASH,
    },
  };
  rpc.requestWithEvidence = async (method, params) => ({
    result: responses[method], rawText: JSON.stringify(responses[method]),
    responseJson: responses[method], responseSha256: normalizer.sha256(responses[method]),
    requestId: null, method, params,
  });
  await assert.rejects(rpc.transactionAndReceipt(HASH), (error) => error.code === 'RPC_IDENTITY_MISMATCH');
});

test('consensus RPC archive probes require a canonical block at the requested height', async () => {
  const rpc = new RpcClient(10, { spacingMs: 0 });
  rpc.requestWithEvidence = async () => ({
    result: { number: '0x2a', hash: BLOCK_HASH },
    rawText: JSON.stringify({ number: '0x2a', hash: BLOCK_HASH }),
    responseJson: { number: '0x2a', hash: BLOCK_HASH },
    responseSha256: normalizer.sha256({ number: '0x2a', hash: BLOCK_HASH }),
    requestId: null, method: 'eth_getBlockByNumber', params: ['0x2a', false],
  });
  const checked = await rpc.blockByNumberWithEvidence('0x2a');
  assert.equal(checked.value.number, '0x2a');
  await assert.rejects(rpc.blockByNumberWithEvidence('42'),
    (error) => error.code === 'RPC_INVALID_RESPONSE');

  rpc.requestWithEvidence = async () => ({
    result: { number: '0x2b', hash: BLOCK_HASH },
    rawText: '{}', responseJson: {}, responseSha256: normalizer.sha256('{}'),
    requestId: null, method: 'eth_getBlockByNumber', params: ['0x2a', false],
  });
  await assert.rejects(rpc.blockByNumberWithEvidence('0x2a'),
    (error) => error.code === 'RPC_ARCHIVE_UNAVAILABLE');
});

test('consensus RPC token-log enumeration adapts ranges, deduplicates self transfers, and resumes', async () => {
  const rpc = new RpcClient(10, { spacingMs: 0 });
  const log = {
    address: CONTRACT,
    blockNumber: '0x1',
    blockHash: BLOCK_HASH,
    transactionHash: HASH,
    transactionIndex: '0x2',
    logIndex: '0x3',
    removed: false,
    topics: [TOPICS.transfer, addressTopic(WALLET), addressTopic(WALLET)],
    data: `0x${word(7)}`,
  };
  const calls = [];
  rpc.requestWithEvidence = async (method, params) => {
    assert.equal(method, 'eth_getLogs');
    const filter = params[0];
    calls.push(filter);
    const from = Number(BigInt(filter.fromBlock));
    const through = Number(BigInt(filter.toBlock));
    if (through - from + 1 > 2) {
      const error = new Error('query returned more than the result limit');
      error.code = 'RPC_API_ERROR';
      error.rpcCode = -32005;
      throw error;
    }
    const result = from === 0 && filter.topics[0] === TOPICS.transfer ? [log] : [];
    const rawText = JSON.stringify({ jsonrpc: '2.0', id: 1, result });
    return {
      result, rawText, responseJson: JSON.parse(rawText), responseSha256: normalizer.sha256(rawText),
      requestId: null, method, params,
    };
  };

  const pages = [];
  for await (const page of rpc.addressIndexedTokenLogPages(WALLET, {
    fromBlock: 0, throughBlock: 3, initialRange: 4, maxRequests: 20,
  })) pages.push(page);
  assert.deepEqual(pages.map((page) => [page.fromBlock, page.throughBlock, page.cursorOut]), [
    [0, 1, '2'], [2, 3, '4'],
  ]);
  assert.equal(pages[0].logs.length, 1, 'the from/to filters must not duplicate a self transfer');
  assert.equal(pages[0].evidence.length, 4);
  assert.equal(calls.length, 9, 'the failed wide request remains inside the request budget');

  const resumed = [];
  for await (const page of rpc.addressIndexedTokenLogPages(WALLET, {
    fromBlock: 0, throughBlock: 3, cursor: '2', initialRange: 2, maxRequests: 4,
  })) resumed.push(page);
  assert.deepEqual(resumed.map((page) => [page.fromBlock, page.throughBlock]), [[2, 3]]);
});

test('consensus RPC token-log enumeration stops at a durable request checkpoint', async () => {
  const rpc = new RpcClient(10, { spacingMs: 0 });
  rpc.requestWithEvidence = async (method, params) => {
    const rawText = JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] });
    return {
      result: [], rawText, responseJson: JSON.parse(rawText), responseSha256: normalizer.sha256(rawText),
      requestId: null, method, params,
    };
  };
  const iterator = rpc.addressIndexedTokenLogPages(WALLET, {
    fromBlock: 0, throughBlock: 3, initialRange: 2, maxRequests: 4,
  });
  const first = await iterator.next();
  assert.deepEqual([first.value.fromBlock, first.value.throughBlock, first.value.cursorOut], [0, 1, '2']);
  await assert.rejects(iterator.next(), (error) =>
    error.code === 'RPC_LOG_SCAN_BUDGET_EXHAUSTED' && error.cursor === '2'
  );
});

test('trace RPC enumeration walks sender and receiver filters without double-counting root calls', async () => {
  const rpc = new RpcClient(10, { spacingMs: 0 });
  const nested = {
    type: 'call',
    action: { from: OTHER, to: WALLET, value: '0x7' },
    blockNumber: 1, blockHash: BLOCK_HASH, transactionHash: HASH,
    transactionPosition: 2, traceAddress: [0, 1],
  };
  const root = {
    type: 'call',
    action: { from: WALLET, to: OTHER, value: '0x9' },
    blockNumber: 1, blockHash: BLOCK_HASH, transactionHash: HASH,
    transactionPosition: 2, traceAddress: [],
  };
  const calls = [];
  rpc.requestWithEvidence = async (method, params) => {
    assert.equal(method, 'trace_filter');
    const filter = params[0];
    calls.push(filter);
    const result = filter.after != null ? [] : (filter.fromAddress ? [root] : [nested]);
    const rawText = JSON.stringify({ jsonrpc: '2.0', id: 1, result });
    return {
      result, rawText, responseJson: JSON.parse(rawText), responseSha256: normalizer.sha256(rawText),
      requestId: null, method, params,
    };
  };
  const pages = [];
  for await (const page of rpc.addressInternalTracePages(WALLET, {
    fromBlock: 0, throughBlock: 1, initialRange: 2, maxRequests: 4,
  })) pages.push(page);
  assert.equal(calls.length, 4);
  assert.equal(calls[1].after, 1);
  assert.equal(calls[0].count, 10000);
  assert.deepEqual(pages.map((page) => page.direction), [
    'fromAddress', 'fromAddress', 'toAddress', 'toAddress',
  ]);
  assert.equal(pages[3].cursorOut, '2');
  assert.equal(pages[2].traces.length, 1);
  assert.deepEqual(pages[2].traces[0].traceAddress, [0, 1]);
  const observations = normalizer.rpcTraceObservations(
    { ...context(), provider: 'trace-rpc' }, pages[2].traces
  );
  assert.equal(observations[0].evidenceKind, 'internal_trace');
  assert.equal(observations[0].payload.from_address, OTHER);
  assert.equal(observations[0].payload.to_address, WALLET);
  assert.equal(observations[0].payload.value_wei, '0x7');
});

test('trace RPC enumeration adapts ranges and preserves a resumable cursor', async () => {
  const rpc = new RpcClient(10, { spacingMs: 0 });
  const trace = {
    type: 'call', action: { from: OTHER, to: WALLET, value: '0x7' },
    blockNumber: '0x0', blockHash: BLOCK_HASH, transactionHash: HASH,
    transactionPosition: '0x0', traceAddress: [0],
  };
  const calls = [];
  rpc.requestWithEvidence = async (method, params) => {
    const filter = params[0];
    calls.push(filter);
    const from = Number(BigInt(filter.fromBlock));
    const through = Number(BigInt(filter.toBlock));
    if (through - from + 1 > 1) {
      const error = new Error('trace response exceeds result limit');
      error.code = 'RPC_API_ERROR';
      error.rpcCode = -32005;
      throw error;
    }
    const result = filter.after == null && from === 0 && filter.toAddress ? [trace] : [];
    const rawText = JSON.stringify({ jsonrpc: '2.0', id: 1, result });
    return {
      result, rawText, responseJson: JSON.parse(rawText), responseSha256: normalizer.sha256(rawText),
      requestId: null, method, params,
    };
  };
  const pages = [];
  for await (const page of rpc.addressInternalTracePages(WALLET, {
    fromBlock: 0, throughBlock: 2, initialRange: 3, maxRequests: 20,
  })) pages.push(page);
  assert.deepEqual(pages.map((page) => [page.fromBlock, page.throughBlock]), [
    [0, 0], [0, 0], [0, 0], [1, 1], [1, 1], [2, 2], [2, 2],
  ]);
  assert.equal(pages[1].traces.length, 1);
  assert.ok(calls.length > 6, 'the failed wide ranges remain observable in the bounded walk');
  const resumed = [];
  for await (const page of rpc.addressInternalTracePages(WALLET, {
    fromBlock: 0, throughBlock: 2, cursor: '1', initialRange: 2, maxRequests: 8,
  })) resumed.push(page);
  assert.deepEqual(resumed.map((page) => [page.fromBlock, page.throughBlock]), [
    [1, 1], [1, 1], [2, 2], [2, 2],
  ]);
});

test('trace RPC resumes inside a provider-capped page after a budget checkpoint', async () => {
  const rpc = new RpcClient(10, { spacingMs: 0 });
  const traces = [0, 1].map((index) => ({
    type: 'call', action: { from: OTHER, to: WALLET, value: `0x${index + 1}` },
    blockNumber: '0x0', blockHash: BLOCK_HASH, transactionHash: HASH,
    transactionPosition: '0x0', traceAddress: [index],
  }));
  const calls = [];
  rpc.requestWithEvidence = async (method, params) => {
    const filter = params[0];
    calls.push(filter);
    const after = filter.after == null ? 0 : Number(BigInt(filter.after));
    const result = filter.fromAddress ? [] : (after === 0 ? traces : []);
    const rawText = JSON.stringify({ jsonrpc: '2.0', id: 1, result });
    return {
      result, rawText, responseJson: JSON.parse(rawText), responseSha256: normalizer.sha256(rawText),
      requestId: null, method, params,
    };
  };
  const iterator = rpc.addressInternalTracePages(WALLET, {
    fromBlock: 0, throughBlock: 0, initialRange: 1, maxRequests: 2,
  });
  await iterator.next();
  const page = await iterator.next();
  assert.equal(page.value.traces.length, 2);
  await assert.rejects(iterator.next(), (error) => (
    error.code === 'RPC_TRACE_SCAN_BUDGET_EXHAUSTED' && error.after === '2'
  ));
  const resumed = [];
  for await (const next of rpc.addressInternalTracePages(WALLET, {
    fromBlock: 0, throughBlock: 0, cursor: page.value.cursorOut, initialRange: 1, maxRequests: 4,
  })) resumed.push(next);
  assert.equal(calls.some((filter) => filter.after === 2), true);
  assert.deepEqual(resumed.map((next) => next.cursorOut), ['1']);
});

test('trace RPC keeps consensus rewards as an explicit unsupported gap', async () => {
  const rpc = new RpcClient(10, { spacingMs: 0 });
  rpc.requestWithEvidence = async (method, params) => {
    const reward = {
      type: 'reward',
      action: { author: WALLET, value: '0x7', rewardType: 'block' },
      blockNumber: 1, blockHash: BLOCK_HASH,
    };
    const result = params[0].fromAddress ? [reward] : [];
    const rawText = JSON.stringify({ jsonrpc: '2.0', id: 1, result });
    return {
      result, rawText, responseJson: JSON.parse(rawText), responseSha256: normalizer.sha256(rawText),
      requestId: null, method, params,
    };
  };
  const iterator = rpc.addressInternalTracePages(WALLET, {
    fromBlock: 1, throughBlock: 1, initialRange: 1, maxRequests: 2,
  });
  await assert.rejects(iterator.next(), (error) => error.code === 'RPC_TRACE_REWARD_UNSUPPORTED');
});

test('trace RPC effects can be promoted only with a canonical receipt proof', () => {
  const observation = {
    id: 21, provider: 'trace-rpc', provider_object_key: `trace:${HASH}:[0]`,
    tx_hash: HASH, trace_address: [0],
    payload_json: { from_address: OTHER, to_address: WALLET, value_wei: '7', is_error: false },
  };
  const provisional = effectsFromInternalObservations(context(10), [observation]);
  assert.equal(provisional[0].resolutionStatus, 'provisional');
  const verified = effectsFromInternalObservations(context(10), [observation], {
    verifiedTraceHashes: new Set([HASH]),
  });
  assert.equal(verified[0].resolutionStatus, 'verified');
  assert.deepEqual(verified[0].evidenceObservationIds, [21]);
});

test('consensus RPC token-log enumeration rejects unrelated logs', async () => {
  const rpc = new RpcClient(10, { spacingMs: 0 });
  const unrelated = {
    address: CONTRACT,
    blockNumber: '0x0', blockHash: BLOCK_HASH,
    transactionHash: HASH, transactionIndex: '0x0', logIndex: '0x0',
    removed: false,
    topics: [TOPICS.transfer, addressTopic(OTHER), addressTopic(CONTRACT)],
    data: `0x${word(1)}`,
  };
  rpc.requestWithEvidence = async (method, params) => {
    const result = params[0].topics[0] === TOPICS.transfer ? [unrelated] : [];
    return {
      result, rawText: '{}', responseJson: {}, responseSha256: normalizer.sha256('{}'),
      requestId: null, method, params,
    };
  };
  const iterator = rpc.addressIndexedTokenLogPages(WALLET, {
    fromBlock: 0, throughBlock: 0, initialRange: 1, maxRequests: 4,
  });
  await assert.rejects(iterator.next(), (error) => error.code === 'RPC_INVALID_RESPONSE');
});

test('consensus RPC token-log enumeration records unsupported methods without range retries', async () => {
  const rpc = new RpcClient(10, { spacingMs: 0 });
  let calls = 0;
  rpc.requestWithEvidence = async () => {
    calls += 1;
    const error = new Error('method not found');
    error.code = 'RPC_API_ERROR';
    error.rpcCode = -32601;
    throw error;
  };
  const iterator = rpc.addressIndexedTokenLogPages(WALLET, {
    fromBlock: 0, throughBlock: 99, initialRange: 100, maxRequests: 4,
  });
  await assert.rejects(iterator.next(), (error) =>
    error.code === 'RPC_LOG_ENUMERATION_UNSUPPORTED' && error.cursor === '0'
  );
  assert.equal(calls, 1);
});

test('consensus RPC token-log enumeration rejects conflicting duplicate coordinates', async () => {
  const rpc = new RpcClient(10, { spacingMs: 0 });
  let calls = 0;
  rpc.requestWithEvidence = async (method, params) => {
    calls += 1;
    const result = calls <= 2 ? [{
      address: CONTRACT,
      blockNumber: '0x0', blockHash: calls === 1 ? BLOCK_HASH : `0x${'ef'.repeat(32)}`,
      transactionHash: HASH, transactionIndex: '0x0', logIndex: '0x0',
      removed: false,
      topics: [TOPICS.transfer, addressTopic(WALLET), addressTopic(WALLET)],
      data: `0x${word(1)}`,
    }] : [];
    const rawText = JSON.stringify({ jsonrpc: '2.0', id: 1, result });
    return {
      result, rawText, responseJson: JSON.parse(rawText), responseSha256: normalizer.sha256(rawText),
      requestId: null, method, params,
    };
  };
  const iterator = rpc.addressIndexedTokenLogPages(WALLET, {
    fromBlock: 0, throughBlock: 0, initialRange: 1, maxRequests: 4,
  });
  await assert.rejects(iterator.next(), (error) => error.code === 'RPC_CONFLICTING_LOG');
});

test('independently enumerated RPC logs retain stable observation coordinates', () => {
  const log = {
    address: CONTRACT,
    blockNumber: '0xa', blockHash: BLOCK_HASH,
    transactionHash: HASH, transactionIndex: '0x2', logIndex: '0x3',
    removed: false,
    topics: [TOPICS.transfer, addressTopic(OTHER), addressTopic(WALLET)],
    data: `0x${word(9)}`,
  };
  const observations = normalizer.rpcLogObservations(context(), [log]);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].evidenceKind, 'log');
  assert.equal(observations[0].providerObjectKey, `log:${HASH}:3`);
  assert.equal(observations[0].blockNumber, 10);
  assert.equal(observations[0].logIndex, 3);
});

test('independent token-log scope stays separate from point receipt verification', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/EvmAuditService.js'), 'utf8');
  const logScope = source.indexOf("capability: 'indexed_token_logs'");
  const receiptScope = source.indexOf("capability: 'receipt_verification'");
  assert.ok(logScope >= 0 && receiptScope > logScope);
  assert.match(source, /capability: 'indexed_token_logs', fromBlock: 0, throughBlock: boundary\.number/);
  assert.match(source, /const receiptEnumerationGap = 1;/,
    'token logs must not erase the unresolved native/internal receipt-enumeration gap');
  assert.match(source, /indexed_token_log_enumeration_gap: indexedTokenLogEnumerationGap/);
});

test('nonce gaps are compact ranges and do not iterate across absent history', () => {
  assert.deepEqual(EvmAuditService._missingRanges(['0', '2', '2', '999999999'], 1000000000n), [
    { from: '1', to: '1' },
    { from: '3', to: '999999998' },
  ]);
});

test('historical token checkpoints use a deterministic bounded contract plan', () => {
  assert.deepEqual(EvmAuditService._historicalTokenPlan([
    { token_contract: CONTRACT.toUpperCase() },
    { token_contract: WALLET },
    { token_contract: CONTRACT },
  ], 1), {
    contracts: [WALLET.toLowerCase(), CONTRACT.toLowerCase()],
    checked: [WALLET.toLowerCase()],
    deferred: 1,
  });
  const many = Array.from({ length: 65 }, (_, index) =>
    `0x${index.toString(16).padStart(40, '0')}`
  );
  const bounded = EvmAuditService._historicalTokenPlan(many);
  assert.equal(bounded.checked.length, 64);
  assert.equal(bounded.deferred, 1);
});

test('provider-observed ERC-20 contracts join the balance audit universe', () => {
  const result = EvmAuditService._mergeObservedTokenUniverse([
    { token_contract: CONTRACT, token_decimals: 6, balance_units: '12' },
  ], [
    { token_contract: CONTRACT.toUpperCase() },
    { token_contract: WALLET },
    { token_contract: OTHER },
  ]);
  assert.equal(result.observedOnly, 2);
  assert.equal(result.tokensByContract.size, 3);
  assert.equal(result.tokensByContract.get(CONTRACT).balance_units, '12');
  assert.equal(result.tokensByContract.get(OTHER).observed_only, true);
  assert.equal(result.tokensByContract.get(OTHER).token_decimals, 18);
});

test('asset-universe query includes durable ERC-20 observations and canonical effects', async () => {
  const originalQuery = database.query;
  let sql;
  let params;
  database.query = async (query, queryParams) => {
    sql = query;
    params = queryParams;
    return { rows: [{ token_contract: CONTRACT }] };
  };
  try {
    const rows = await EvmAudit.observedErc20Contracts(7, 9, 3, 10, 99);
    assert.deepEqual(rows, [{ token_contract: CONTRACT }]);
    assert.deepEqual(params, [7, 9, 3, 10, 99]);
    assert.match(sql, /j\.user_id = \$1 AND j\.subject_id = \$3/);
    assert.match(sql, /s\.id = e\.subject_id AND s\.user_id = \$1/);
    assert.match(sql, /o\.evidence_kind = 'erc20_transfer'/);
    assert.match(sql, /o\.payload_json->>'token_contract'/);
    assert.match(sql, /p\.endpoint IN \('account-token', 'account-erc20'\)/);
    assert.match(sql, /e\.effect_type = 'erc20'/);
    assert.match(sql, /e\.resolution_status <> 'invalidated'/);
  } finally {
    database.query = originalQuery;
  }
});

test('effect reconciliation counts missing or duplicate economic legs, not just transaction hashes', () => {
  const canonical = [{
    id: 10, effect_key: `erc20:${HASH}:3`, log_index: 3,
    tx_hash: HASH, effect_type: 'erc20', direction: 'in', from_address: OTHER,
    to_address: WALLET, value_units: '8', token_contract: CONTRACT, token_id: null,
  }];
  const matchingLegacy = [{
    id: 20, source_log_index: 3,
    tx_hash: HASH, transfer_type: 'token', from_address: OTHER, to_address: WALLET,
    value_wei: '8', token_contract: CONTRACT, token_id: null, is_error: false,
  }];
  assert.equal(EvmAuditService._unmatchedEffectCount(
    canonical, matchingLegacy, WALLET, chains.getChain(10)
  ), 0);
  assert.equal(EvmAuditService._unmatchedEffectCount(
    canonical, [], WALLET, chains.getChain(10)
  ), 1);
  assert.equal(EvmAuditService._unmatchedEffectCount(
    canonical, [...matchingLegacy, ...matchingLegacy], WALLET, chains.getChain(10)
  ), 0);
  const duplicate = { ...matchingLegacy[0], id: 21 };
  assert.equal(EvmAuditService._unmatchedEffectCount(
    canonical, [matchingLegacy[0], duplicate], WALLET, chains.getChain(10)
  ), 1);
  const uncoordinated = { ...matchingLegacy[0], id: 22, source_log_index: null };
  assert.ok(EvmAuditService._unmatchedEffectCount(
    canonical, [uncoordinated], WALLET, chains.getChain(10)
  ) > 0, 'economic equality without immutable log identity remains a gap');
});

test('cross-provider transfer repair requires an exact indexed log coordinate and payload', () => {
  const effect = {
    effect_type: 'erc20', effect_key: `erc20:${HASH}:3`, log_index: 3,
    tx_hash: HASH, from_address: OTHER, to_address: WALLET, value_units: '8',
    token_contract: CONTRACT, token_id: null,
  };
  const moralis = {
    provider: 'moralis', evidence_kind: 'erc20_transfer', tx_hash: HASH, log_index: 3,
    payload_json: {
      address: CONTRACT, from_address: OTHER, to_address: WALLET, value: '8', log_index: 3,
    },
  };
  const legacy = {
    tx_hash: HASH, transfer_type: 'token', from_address: OTHER, to_address: WALLET,
    value_wei: '8', token_contract: CONTRACT, token_id: null,
  };
  assert.equal(matchesIndexedTransfer(effect, moralis), true);
  assert.equal(matchesIndexedTransfer(effect, {
    ...moralis, payload_json: { ...moralis.payload_json, value: 8 },
  }), true);
  assert.equal(matchesLegacyTransfer(effect, legacy), true);
  assert.equal(matchesIndexedTransfer(effect, { ...moralis, log_index: 4 }), false);
  assert.equal(matchesIndexedTransfer(effect, {
    ...moralis, payload_json: { ...moralis.payload_json, value: '9' },
  }), false);
  assert.equal(matchesLegacyTransfer(effect, { ...legacy, token_contract: OTHER }), false);
});

test('configured explorer token evidence can corroborate an exact legacy identity', () => {
  const effect = {
    effect_type: 'erc20', effect_key: `erc20:${HASH}:3`, log_index: 3,
    tx_hash: HASH, from_address: OTHER, to_address: WALLET, value_units: '8',
    token_contract: CONTRACT, token_id: null,
  };
  const explorer = {
    provider: 'blockscout', evidence_kind: 'account_feed', tx_hash: HASH, log_index: 3,
    payload_json: {
      contractAddress: CONTRACT, from: OTHER, to: WALLET, value: '8', logIndex: '3',
    },
  };

  assert.equal(matchesIndexedTransfer(effect, explorer, ['moralis', 'blockscout']), true);
  assert.equal(matchesIndexedTransfer(effect, explorer, ['moralis']), false);
  assert.equal(matchesIndexedTransfer(effect, { ...explorer, log_index: null }, [
    'blockscout',
  ]), false);
});

test('explorer ERC-721 account feeds corroborate exact tokenID identity', () => {
  const tokenId = '9007199254740993';
  const effect = {
    effect_type: 'erc721', effect_key: `erc721:${HASH}:3`, log_index: 3,
    tx_hash: HASH, from_address: OTHER, to_address: WALLET, value_units: '1',
    token_contract: CONTRACT, token_id: tokenId,
  };
  const observation = {
    evidence_kind: 'account_feed', tx_hash: HASH, log_index: 3,
    payload_json: {
      contractAddress: CONTRACT, from: OTHER, to: WALLET, tokenID: tokenId,
    },
  };

  for (const provider of ['etherscan', 'blockscout']) {
    const candidate = { ...observation, provider };
    assert.equal(matchesIndexedTransfer(effect, candidate, [provider]), true);
    assert.equal(matchesIndexedTransfer(effect, {
      ...candidate,
      payload_json: { ...candidate.payload_json, tokenID: '9007199254740994' },
    }, [provider]), false);
  }
});

test('explorer ERC-1155 account feeds require exact tokenID and tokenValue identity', () => {
  const tokenId = '50885195465617469194167106852330514362694690086631139282090694154350210580562';
  const effect = {
    effect_type: 'erc1155', effect_key: `erc1155:${HASH}:3:${tokenId}`, log_index: 3,
    tx_hash: HASH, from_address: OTHER, to_address: WALLET, value_units: '2',
    token_contract: CONTRACT, token_id: tokenId,
  };
  const observation = {
    evidence_kind: 'account_feed', tx_hash: HASH, log_index: 3,
    payload_json: {
      contractAddress: CONTRACT, from: OTHER, to: WALLET,
      tokenID: tokenId, tokenValue: '2',
    },
  };

  for (const provider of ['etherscan', 'blockscout']) {
    const candidate = { ...observation, provider };
    assert.equal(matchesIndexedTransfer(effect, candidate, [provider]), true);
    assert.equal(matchesIndexedTransfer(effect, {
      ...candidate,
      payload_json: { ...candidate.payload_json, tokenValue: '3' },
    }, [provider]), false);
    assert.equal(matchesIndexedTransfer(effect, {
      ...candidate,
      payload_json: { ...candidate.payload_json, tokenID: '7' },
    }, [provider]), false);
    const { tokenValue: _missing, ...withoutTokenValue } = candidate.payload_json;
    assert.equal(matchesIndexedTransfer(effect, {
      ...candidate, payload_json: withoutTokenValue,
    }, [provider]), false);
  }
});

test('NFT corroboration uses Moralis amount units instead of its non-unit value field', () => {
  const effect = {
    effect_type: 'erc1155', effect_key: `erc1155:${HASH}:3:7`, log_index: 3,
    tx_hash: HASH, from_address: OTHER, to_address: WALLET, value_units: '2',
    token_contract: CONTRACT, token_id: '7',
  };
  const observation = {
    provider: 'moralis', evidence_kind: 'erc1155_transfer', tx_hash: HASH, log_index: 3,
    payload_json: {
      token_address: CONTRACT, from_address: OTHER, to_address: WALLET,
      amount: '2', value: '0.000000000000000001', token_id: '7',
    },
  };
  assert.equal(matchesIndexedTransfer(effect, observation), true);
  assert.equal(matchesIndexedTransfer(effect, {
    ...observation, payload_json: { ...observation.payload_json, amount: '3' },
  }), false);
  assert.equal(matchesIndexedTransfer(effect, {
    ...observation, payload_json: { ...observation.payload_json, amount: null, value: '2' },
  }), false);
  assert.equal(matchesIndexedTransfer(effect, {
    ...observation, payload_json: { ...observation.payload_json, amount: [2] },
  }), false);
  assert.equal(matchesIndexedTransfer(effect, {
    ...observation,
    payload_json: {
      ...observation.payload_json, amount: '9007199254740992',
      __evm_json_numeric_fields: ['amount'],
    },
  }), false);
  assert.equal(matchesIndexedTransfer(effect, {
    ...observation,
    payload_json: {
      ...observation.payload_json, token_id: '9007199254740992',
      __evm_json_numeric_fields: ['token_id'],
    },
  }), false);
});

test('audit migration is additive, fail-closed, and user-owned', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../migrations/077_evm_audit_evidence.sql'), 'utf8');
  assert.match(sql, /user_id INT NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(sql, /status <> 'complete'\s+OR \(requested_from_block IS NOT NULL AND requested_through_block IS NOT NULL AND pagination_exhausted\)/);
  assert.match(sql, /UNIQUE \(\s*subject_id, chain_id, provider, evidence_kind,/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS evm_provider_attempts/);
  assert.match(sql, /response_raw TEXT/);
  assert.match(sql, /FOREIGN KEY \(subject_id, user_id\) REFERENCES evm_subjects/);
  assert.doesNotMatch(sql, /DELETE FROM eth_transfers/i);
  assert.ok(chains.getChain(100).stateSyncDeposits,
    'Gnosis wallet-filtered native-credit evidence remains until the audit proves a replacement');
});

test('indexed token-log coverage has a separate durable audit capability', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '../migrations/083_evm_indexed_token_logs.sql'), 'utf8'
  );
  assert.match(sql, /evm_audit_scopes_capability_check/);
  assert.match(sql, /'indexed_token_logs'/);
  assert.match(sql, /'receipt_verification'/);
  assert.match(sql, /DROP CONSTRAINT/);
});
