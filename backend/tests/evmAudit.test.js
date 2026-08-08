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

test('identity repair keeps its canonical-effect query user-scoped', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/models/EvmAudit.js'), 'utf8');
  const methodStart = source.indexOf('static async repairCorroboratedTransferIdentities');
  const methodEnd = source.indexOf('\n  static async', methodStart + 1);
  const method = source.slice(methodStart, methodEnd);
  assert.match(method, /s\.user_id = \$1/);
  assert.match(method, /\[userId, subjectId, chainId, throughBlock/);
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
      WALLET, { chain: 'base', fromBlock: 0, throughBlock: 10 }
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
        .activeChains(WALLET, ['base']),
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
        .activeChains(WALLET, ['base']),
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
  const lookupPass = source.indexOf("for (const hash of hashes) {\n      if (moralisHashes.has(hash)) continue;");
  const canonicalization = source.indexOf("await EvmAudit.heartbeat(job.id, OWNER, { stage: 'canonicalizing' });", lookupPass);
  const finalization = source.indexOf(
    "await EvmAudit.completeScope(historyScope.id, { status: 'complete', paginationExhausted: true });",
    lookupPass
  );
  assert.ok(lookupPass >= 0);
  assert.ok(finalization > lookupPass && finalization < canonicalization,
    'lookup evidence must be followed by a final complete status before canonicalization');
});

test('consensus RPC requires matching receipt identity and canonical block membership', async () => {
  const rpc = new RpcClient(8453, { spacingMs: 0 });
  rpc.request = async (method) => ({
    eth_getTransactionByHash: { hash: HASH, blockNumber: '0xa', blockHash: BLOCK_HASH },
    eth_getTransactionReceipt: { transactionHash: HASH, blockNumber: '0xa', blockHash: BLOCK_HASH },
    eth_getBlockByNumber: { number: '0xa', hash: BLOCK_HASH },
  })[method];
  const result = await rpc.transactionAndReceipt(HASH);
  assert.equal(result.block.hash, BLOCK_HASH);
  rpc.request = async (method) => ({
    eth_getTransactionByHash: { hash: HASH, blockNumber: '0xa', blockHash: BLOCK_HASH },
    eth_getTransactionReceipt: { transactionHash: `0x${'ef'.repeat(32)}`, blockNumber: '0xa', blockHash: BLOCK_HASH },
  })[method];
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
