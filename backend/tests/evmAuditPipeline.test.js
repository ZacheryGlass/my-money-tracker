'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EvmAuditService = require('../src/services/EvmAuditService');
const EvmAudit = require('../src/models/EvmAudit');
const EtherscanService = require('../src/services/EtherscanService');
const RpcClient = require('../src/services/evmAudit/RpcClient');
const { TOPICS } = require('../src/services/evmAudit/effectDecoder');
const { sha256 } = require('../src/services/evmAudit/normalizer');

const WALLET = `0x${'11'.repeat(20)}`;
const OTHER = `0x${'22'.repeat(20)}`;
const TOKEN = `0x${'33'.repeat(20)}`;
const HASH = `0x${'ab'.repeat(32)}`;
const BLOCK_HASH = `0x${'cd'.repeat(32)}`;
const topic = (address) => `0x${address.slice(2).padStart(64, '0')}`;
const snake = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
  key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), value,
]));

function evidence(result, method = 'fixture', params = []) {
  const rawText = JSON.stringify({ jsonrpc: '2.0', id: 1, result });
  return { result, rawText, responseJson: JSON.parse(rawText),
    responseSha256: sha256(rawText), method, params };
}

// Execute the real orchestration and decoders. Only the database and provider
// boundaries are replaced; assertions concern durable outcomes, not source text.
function harness(t) {
  for (const method of ['get', 'post']) t.mock.method(require('axios'), method, async () => {
    throw new Error('Unexpected network request in audit fixture');
  });
  const scopes = new Map();
  const pages = [];
  const observations = [];
  const transactions = [];
  const effects = [];
  const balances = [];
  const attempts = [];
  const progress = {};
  let nextId = 0;
  const stub = (object, name, fn) => t.mock.method(object, name, fn);
  for (const name of ['linkEffectEvidence', 'linkTransactionEvidence', 'invalidateMissingRpcEffects',
    'setDiscoveredChains', 'storeNonceAudit']) stub(EvmAudit, name, async () => {});
  for (const name of ['storedTransferRows', 'storedFeedCoverage']) stub(EvmAudit, name, async () => []);
  for (const name of ['transactionConflictCount', 'provisionalEffectCount', 'requiredScopeGapCount',
    'backfillVerifiedEffects']) stub(EvmAudit, name, async () => 0);
  stub(EvmAudit, 'repairCorroboratedTransferIdentities', async () => ({ repaired: 0 }));
  stub(EvmAudit, 'heartbeat', async (_job, _owner, state) => {
    Object.assign(progress, state?.progress);
    return true;
  });
  stub(EvmAudit, 'upsertScope', async (_job, row) => {
    const key = `${row.provider}:${row.capability}`;
    const scope = scopes.get(key) || { id: ++nextId };
    Object.assign(scope, snake(row));
    scope.requested_from_block = row.fromBlock;
    scope.requested_through_block = row.throughBlock;
    scopes.set(key, scope);
    return scope;
  });
  stub(EvmAudit, 'completeScope', async (id, row) => {
    Object.assign([...scopes.values()].find((scope) => scope.id === id), snake(row));
  });
  stub(EvmAudit, 'commitPage', async (scopeId, page, rows) => {
    pages.push({ scopeId, ...page });
    const ids = rows.map((row) => {
      const observation = { id: ++nextId, ...snake(row) };
      observations.push(observation);
      return observation.id;
    });
    // Real persistence reopens a scope when lookup evidence is appended.
    [...scopes.values()].find((scope) => scope.id === scopeId).status = 'running';
    return { observationIds: ids };
  });
  stub(EvmAudit, 'acceptCoverage', async (row) => {
    scopes.get(`${row.provider}:${row.capability}`).accepted = true;
  });
  stub(EvmAudit, 'observationsForJob', async (_job, filter = {}) => observations.filter(
    (row) => !filter.evidenceKind || row.evidence_kind === filter.evidenceKind
  ));
  stub(EvmAudit, 'recordProviderAttempt', async (row) => attempts.push(row));
  stub(EvmAudit, 'upsertMinedTransaction', async (row) => {
    const stored = { id: ++nextId, ...snake(row) };
    transactions.push(stored);
    return stored;
  });
  stub(EvmAudit, 'upsertCanonicalEffect', async (row) => {
    const stored = { id: ++nextId, ...snake(row) };
    effects.push(stored);
    return stored;
  });
  stub(EvmAudit, 'canonicalTransactions', async () => transactions);
  stub(EvmAudit, 'canonicalEffects', async () => effects);
  stub(EvmAudit, 'verifiedConsensusReceiptHashes', async () => new Set());
  stub(EvmAudit, 'activityTxHashes', async () => new Set([HASH]));
  stub(EvmAudit, 'nativeDerivedAt', async () => '0');
  stub(EvmAudit, 'tokenDerivedAt', async () => []);
  stub(EvmAudit, 'observedErc20Contracts', async () => [
    { token_contract: TOKEN, token_decimals: 18 },
  ]);
  stub(EvmAudit, 'storeBalanceAudit', async (row) => balances.push(row));
  stub(EvmAudit, 'bridgeAudit', async () => ({ unresolved: [] }));
  stub(EtherscanService, 'coverageBoundary', async () => ({ throughBlock: 10 }));
  stub(EtherscanService, 'accountFeedPages', async function* () {
    yield { ...evidence([]), rows: [], requestParams: {}, itemCount: 0,
      cursorIn: '0', cursorOut: null };
  });
  stub(EtherscanService, 'stateSyncDepositPages', async function* () {
    yield { ...evidence([]), rows: [], requestParams: {}, itemCount: 0,
      cursorIn: '0', cursorOut: null };
  });
  const log = {
    address: TOKEN, transactionHash: HASH, blockNumber: '0x1', blockHash: BLOCK_HASH,
    transactionIndex: '0x0', logIndex: '0x0',
    topics: [TOPICS.transfer, topic(OTHER), topic(WALLET)],
    data: `0x${'7'.padStart(64, '0')}`,
  };
  stub(RpcClient.prototype, 'finalizedBoundary', async () => ({
    number: 10, numberHex: '0xa', hash: BLOCK_HASH, timestamp: '2020-01-01T00:00:00.000Z',
  }));
  stub(RpcClient.prototype, 'addressIndexedTokenLogPages', async function* () {
    yield { fromBlock: 0, throughBlock: 10, logs: [log], evidence: [evidence([log])],
      cursorIn: '0', cursorOut: '11' };
  });
  stub(RpcClient.prototype, 'transactionAndReceipt', async () => ({
    transaction: { hash: HASH, blockNumber: '0x1', blockHash: BLOCK_HASH,
      from: OTHER, to: TOKEN, value: '0x0', nonce: '0x0', input: '0x', type: '0x2' },
    receipt: { transactionHash: HASH, blockNumber: '0x1', blockHash: BLOCK_HASH,
      status: '0x1', gasUsed: '0x0', effectiveGasPrice: '0x0', logs: [log] },
    block: { number: '0x1', hash: BLOCK_HASH, timestamp: '0x5e0be100' }, evidence: [],
  }));
  for (const [method, value] of [['balance', 0n], ['transactionCount', 0n], ['code', '0x']]) {
    stub(RpcClient.prototype, `${method}WithEvidence`, async () => ({ value, evidence: evidence(String(value)) }));
  }
  stub(RpcClient.prototype, 'erc20BalanceWithEvidence', async (_contract, _wallet, tag) => ({
    value: tag === '0xa' ? 7n : 0n, evidence: evidence(tag === '0xa' ? '0x7' : '0x0'),
  }));
  stub(RpcClient.prototype, 'blockByNumberWithEvidence', async (number) => ({
    value: { number, hash: BLOCK_HASH }, evidence: evidence({ number, hash: BLOCK_HASH }),
  }));
  const run = (options = {}) => EvmAuditService.runChain({
    job: { id: 1, subject_id: 1, requested_wallet_id: 1, user_id: 1, address: WALLET, mode: 'full' },
    chainId: 1, moralis: null, activeResponse: {}, discovered: [{ chain_id: 1 }],
    leaseState: { lost: false }, retainAttempt: async () => {}, explorerApiKey: 'fixture-key',
    ...options,
  });
  return { run, scopes, pages, effects, balances, attempts, progress, observations };
}

