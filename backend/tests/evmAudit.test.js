'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const normalizer = require('../src/services/evmAudit/normalizer');
const MoralisClient = require('../src/services/evmAudit/MoralisClient');
const RpcClient = require('../src/services/evmAudit/RpcClient');
const EvmAuditService = require('../src/services/EvmAuditService');
const EvmAudit = require('../src/models/EvmAudit');
const SecretsService = require('../src/services/SecretsService');
const database = require('../src/config/database');
const {
  TOPICS, effectsFromInternalObservations, effectsFromRpc,
} = require('../src/services/evmAudit/effectDecoder');
const chains = require('../src/config/chains');
const {
  matchesLegacyTransfer, matchesMoralisTransfer,
} = require('../src/services/evmAudit/corroboratedIdentity');

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const CONTRACT = '0x3333333333333333333333333333333333333333';
const HASH = `0x${'ab'.repeat(32)}`;
const BLOCK_HASH = `0x${'cd'.repeat(32)}`;
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const addressTopic = (value) => `0x${value.slice(2).padStart(64, '0')}`;

const context = (chainId = 8453) => ({
  jobId: 9,
  subjectId: 3,
  chainId,
  address: WALLET,
  provider: 'consensus-rpc',
  chain: chains.getChain(chainId),
});

test('history audit enumerates every configured chain', () => {
  const original = process.env.ETH_CHAINS;
  try {
    delete process.env.ETH_CHAINS;
    assert.deepEqual(EvmAuditService.supportedChainIds(), [
      1, 10, 100, 137, 324, 8453, 42161, 59144, 32401,
    ]);
    assert.deepEqual(EvmAuditService.configuredChainIds(), [
      1, 10, 100, 137, 324, 8453, 42161, 59144, 32401,
    ]);
  } finally {
    if (original == null) delete process.env.ETH_CHAINS;
    else process.env.ETH_CHAINS = original;
  }
});