test('audit retains an explorer omission, exact token effect, and unresolved coverage gaps', async (t) => {
  const audit = harness(t);
  const result = await audit.run();
  assert.equal(result.transactions, 1, 'RPC token logs discover the omitted transaction');
  assert.ok(audit.effects.some((row) => row.token_contract === TOKEN && row.value_units === '7'));
  const balance = audit.balances.find((row) => row.assetKey === TOKEN);
  assert.equal(balance.liveUnits, '7');
  assert.equal(balance.deltaUnits, '7');
  assert.equal(balance.status, 'mismatch');
  assert.equal(balance.detail.historical_check.status, 'match');
  assert.equal(audit.scopes.get('consensus-rpc:indexed_token_logs').accepted, true);
  assert.equal(audit.scopes.get('etherscan:wallet_history').status, 'complete');
  assert.equal(audit.scopes.get('consensus-rpc:receipt_verification').status, 'unverified');
  assert.equal(audit.scopes.get('trace-rpc:internal').status, 'unsupported');
  assert.equal(audit.progress.chain_1.receipt_enumeration_gap, 1);
  assert.equal(audit.progress.chain_1.historical_state_gap, 1);
  assert.equal(result.gaps, 4);
});

test('Moralis lookup evidence leaves exhausted history complete after canonicalization', async (t) => {
  const audit = harness(t);
  audit.observations.push({ id: 1000, provider: 'existing-ledger', tx_hash: HASH, block_number: 1 });
  const moralis = {
    async *walletHistoryPages() {
      yield { body: {}, items: [], cursorIn: null, cursorOut: null };
    },
    async transactionByHash() { return { body: { hash: HASH, block_number: '1' } }; },
  };
  await audit.run({ chainId: 100, moralis, activeResponse: { body: { active_chains: [] } } });
  assert.ok(audit.pages.some((page) => page.endpoint === 'transaction-lookup'));
  assert.equal(audit.scopes.get('moralis:wallet_history').status, 'complete');
});

test('an evidence write failure remains a database failure', async (t) => {
  const audit = harness(t);
  const commit = EvmAudit.commitPage;
  t.mock.method(EvmAudit, 'commitPage', async (...args) => {
    if (args[1].endpoint === 'account-normal') {
      throw Object.assign(new Error('fixture serialization failure'), { code: '40001' });
    }
    return commit(...args);
  });
  await assert.rejects(audit.run(), { code: '40001' });
  assert.equal(audit.attempts.length, 0);
});

test('a later explorer failure preserves the committed page without accepting coverage', async (t) => {
  const audit = harness(t);
  t.mock.method(EtherscanService, 'accountFeedPages', async function* () {
    yield { ...evidence([]), rows: [], requestParams: {}, itemCount: 0,
      cursorIn: '0', cursorOut: '1' };
    assert.ok(audit.pages.some((page) => page.endpoint === 'account-normal'));
    throw Object.assign(new Error('fixture provider failure'), { code: 'ETHERSCAN_API_ERROR' });
  });
  await assert.rejects(audit.run(), { code: 'ETHERSCAN_FEED_FAILED' });
  assert.equal(audit.scopes.get('etherscan:normal').accepted, undefined);
  assert.equal(audit.attempts.length, 1);
  assert.deepEqual(audit.attempts[0].requestParams, { address: WALLET, from_block: 0, to_block: 10 });
});

test('a lost audit lease stops before requesting another explorer page', async (t) => {
  const audit = harness(t);
  let nextRequested = false;
  t.mock.method(EtherscanService, 'accountFeedPages', async function* () {
    yield { ...evidence([]), rows: [], requestParams: {}, itemCount: 0,
      cursorIn: '0', cursorOut: '1' };
    nextRequested = true;
  });
  t.mock.method(EvmAudit, 'heartbeat', async (_job, _owner, state) => state?.progress?.current_cursor !== '1');
  await assert.rejects(audit.run(), { code: 'EVM_AUDIT_LEASE_LOST' });
  assert.equal(nextRequested, false);
  assert.equal(audit.attempts.length, 0, 'a lost lease is not a provider failure');
});