test('Base audit scope uses CDP while Gnosis retains Moralis with an explorer fallback', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/EvmAuditService.js'), 'utf8');
  assert.match(source, /\[100, \{\s*\n\s*moralis: 'gnosis', fallbackProvider: 'blockscout'/);
  assert.match(source, /\[8453, \{\s*\n\s*cdp: 'base'/);
  assert.doesNotMatch(source, /\[8453, \{[\s\S]{0,160}moralis:/);
  assert.match(source, /\[1, \{ auditProvider: 'etherscan' \}\]/);
  assert.match(source, /\[42161, \{ auditProvider: 'etherscan' \}\]/);
  assert.match(source, /const useMoralis = Boolean\(providerConfig\.moralis && moralis\)/);
  assert.match(source, /const useCdp = Boolean\(providerConfig\.cdp && cdp\)/);
  assert.match(source, /const nativeCredit = chain\?\.auditNativeCredits \|\| chain\?\.stateSyncDeposits/);
  assert.match(source, /fetchStateSyncDeposits\(/);
  assert.match(source, /evidenceKind: 'native_credit'/);
  assert.match(source, /discoveredChain\.bounded = true/);
  assert.match(source, /discoveredChain\.status = 'bounded'/);
  assert.match(source, /discoveredChain\.active_hint_proven = false/);
});

test('Moralis quota fallback remains visibly deferred and never marks discovery complete', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/EvmAuditService.js'), 'utf8');
  assert.match(source, /status: 'deferred', source: 'moralis'/);
  assert.match(source, /active_discovery = \{/);
  assert.match(source, /key && moralisRequested\.length/);
  assert.match(source, /let providerDeferred = Boolean\(moralisUnavailable \|\| cdpUnavailable \|\| unavailable\.length\)/);
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
    assert.equal(scopes.length, 13);
    assert.ok(scopes.every((scope) => scope.status === 'unsupported'));
    assert.ok(scopes.every((scope) => scope.errorCode === 'NON_EVM_CHAIN'));
  } finally {
    EvmAudit.upsertScope = originalUpsertScope;
  }
});

test('zkSync Era uses bounded Blockscout audit coverage instead of unsupported status', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/EvmAuditService.js'), 'utf8');
  assert.match(source, /\[324, \{\s*auditProvider: 'blockscout'/);
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
      chainId: 8453,
      provider: 'coinbase-cdp',
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
      chainId: 8453,
      provider: 'coinbase-cdp',
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
  assert.match(method, /\[jobId, userId, subjectId, chainId, throughBlock/);
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

test('Blockscout transient provider failures defer instead of becoming permanent gaps', () => {
  assert.equal(EvmAuditService._isBlockscoutTransient({ response: { status: 408 } }), true);
  assert.equal(EvmAuditService._isBlockscoutTransient({ response: { status: 503 } }), true);
  assert.equal(EvmAuditService._isBlockscoutTransient({ code: 'EAI_AGAIN' }), true);
  assert.equal(EvmAuditService._isBlockscoutTransient({ response: { status: 400 } }), false);
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

test('Base native-credit logs are decoded only for this wallet and exact receipt coordinates', () => {
  const nativeCredits = chains.getChain(8453).auditNativeCredits;
  const transaction = {
    hash: HASH, from: OTHER, to: nativeCredits.contract, value: '0x0', gasPrice: '0x1',
  };
  const receipt = {
    gasUsed: '0x1', effectiveGasPrice: '0x1',
    logs: [{
      logIndex: '0x4', address: nativeCredits.contract,
      topics: [nativeCredits.topic0, `0x${'00'.repeat(32)}`, addressTopic(WALLET)],
      data: `0x${word(123)}`,
    }],
  };
  const effects = effectsFromRpc(context(), transaction, receipt);
  assert.equal(effects.length, 1);
  assert.equal(effects[0].effectType, 'native_credit');
  assert.equal(effects[0].effectKey, `native-credit:${HASH}:4`);
  assert.equal(effects[0].valueUnits, '123');
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

test('Moralis discovery quota exhaustion defers Gnosis while Base still uses CDP', async () => {
  const originalFetch = global.fetch;
  const originals = {
    acquireRunLock: EvmAudit.acquireRunLock,
    releaseRunLock: EvmAudit.releaseRunLock,
    claim: EvmAudit.claim,
    findById: EvmAudit.findById,
    heartbeat: EvmAudit.heartbeat,
    credentialGenerations: EvmAudit.credentialGenerations,
    credentialGeneration: EvmAudit.credentialGeneration,
    setDiscoveredChains: EvmAudit.setDiscoveredChains,
    recordProviderAttempt: EvmAudit.recordProviderAttempt,
    finish: EvmAudit.finish,
    getUserKey: SecretsService.getUserKey,
    runChain: EvmAuditService.runChain,
  };
  const captured = [];
  let finished;
  global.fetch = async () => new Response(
    JSON.stringify({ message: 'free-plan daily quota exhausted' }),
    { status: 401, headers: { 'content-type': 'application/json' } }
  );
  EvmAudit.acquireRunLock = async () => ({ userId: 1 });
  EvmAudit.releaseRunLock = async () => {};
  EvmAudit.claim = async () => ({ id: 44 });
  EvmAudit.findById = async () => ({
    id: 44, user_id: 1, subject_id: 9, requested_wallet_id: 3,
    address: WALLET, requested_chains: [100, 8453, 324], mode: 'full',
    credential_generation: null,
    moralis_credential_generation: null,
    cdp_credential_generation: null,
  });
  EvmAudit.heartbeat = async () => ({ id: 44 });
  EvmAudit.credentialGenerations = async () => ({ moralis: null, cdp: null });
  EvmAudit.credentialGeneration = async () => null;
  EvmAudit.setDiscoveredChains = async (_jobId, _owner, chainsFound) => chainsFound;
  EvmAudit.recordProviderAttempt = async () => {};
  EvmAudit.finish = async (_jobId, _owner, status, options) => {
    finished = { status, options };
    return finished;
  };
  SecretsService.getUserKey = async (_userId, service) => (
    service === 'moralis' ? 'moralis-key' : service === 'cdp' ? 'cdp-key' : null
  );
  EvmAuditService.runChain = async (options) => {
    captured.push({
      chainId: options.chainId,
      moralis: Boolean(options.moralis),
      cdp: options.chainId === 8453 && Boolean(options.cdp),
    });
    return { gaps: 0 };
  };
  try {
    await EvmAuditService.run(44);
    assert.deepEqual(captured, [
      { chainId: 100, moralis: false, cdp: false },
      { chainId: 8453, moralis: false, cdp: true },
      { chainId: 324, moralis: false, cdp: false },
    ]);
    assert.equal(finished.status, 'deferred');
    assert.equal(finished.options.errorCode, 'MORALIS_QUOTA_EXHAUSTED');
  } finally {
    global.fetch = originalFetch;
    EvmAudit.acquireRunLock = originals.acquireRunLock;
    EvmAudit.releaseRunLock = originals.releaseRunLock;
    EvmAudit.claim = originals.claim;
    EvmAudit.findById = originals.findById;
    EvmAudit.heartbeat = originals.heartbeat;
    EvmAudit.credentialGenerations = originals.credentialGenerations;
    EvmAudit.credentialGeneration = originals.credentialGeneration;
    EvmAudit.setDiscoveredChains = originals.setDiscoveredChains;
    EvmAudit.recordProviderAttempt = originals.recordProviderAttempt;
    EvmAudit.finish = originals.finish;
    SecretsService.getUserKey = originals.getUserKey;
    EvmAuditService.runChain = originals.runChain;
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

test('Moralis history scope is finalized after transaction lookup pages', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/EvmAuditService.js'), 'utf8');
  assert.ok(source.includes("job.id, { chainId }"),
    'restart rehydration must inspect all provider evidence kinds, including explorer feeds');
  const lookupPass = source.indexOf('for (const hash of moralisLookupHashes)');
  const canonicalization = source.indexOf("await EvmAudit.heartbeat(job.id, OWNER, { stage: 'canonicalizing' });", lookupPass);
  const finalization = source.indexOf(
    "await completeScope(historyScope.id, { status: 'complete', paginationExhausted: true });",
    lookupPass
  );
  assert.ok(lookupPass >= 0);
  assert.ok(finalization > lookupPass && finalization < canonicalization,
    'lookup evidence must be followed by a final complete status before canonicalization');
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
  assert.match(source, /moralis_credential_generation = \$3/);
  assert.match(source, /cdp_credential_generation = \$4/);
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
  const widened = { ...narrow, mode: 'full', requested_chains: [1, 8453] };
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
    mode: 'full', requestedChains: [1, 8453], credentialGeneration: null,
  });

  assert.equal(result.created, false);
  assert.equal(result.job.mode, 'full');
  assert.deepEqual(result.job.requested_chains, [1, 8453]);
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

test('an explicit narrower Base audit supersedes only a deferred broader scope', async (t) => {
  const originalConnect = database.connect;
  const originalEnsureSubject = EvmAudit.ensureSubject;
  const calls = [];
  const broad = {
    id: 45,
    status: 'deferred',
    mode: 'full',
    requested_chains: [1, 10, 100, 8453],
    error_code: 'BLOCKSCOUT_FEED_UNSUPPORTED',
  };
  const baseJob = {
    id: 46,
    status: 'queued',
    mode: 'full',
    requested_chains: [8453],
  };
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM evm_audit_jobs/.test(sql) && /FOR UPDATE/.test(sql)) return { rows: [broad] };
      if (/FROM evm_audit_scopes/.test(sql)) {
        return { rows: [{ chain_id: 8453, scope_count: '7', complete: true }] };
      }
      if (/INSERT INTO evm_audit_jobs/.test(sql)) return { rows: [baseJob] };
      return { rows: [] };
    },
    release: () => {},
  };
  t.after(() => {
    database.connect = originalConnect;
    EvmAudit.ensureSubject = originalEnsureSubject;
  });
  database.connect = async () => client;
  EvmAudit.ensureSubject = async () => ({ id: 9, address: WALLET });

  const result = await EvmAudit.createOrFindActiveJob(7, { id: 3, address: WALLET }, {
    mode: 'full', requestedChains: [8453], credentialGeneration: null,
  });

  assert.equal(result.created, true);
  assert.deepEqual(result.job.requested_chains, [8453]);
  assert.ok(calls.some(({ sql }) => /status = 'cancelled'/.test(sql)));
  assert.ok(calls.some(({ sql }) => /superseded_by_job_id/.test(sql)));
  assert.ok(calls.some(({ sql }) => /INSERT INTO evm_audit_jobs/.test(sql)));
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('a Base audit can supersede a deferred broad job from the pre-CDP provider', async (t) => {
  const originalConnect = database.connect;
  const originalEnsureSubject = EvmAudit.ensureSubject;
  const calls = [];
  const broad = {
    id: 49,
    status: 'deferred',
    mode: 'full',
    requested_chains: [1, 10, 100, 8453],
    error_code: 'BLOCKSCOUT_FEED_UNSUPPORTED',
  };
  const baseJob = {
    id: 50,
    status: 'queued',
    mode: 'full',
    requested_chains: [8453],
  };
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM evm_audit_jobs/.test(sql) && /FOR UPDATE/.test(sql)) return { rows: [broad] };
      if (/FROM evm_audit_scopes/.test(sql)) {
        return { rows: [{ chain_id: 8453, scope_count: '7', complete: false, providers: ['blockscout'] }] };
      }
      if (/INSERT INTO evm_audit_jobs/.test(sql)) return { rows: [baseJob] };
      return { rows: [] };
    },
    release: () => {},
  };
  t.after(() => {
    database.connect = originalConnect;
    EvmAudit.ensureSubject = originalEnsureSubject;
  });
  database.connect = async () => client;
  EvmAudit.ensureSubject = async () => ({ id: 12, address: WALLET });

  const result = await EvmAudit.createOrFindActiveJob(7, { id: 3, address: WALLET }, {
    mode: 'full', requestedChains: [8453],
    requestedProviders: { 8453: 'coinbase-cdp' }, credentialGeneration: null,
  });

  assert.equal(result.created, true);
  assert.equal(result.job.id, 50);
  assert.ok(calls.some(({ sql }) => /status = 'cancelled'/.test(sql)));
  assert.ok(calls.some(({ sql }) => /superseded_by_job_id/.test(sql)));
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('an unrelated Blockscout deferral does not strand an incomplete CDP Base scope', async (t) => {
  const originalConnect = database.connect;
  const originalEnsureSubject = EvmAudit.ensureSubject;
  const calls = [];
  const broad = {
    id: 51,
    status: 'deferred',
    mode: 'full',
    requested_chains: [10, 8453],
    error_code: 'EVM_CHAIN_AUDIT_DEFERRED',
    error_detail: 'Blockscout internal audit feed failed on OP Mainnet.',
  };
  const baseJob = {
    id: 52,
    status: 'queued',
    mode: 'full',
    requested_chains: [8453],
  };
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM evm_audit_jobs/.test(sql) && /FOR UPDATE/.test(sql)) return { rows: [broad] };
      if (/FROM evm_audit_scopes/.test(sql)) {
        return { rows: [{ chain_id: 8453, scope_count: '7', complete: false, providers: ['coinbase-cdp'] }] };
      }
      if (/INSERT INTO evm_audit_jobs/.test(sql)) return { rows: [baseJob] };
      return { rows: [] };
    },
    release: () => {},
  };
  t.after(() => {
    database.connect = originalConnect;
    EvmAudit.ensureSubject = originalEnsureSubject;
  });
  database.connect = async () => client;
  EvmAudit.ensureSubject = async () => ({ id: 13, address: WALLET });

  const result = await EvmAudit.createOrFindActiveJob(7, { id: 3, address: WALLET }, {
    mode: 'full', requestedChains: [8453],
    requestedProviders: { 8453: 'coinbase-cdp' }, credentialGeneration: null,
  });

  assert.equal(result.created, true);
  assert.equal(result.job.id, 52);
  assert.ok(calls.some(({ sql }) => /status = 'cancelled'/.test(sql)));
  assert.ok(calls.some(({ sql }) => /superseded_by_job_id/.test(sql)));
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('a deferred broader audit is not narrowed while Base has an incomplete scope', async (t) => {
  const originalConnect = database.connect;
  const originalEnsureSubject = EvmAudit.ensureSubject;
  const calls = [];
  const broad = {
    id: 47,
    status: 'deferred',
    mode: 'full',
    requested_chains: [1, 10, 100, 8453],
    error_code: 'CDP_ADDRESS_ENUMERATION_UNPROVEN',
    retry_after_at: new Date(Date.now() + 60_000),
  };
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM evm_audit_jobs/.test(sql) && /FOR UPDATE/.test(sql)) return { rows: [broad] };
      if (/FROM evm_audit_scopes/.test(sql)) {
        return { rows: [{ chain_id: 8453, scope_count: '7', complete: false }] };
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
  EvmAudit.ensureSubject = async () => ({ id: 10, address: WALLET });

  const result = await EvmAudit.createOrFindActiveJob(7, { id: 3, address: WALLET }, {
    mode: 'full', requestedChains: [8453], credentialGeneration: null,
  });

  assert.equal(result.created, false);
  assert.equal(result.job.id, 47);
  assert.equal(result.job.status, 'deferred');
  assert.equal(calls.some(({ sql }) => /EVM_AUDIT_SCOPE_SUPERSEDED/.test(sql)), false);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('an explicit retry reopens a due deferred Base audit without bypassing cooldown', async (t) => {
  const originalConnect = database.connect;
  const originalEnsureSubject = EvmAudit.ensureSubject;
  const calls = [];
  const due = {
    id: 48,
    status: 'deferred',
    mode: 'full',
    requested_chains: [8453],
    error_code: 'CDP_ADDRESS_ENUMERATION_UNPROVEN',
    retry_after_at: new Date(Date.now() - 1_000),
  };
  const reopened = { ...due, status: 'queued', stage: 'queued', error_code: null };
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM evm_audit_jobs/.test(sql) && /FOR UPDATE/.test(sql)) return { rows: [due] };
      if (/SET status = 'queued'/.test(sql)) return { rows: [reopened] };
      return { rows: [] };
    },
    release: () => {},
  };
  t.after(() => {
    database.connect = originalConnect;
    EvmAudit.ensureSubject = originalEnsureSubject;
  });
  database.connect = async () => client;
  EvmAudit.ensureSubject = async () => ({ id: 11, address: WALLET });

  const result = await EvmAudit.createOrFindActiveJob(7, { id: 3, address: WALLET }, {
    mode: 'full', requestedChains: [8453], credentialGeneration: null,
  });

  assert.equal(result.created, false);
  assert.equal(result.job.status, 'queued');
  assert.ok(calls.some(({ sql }) => /SET status = 'queued'/.test(sql)));
  assert.equal(calls.at(-1).sql, 'COMMIT');
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
  const rpc = new RpcClient(8453, { spacingMs: 0 });
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

test('nonce gaps are compact ranges and do not iterate across absent history', () => {
  assert.deepEqual(EvmAuditService._missingRanges(['0', '2', '2', '999999999'], 1000000000n), [
    { from: '1', to: '1' },
    { from: '3', to: '999999998' },
  ]);
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
    canonical, matchingLegacy, WALLET, chains.getChain(8453)
  ), 0);
  assert.equal(EvmAuditService._unmatchedEffectCount(
    canonical, [], WALLET, chains.getChain(8453)
  ), 1);
  assert.equal(EvmAuditService._unmatchedEffectCount(
    canonical, [...matchingLegacy, ...matchingLegacy], WALLET, chains.getChain(8453)
  ), 0);
  const duplicate = { ...matchingLegacy[0], id: 21 };
  assert.equal(EvmAuditService._unmatchedEffectCount(
    canonical, [matchingLegacy[0], duplicate], WALLET, chains.getChain(8453)
  ), 1);
  const uncoordinated = { ...matchingLegacy[0], id: 22, source_log_index: null };
  assert.ok(EvmAuditService._unmatchedEffectCount(
    canonical, [uncoordinated], WALLET, chains.getChain(8453)
  ) > 0, 'economic equality without immutable log identity remains a gap');
});

test('cross-provider transfer repair requires the exact Moralis log coordinate and payload', () => {
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
  assert.equal(matchesMoralisTransfer(effect, moralis), true);
  assert.equal(matchesMoralisTransfer(effect, {
    ...moralis, payload_json: { ...moralis.payload_json, value: 8 },
  }), true);
  assert.equal(matchesLegacyTransfer(effect, legacy), true);
  assert.equal(matchesMoralisTransfer(effect, { ...moralis, log_index: 4 }), false);
  assert.equal(matchesMoralisTransfer(effect, {
    ...moralis, payload_json: { ...moralis.payload_json, value: '9' },
  }), false);
  assert.equal(matchesLegacyTransfer(effect, { ...legacy, token_contract: OTHER }), false);
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
  assert.equal(matchesMoralisTransfer(effect, observation), true);
  assert.equal(matchesMoralisTransfer(effect, {
    ...observation, payload_json: { ...observation.payload_json, amount: '3' },
  }), false);
  assert.equal(matchesMoralisTransfer(effect, {
    ...observation, payload_json: { ...observation.payload_json, amount: null, value: '2' },
  }), false);
  assert.equal(matchesMoralisTransfer(effect, {
    ...observation, payload_json: { ...observation.payload_json, amount: [2] },
  }), false);
  assert.equal(matchesMoralisTransfer(effect, {
    ...observation,
    payload_json: {
      ...observation.payload_json, amount: '9007199254740992',
      __evm_json_numeric_fields: ['amount'],
    },
  }), false);
  assert.equal(matchesMoralisTransfer(effect, {
    ...observation,
    payload_json: {
      ...observation.payload_json, token_id: '9007199254740992',
      __evm_json_numeric_fields: ['token_id'],
    },
  }), false);
});

test('audit migration is additive, fail-closed, user-owned, and retires only Base routine state sync', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../migrations/077_evm_audit_evidence.sql'), 'utf8');
  assert.match(sql, /user_id INT NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(sql, /status <> 'complete'\s+OR \(requested_from_block IS NOT NULL AND requested_through_block IS NOT NULL AND pagination_exhausted\)/);
  assert.match(sql, /UNIQUE \(\s*subject_id, chain_id, provider, evidence_kind,/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS evm_provider_attempts/);
  assert.match(sql, /response_raw TEXT/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS evm_retired_feed_coverage/);
  assert.match(sql, /FOREIGN KEY \(subject_id, user_id\) REFERENCES evm_subjects/);
  assert.match(sql, /WHERE chain_id = 8453 AND feed = 'statesync'/);
  assert.doesNotMatch(sql, /DELETE FROM eth_transfers/i);
  assert.equal(chains.getChain(8453).stateSyncDeposits, undefined);
  assert.ok(chains.getChain(100).stateSyncDeposits,
    'Gnosis wallet-filtered native-credit evidence remains until the audit proves a replacement');
});
