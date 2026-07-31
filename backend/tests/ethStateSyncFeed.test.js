'use strict';

// Polygon state-sync native deposits (#76): the SIXTH per-(wallet, chain) feed.
//
// Bridged-in native POL is credited by the Bor state sync, a system transaction
// that appears in none of the five Etherscan account feeds -- so the derived
// balance drifts below what the chain reports until this feed ingests the
// `Deposit` log on the MRC20 precompile. The tests cover, top to bottom:
//   * the getLogs fetch + parse (hex fields, amount = first 32 bytes of data)
//   * the per-chain declaration: the feed runs only where chains.js declares it
//   * delete scoping: the state-sync feed and the internal feed share
//     transfer_type='internal' but must not clear each other's rows
//   * the reconciliation native gate now covers the feed on declaring chains
//   * the bridge halves classify and pair (rung 3 + the amount/time matcher)

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const queries = [];
const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      async query(text, params) {
        queries.push({ text, params });
        return { rows: [], rowCount: 0 };
      }
      connect() { throw new Error('Unexpected connect'); }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const chains = require('../src/config/chains');
const EthWalletService = require('../src/services/EthWalletService');
const EtherscanService = require('../src/services/EtherscanService');
const EthWallet = require('../src/models/EthWallet');
const EthWalletChain = require('../src/models/EthWalletChain');
const EthFeedCoverage = require('../src/models/EthFeedCoverage');
const EthTransfer = require('../src/models/EthTransfer');
const SecretsService = require('../src/services/SecretsService');
const EthDerivedPipeline = require('../src/services/EthDerivedPipeline');
const EthReconciliationService = require('../src/services/EthReconciliationService');
const MethodSignatureService = require('../src/services/MethodSignatureService');
const EthActivityService = require('../src/services/EthActivityService');

const { pairBridgeLegs, bridgeAsset, buildActivityRows } = EthActivityService;

// Synthetic actors by rule -- real wallet addresses, tx hashes and amounts are
// personal history and the repo is public. The precompile, DepositManager and
// topic0 are public contract constants and stay real.
const WALLET = '0x1234567890abcdef1234567890abcdef12345678';
const PRECOMPILE = '0x0000000000000000000000000000000000001010';
const DEPOSIT_MANAGER = '0x401f6c983ea34274ec46f84d70b31c151321188b';
const TOPIC0 = '0x4e2ca0515ed1aef1395f66b5303bb5d6f1bf9d61a353fa53f73f8ac9973fa9f6';
const GNOSIS_REWARD = '0x481c034c6d9441db23ea48de68bcae812c5d39ba';
const ADDED_RECEIVER_TOPIC0 = '0x3c798bbcf33115b42c728b8504cff11dd58736e9fa789f1cda2738db7d696b2a';
const GNOSIS_BRIDGE = '0x7301cfa0e1756b71869e93d4e4dca5c7d0eb0aa6';
const OP_STACK_BRIDGE = '0x4200000000000000000000000000000000000010';
const ETH_BRIDGE_FINALIZED_TOPIC0 = '0x31b2166ff604fc5672ea5df08a78081d2bc6d746cadce880747f3643d819e83d';
const DEPOSIT_TX = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const DEPOSIT_WEI = '47250000000000000000'; // 47.25 POL
const WALLET_2 = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

const sqlOf = (query) => query.text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

function stubScanHead(t, block = 90000000) {
  const original = EtherscanService._latestBlockNumber;
  EtherscanService._latestBlockNumber = async () => block;
  t.after(() => { EtherscanService._latestBlockNumber = original; });
}

// A getLogs Deposit log as Etherscan V2 returns it: hex blockNumber/timeStamp/
// logIndex, data = amount ++ input1 ++ output1 (three 32-byte words).
function depositLog({ amountWei = DEPOSIT_WEI, block = 84000001, ts = 1742000000, hash = DEPOSIT_TX, logIndex = 3 } = {}) {
  const word = (v) => BigInt(v).toString(16).padStart(64, '0');
  return {
    address: PRECOMPILE,
    topics: [TOPIC0, `0x${'0'.repeat(24)}${PRECOMPILE.slice(2)}`, `0x${'0'.repeat(24)}${WALLET.slice(2)}`],
    data: `0x${word(amountWei)}${word('999')}${word('111')}`,
    blockNumber: `0x${block.toString(16)}`,
    timeStamp: `0x${ts.toString(16)}`,
    logIndex: `0x${logIndex.toString(16)}`,
    transactionHash: hash,
  };
}

function addedReceiverLog({ amountWei = DEPOSIT_WEI, block = 13903200, ts = 1609959945, hash = DEPOSIT_TX, logIndex = 23 } = {}) {
  const topicAddress = (address) => `0x${'0'.repeat(24)}${address.slice(2)}`;
  return {
    address: GNOSIS_REWARD,
    topics: [ADDED_RECEIVER_TOPIC0, topicAddress(WALLET), topicAddress(GNOSIS_BRIDGE)],
    data: `0x${BigInt(amountWei).toString(16).padStart(64, '0')}`,
    blockNumber: `0x${block.toString(16)}`,
    timeStamp: `0x${ts.toString(16)}`,
    logIndex: `0x${logIndex.toString(16)}`,
    transactionHash: hash,
  };
}

function ethBridgeFinalizedLog({
  amountWei = DEPOSIT_WEI,
  block = 49293680,
  ts = 1785370265,
  hash = DEPOSIT_TX,
  logIndex = 1,
  wallet = WALLET,
} = {}) {
  const topicAddress = (address) => `0x${'0'.repeat(24)}${address.slice(2)}`;
  return {
    address: OP_STACK_BRIDGE,
    topics: [ETH_BRIDGE_FINALIZED_TOPIC0, topicAddress(wallet), topicAddress(wallet)],
    data: `0x${BigInt(amountWei).toString(16).padStart(64, '0')}${'0'.repeat(64)}`,
    blockNumber: `0x${block.toString(16)}`,
    timeStamp: `0x${ts.toString(16)}`,
    logIndex: `0x${logIndex.toString(16)}`,
    transactionHash: hash,
  };
}

// ---------------------------------------------------------------------------
// The registry declaration
// ---------------------------------------------------------------------------

test('Polygon, Gnosis, OP Mainnet, and Base declare verified native-credit logs', () => {
  for (const chain of chains.allChains()) {
    if (chain.id === 137) {
      assert.ok(chain.stateSyncDeposits, 'Polygon must declare the state-sync feed');
      assert.equal(chain.stateSyncDeposits.contract, PRECOMPILE);
      assert.equal(chain.stateSyncDeposits.topic0, TOPIC0);
    } else if (chain.id === 100) {
      assert.equal(chain.stateSyncDeposits.contract, GNOSIS_REWARD);
      assert.equal(chain.stateSyncDeposits.topic0, ADDED_RECEIVER_TOPIC0);
      assert.equal(chain.stateSyncDeposits.userTopicIndex, 1);
    } else if (chain.id === 10 || chain.id === 8453) {
      assert.equal(chain.stateSyncDeposits.contract, OP_STACK_BRIDGE);
      assert.equal(chain.stateSyncDeposits.topic0, ETH_BRIDGE_FINALIZED_TOPIC0);
      assert.equal(chain.stateSyncDeposits.userTopicIndex, 2);
      if (chain.id === 8453) {
        assert.deepEqual(chain.stateSyncDeposits.rpcScan, {
          blockRange: 10000,
          batchSize: 10,
          concurrency: 2,
        });
      }
    } else {
      assert.equal(chain.stateSyncDeposits, undefined,
        `chain ${chain.id} must NOT declare a state-sync feed`);
    }
  }
});

test('the legacy OP Stack log feed filters topic2 and becomes a native inbound row', async (t) => {
  stubScanHead(t, 50000000);
  const axios = require('axios');
  const original = axios.get;
  const seen = [];
  axios.get = async (url, config) => {
    seen.push({ url, params: config.params });
    return { data: { status: '1', result: [ethBridgeFinalizedLog()] } };
  };
  t.after(() => { axios.get = original; });

  const rows = await EtherscanService.fetchStateSyncDeposits(
    WALLET, 0, null, 10, chains.getChain(10).stateSyncDeposits
  );

  assert.equal(seen[0].url, 'https://explorer.optimism.io/api');
  assert.equal(seen[0].params.topic2, `0x${'0'.repeat(24)}${WALLET.slice(2)}`);
  assert.equal(seen[0].params.topic0_2_opr, 'and');
  assert.deepEqual(rows, [{
    hash: DEPOSIT_TX,
    blockNumber: '49293680',
    timeStamp: '1785370265',
    from: OP_STACK_BRIDGE,
    to: WALLET,
    value: DEPOSIT_WEI,
  }]);
});

test('Base scans bounded RPC windows once for several wallet receiver topics', async (t) => {
  const original = EtherscanService._rpcBatchRequest;
  const calls = [];
  EtherscanService._rpcBatchRequest = async (chainId, batch) => {
    calls.push({ chainId, batch });
    if (batch[0].method === 'eth_getLogs') {
      return batch.map((call) => {
        const from = parseInt(call.params[0].fromBlock, 16);
        if (from === 0) {
          return [
            ethBridgeFinalizedLog({
              block: 5000, wallet: WALLET, hash: '0xwallet1', logIndex: 1,
            }),
            // Below WALLET_2's requested cursor: the shared scan may see it,
            // but that wallet's overlap replacement must not.
            ethBridgeFinalizedLog({
              block: 5000, wallet: WALLET_2, hash: '0xwallet2old', logIndex: 2,
            }),
          ];
        }
        return [ethBridgeFinalizedLog({
          block: 15000, wallet: WALLET_2, hash: '0xwallet2new', logIndex: 3,
        })];
      });
    }
    return batch.map((call) => ({
      timestamp: `0x${(1700000000 + parseInt(call.params[0], 16)).toString(16)}`,
    }));
  };
  t.after(() => { EtherscanService._rpcBatchRequest = original; });

  const rowsByAddress = await EtherscanService.fetchStateSyncDepositsBatch(
    [
      { address: WALLET, startBlock: 0 },
      { address: WALLET_2, startBlock: 10000 },
    ],
    8453,
    {
      ...chains.getChain(8453).stateSyncDeposits,
      rpcScan: { blockRange: 10000, batchSize: 50 },
    },
    19999
  );

  assert.equal(calls[0].chainId, 8453);
  assert.equal(calls[0].batch.length, 2, 'two 10k filters share one JSON-RPC POST');
  assert.deepEqual(calls[0].batch.map((call) => call.params[0].fromBlock), ['0x0', '0x2710']);
  assert.equal(calls[0].batch[0].params[0].topics[2].length, 2,
    'both receiver topics are OR-ed inside each bounded filter');
  assert.deepEqual(rowsByAddress.get(WALLET).map((row) => row.hash), ['0xwallet1']);
  assert.deepEqual(rowsByAddress.get(WALLET_2).map((row) => row.hash), ['0xwallet2new']);
  assert.equal(rowsByAddress.get(WALLET).scannedThroughBlock, 19999);
  assert.equal(rowsByAddress.get(WALLET_2).scannedThroughBlock, 19999);
});

test('Base retries a rate-limited JSON-RPC batch before failing the feed', async (t) => {
  const axios = require('axios');
  const original = axios.post;
  let requests = 0;
  axios.post = async () => {
    requests += 1;
    if (requests === 1) return { data: { error: { message: 'over rate limit' } } };
    return { data: [{ jsonrpc: '2.0', id: 1, result: [] }] };
  };
  t.after(() => { axios.post = original; });

  const result = await EtherscanService._rpcBatchRequest(8453, [{
    method: 'eth_getLogs',
    params: [{ fromBlock: '0x0', toBlock: '0x1', topics: [] }],
  }]);

  assert.equal(requests, 2);
  assert.deepEqual(result, [[]]);
});

test('the nightly prefetch shares one Base scan across every wallet', async (t) => {
  const priorChains = process.env.ETH_CHAINS;
  process.env.ETH_CHAINS = '8453';
  const originalStates = EthWalletChain.findAllForWallets;
  const originalHead = EtherscanService._latestBlockNumber;
  const originalBatch = EtherscanService.fetchStateSyncDepositsBatch;
  const seen = [];
  EthWalletChain.findAllForWallets = async () => [
    { wallet_id: 1, chain_id: 8453, ingest_version: 1, last_block_statesync: 20000 },
    { wallet_id: 2, chain_id: 8453, ingest_version: 1, last_block_statesync: 30000 },
  ];
  EtherscanService._latestBlockNumber = async () => 50000;
  EtherscanService.fetchStateSyncDepositsBatch = async (requests, chainId, config, head) => {
    seen.push({ requests, chainId, config, head });
    const one = [];
    const two = [];
    Object.defineProperty(one, 'scannedThroughBlock', { value: head });
    Object.defineProperty(two, 'scannedThroughBlock', { value: head });
    return new Map([[WALLET, one], [WALLET_2, two]]);
  };
  t.after(() => {
    EthWalletChain.findAllForWallets = originalStates;
    EtherscanService._latestBlockNumber = originalHead;
    EtherscanService.fetchStateSyncDepositsBatch = originalBatch;
    if (priorChains === undefined) delete process.env.ETH_CHAINS;
    else process.env.ETH_CHAINS = priorChains;
  });

  const prefetched = await EthWalletService._prefetchStateSyncForWallets([
    { id: 1, address: WALLET },
    { id: 2, address: WALLET_2 },
  ]);

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].requests, [
    { address: WALLET, startBlock: 19936 },
    { address: WALLET_2, startBlock: 29936 },
  ]);
  assert.equal(seen[0].chainId, 8453);
  assert.equal(seen[0].head, 50000);
  assert.equal(prefetched.get(1).get(8453).rows.scannedThroughBlock, 50000);
  assert.equal(prefetched.get(2).get(8453).rows.scannedThroughBlock, 50000);
  assert.equal(prefetched.get(1).get(8453).indexedHead, 50000);
  assert.equal(prefetched.get(2).get(8453).indexedHead, 50000);
});

test('Gnosis AddedReceiver filters topic1 and becomes a native inbound row', async (t) => {
  stubScanHead(t, 14000000);
  const axios = require('axios');
  const original = axios.get;
  const seen = [];
  axios.get = async (url, config) => {
    seen.push(config.params);
    return { data: { status: '1', result: [addedReceiverLog()] } };
  };
  t.after(() => { axios.get = original; });

  const rows = await EtherscanService.fetchStateSyncDeposits(
    WALLET, 0, null, 100, chains.getChain(100).stateSyncDeposits
  );

  assert.equal(seen[0].topic1, `0x${'0'.repeat(24)}${WALLET.slice(2)}`);
  assert.equal(seen[0].topic0_1_opr, 'and');
  assert.equal(seen[0].topic2, undefined);
  assert.equal(seen[0].chainid, undefined);
  assert.equal(seen[0].apikey, undefined);
  assert.deepEqual(rows, [{
    hash: DEPOSIT_TX,
    blockNumber: '13903200',
    timeStamp: '1609959945',
    from: GNOSIS_REWARD,
    to: WALLET,
    value: DEPOSIT_WEI,
  }]);
});

// ---------------------------------------------------------------------------
// EtherscanService.fetchStateSyncDeposits: the getLogs fetch and parse
// ---------------------------------------------------------------------------

test('the fetch sends address+topic0+topic2 and parses the log into an internal-row shape', async (t) => {
  stubScanHead(t);
  const axios = require('axios');
  const original = axios.get;
  const seen = [];
  axios.get = async (url, config) => {
    seen.push(config.params);
    return { data: { status: '1', result: [depositLog()] } };
  };
  t.after(() => { axios.get = original; });

  const rows = await EtherscanService.fetchStateSyncDeposits(
    WALLET, 0, 'key', 137, chains.getChain(137).stateSyncDeposits
  );

  const params = seen[0];
  assert.equal(params.module, 'logs');
  assert.equal(params.action, 'getLogs');
  assert.equal(params.address, PRECOMPILE);
  assert.equal(params.topic0, TOPIC0);
  // The wallet as a 32-byte indexed topic (12 zero bytes, then the 20 address
  // bytes), and AND-ed with topic0 so the co-emitted LogTransfer log is excluded.
  assert.equal(params.topic2, `0x${'0'.repeat(24)}${WALLET.slice(2)}`);
  assert.equal(params.topic0_2_opr, 'and');
  assert.equal(params.chainid, 137);

  // Shaped exactly like a txlistinternal row so normalizeFeeds ingests it as an
  // internal leg: decimal strings, from = the precompile, to = the wallet.
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    hash: DEPOSIT_TX,
    blockNumber: '84000001',
    timeStamp: '1742000000',
    from: PRECOMPILE,
    to: WALLET,
    value: DEPOSIT_WEI,
  });
});

test('the amount is the FIRST 32 bytes of data; the trailing words are ignored', async (t) => {
  stubScanHead(t);
  const axios = require('axios');
  const original = axios.get;
  axios.get = async () => ({ data: { status: '1', result: [depositLog({ amountWei: '1' })] } });
  t.after(() => { axios.get = original; });

  const rows = await EtherscanService.fetchStateSyncDeposits(
    WALLET, 0, 'key', 137, chains.getChain(137).stateSyncDeposits
  );
  // '999'/'111' fill input1/output1 in the log; reading past word 0 would return
  // one of those instead of the amount.
  assert.equal(rows[0].value, '1');
});

test('a chain with no feed config fetches nothing and calls no endpoint', async (t) => {
  const axios = require('axios');
  const original = axios.get;
  let called = false;
  axios.get = async () => { called = true; return { data: { status: '1', result: [] } }; };
  t.after(() => { axios.get = original; });

  assert.deepEqual(await EtherscanService.fetchStateSyncDeposits(WALLET, 0, 'key', 137, null), []);
  assert.equal(called, false, 'no config means no request');
});

test('an empty getLogs answer is a normal empty feed, not an error', async (t) => {
  stubScanHead(t, 91234567);
  const axios = require('axios');
  const original = axios.get;
  // The logs module answers an empty match "No records found", which #76 taught
  // _request to treat like "No transactions found".
  axios.get = async () => ({ data: { status: '0', message: 'No records found', result: [] } });
  t.after(() => { axios.get = original; });

  const rows = await EtherscanService.fetchStateSyncDeposits(
    WALLET, 0, 'key', 137, chains.getChain(137).stateSyncDeposits
  );
  assert.deepEqual(rows, []);
  assert.equal(rows.scannedThroughBlock, 91234567,
    'a successful empty scan advances coverage instead of rescanning genesis');
});

test('the fetch walks the block cursor and dedups the boundary block', async (t) => {
  stubScanHead(t, 1200);
  const axios = require('axios');
  const original = axios.get;
  // A FULL first page (1000 rows, one per block 100..1099) forces a second call;
  // that call resumes at the last block seen and returns it again plus one new
  // row, so the boundary dup must be dropped.
  const firstPage = Array.from({ length: 1000 }, (_, i) =>
    depositLog({ block: 100 + i, hash: `0x${(100 + i).toString(16)}`, logIndex: 0 }));
  const seenFromBlocks = [];
  axios.get = async (url, config) => {
    seenFromBlocks.push(config.params.fromBlock);
    if (config.params.fromBlock === 0) return { data: { status: '1', result: firstPage } };
    return {
      data: {
        status: '1',
        result: [
          depositLog({ block: 1099, hash: '0x44b', logIndex: 0 }), // dup of page 1's last
          depositLog({ block: 1100, hash: '0x44c', logIndex: 0 }), // new
        ],
      },
    };
  };
  t.after(() => { axios.get = original; });

  const rows = await EtherscanService.fetchStateSyncDeposits(
    WALLET, 0, 'key', 137, chains.getChain(137).stateSyncDeposits
  );

  assert.equal(seenFromBlocks.length, 2, 'a full page triggers exactly one more fetch');
  assert.equal(seenFromBlocks[1], 1099, 'the walk resumes at the last block of the full page');
  assert.equal(rows.length, 1001, 'the boundary-block dup is dropped, the one new row kept');
  assert.equal(new Set(rows.map((r) => r.hash)).size, 1001);
});

// ---------------------------------------------------------------------------
// Wiring into sync: per-chain declaration, ingest, delete scoping, cursor
// ---------------------------------------------------------------------------

// A focused harness: stubs Etherscan (six feeds), the transfer writes, and the
// derived-data pipeline that runs after all chains land, then records the
// (chain, feed) calls the sync actually made.
function harness(t, { chainSet, cursors = {}, feedBehavior = {} } = {}) {
  const restore = [];
  const stub = (obj, key, fn) => { restore.push([obj, key, obj[key]]); obj[key] = fn; };
  const priorChains = process.env.ETH_CHAINS;
  if (chainSet !== undefined) process.env.ETH_CHAINS = chainSet;
  t.after(() => {
    for (const [o, k, v] of restore.reverse()) o[k] = v;
    if (priorChains === undefined) delete process.env.ETH_CHAINS;
    else process.env.ETH_CHAINS = priorChains;
  });

  const calls = {
    fetches: [], heads: [], deletes: [], cursors: [], unsupported: [],
    chainErrors: [], cleared: [], inserted: [], coverage: [],
  };

  stub(EthWallet, 'findById', async () => ({ id: 7, user_id: 1, address: WALLET }));
  stub(SecretsService, 'getUserKey', async () => 'key');
  stub(EtherscanService, 'coverageBoundary', async (apiKey, chainId) => {
    calls.heads.push({ chainId, apiKey });
    return {
      fromBlock: 0,
      throughBlock: 90000000,
      fromAt: new Date('2015-07-30T00:00:00Z'),
      throughAt: new Date('2026-07-30T00:00:00Z'),
    };
  });
  stub(EthFeedCoverage, 'recordAttempts', async (walletId, chainId, entries) => {
    calls.coverage.push({ walletId, chainId, entries });
    return entries;
  });
  stub(EthWalletChain, 'ensure', async (walletId, chainId, ingestVersion = 0) => ({
    wallet_id: walletId,
    chain_id: chainId,
    ingest_version: ingestVersion,
    last_block_normal: 0, last_block_internal: 0, last_block_token: 0,
    last_block_nft: 0, last_block_1155: 0, last_block_statesync: 0,
    ...(cursors[chainId] || {}),
  }));
  stub(EthWalletChain, 'resetForIngestVersion', async (walletId, chainId, ingestVersion) => ({
    wallet_id: walletId,
    chain_id: chainId,
    ingest_version: ingestVersion,
    last_block_normal: 0, last_block_internal: 0, last_block_token: 0,
    last_block_nft: 0, last_block_1155: 0, last_block_statesync: 0,
  }));

  const feeds = {
    fetchNormalTxs: 'normal',
    fetchInternalTxs: 'internal',
    fetchTokenTxs: 'token',
    fetchNftTxs: 'nft',
    fetch1155Txs: 'nft1155',
    fetchStateSyncDeposits: 'statesync',
  };
  for (const [method, key] of Object.entries(feeds)) {
    stub(EtherscanService, method, async (
      address, startBlock, apiKey, chainId, feedConfig, indexedHead
    ) => {
      const coverage = key === 'statesync' ? indexedHead : feedConfig;
      calls.fetches.push({
        feed: key, chainId, startBlock, address,
        feedConfig: key === 'statesync' ? feedConfig : undefined,
        coverage,
      });
      const behavior = feedBehavior[`${chainId}:${key}`];
      const rows = typeof behavior === 'function' ? await behavior() : (behavior || []);
      if (coverage != null && Array.isArray(rows) && rows.scannedThroughBlock == null) {
        Object.defineProperty(rows, 'scannedThroughBlock', {
          value: coverage,
          enumerable: false,
        });
      }
      return rows;
    });
  }

  stub(EthTransfer, 'deleteFromBlock', async (walletId, chainId, types, block, opts = {}) => {
    calls.deletes.push({ chainId, types: types.join(','), block, ...opts });
  });
  stub(EthTransfer, 'bulkInsert', async (rows) => { calls.inserted.push(...rows); return rows.length; });
  stub(EthWalletChain, 'updateCursors', async (walletId, chainId, next) => {
    calls.cursors.push({ chainId, ...next });
  });
  stub(EthWalletChain, 'setUnsupportedFeeds', async (walletId, chainId, list) => {
    calls.unsupported.push({ chainId, list });
  });
  stub(EthWalletChain, 'setError', async (walletId, chainId, code, message) => {
    calls.chainErrors.push({ chainId, code, message });
  });
  stub(EthWalletChain, 'clearError', async (walletId, chainId) => { calls.cleared.push(chainId); });
  stub(EthWalletChain, 'updateSyncTime', async () => {});
  stub(EthWalletChain, 'findForWallet', async () => []);

  // Everything derived from the transfers is rebuilt once after all chains land;
  // it is not what these tests exercise, so it is stubbed to no-ops.
  stub(EthDerivedPipeline, 'serializedForUser', async (userId, fn) => fn());
  stub(EthDerivedPipeline, 'rebuildWallet', async () => ({ holdings: { liveWeiByChain: {} } }));
  stub(EthDerivedPipeline, 'finishUser', async () => ({}));
  stub(EthReconciliationService, 'reconcileWallet', async () => ({}));
  stub(MethodSignatureService, 'decodePendingForWallet', async () => ({}));
  stub(EthWallet, 'clearError', async () => { calls.walletCleared = true; });
  stub(EthWallet, 'setError', async (id, code, message) => { calls.walletError = { code, message }; });
  stub(EthWallet, 'updateSyncTime', async () => {});

  return { calls, stub };
}

test('the native-credit feed runs only on its declaring chains', async (t) => {
  const { calls } = harness(t, { chainSet: '1,10,100,137,8453,42161' });

  await EthWalletService.syncWallet(7);

  const stateSyncChains = calls.fetches.filter((c) => c.feed === 'statesync').map((c) => c.chainId);
  assert.deepEqual(stateSyncChains, [137, 100, 10, 8453], 'only declaring chains fetch the feed');
  // Declaring chains run SIX feeds, every other chain runs five.
  assert.equal(calls.fetches.filter((c) => c.chainId === 137).length, 6);
  assert.equal(calls.fetches.filter((c) => c.chainId === 100).length, 6);
  assert.equal(calls.fetches.filter((c) => c.chainId === 10).length, 6);
  assert.equal(calls.fetches.filter((c) => c.chainId === 8453).length, 6);
  assert.equal(calls.fetches.filter((c) => c.chainId === 1).length, 5);
  assert.equal(calls.fetches.filter((c) => c.chainId === 42161).length, 5);
  // The feed receives the chain's declared config (the account feeds get none).
  const polygonCall = calls.fetches.find((c) => c.feed === 'statesync' && c.chainId === 137);
  const gnosisCall = calls.fetches.find((c) => c.feed === 'statesync' && c.chainId === 100);
  const optimismCall = calls.fetches.find((c) => c.feed === 'statesync' && c.chainId === 10);
  const baseCall = calls.fetches.find((c) => c.feed === 'statesync' && c.chainId === 8453);
  assert.equal(polygonCall.feedConfig.contract, PRECOMPILE);
  assert.equal(gnosisCall.feedConfig.contract, GNOSIS_REWARD);
  assert.equal(optimismCall.feedConfig.contract, OP_STACK_BRIDGE);
  assert.equal(baseCall.feedConfig.contract, OP_STACK_BRIDGE);
});

test('a state-sync deposit ingests as an internal leg from the precompile', async (t) => {
  const { calls } = harness(t, {
    chainSet: '137',
    feedBehavior: {
      '137:statesync': [{
        hash: DEPOSIT_TX, blockNumber: '84000001', timeStamp: '1742000000',
        from: PRECOMPILE, to: WALLET, value: DEPOSIT_WEI,
      }],
    },
  });

  await EthWalletService.syncWallet(7);

  const internal = calls.inserted.filter((r) => r.transfer_type === 'internal');
  assert.equal(internal.length, 1);
  assert.equal(internal[0].from_address, PRECOMPILE);
  assert.equal(internal[0].to_address, WALLET);
  assert.equal(internal[0].value_wei, DEPOSIT_WEI);
  assert.equal(internal[0].chain_id, 137);
  // transfer_type='internal' is what makes nativeBalanceDeltas (which sums
  // native+internal-gas) count the credit with no change of its own.
});

test('a Gnosis AddedReceiver credit ingests as a bridge-classifiable internal leg', async (t) => {
  const { calls } = harness(t, {
    chainSet: '100',
    feedBehavior: {
      '100:statesync': [{
        hash: DEPOSIT_TX,
        blockNumber: '13903200',
        timeStamp: '1609959945',
        from: GNOSIS_REWARD,
        to: WALLET,
        value: DEPOSIT_WEI,
      }],
    },
  });

  await EthWalletService.syncWallet(7);

  const [credit] = calls.inserted.filter((row) => row.transfer_type === 'internal');
  assert.equal(credit.from_address, GNOSIS_REWARD);
  assert.equal(credit.to_address, WALLET);
  assert.equal(credit.value_wei, DEPOSIT_WEI);
  assert.equal(credit.chain_id, 100);
});

test('an OP Stack ETHBridgeFinalized credit ingests once from the labeled bridge', async (t) => {
  const { calls } = harness(t, {
    chainSet: '8453',
    feedBehavior: {
      '8453:statesync': [{
        hash: DEPOSIT_TX,
        blockNumber: '49293680',
        timeStamp: '1785370265',
        from: OP_STACK_BRIDGE,
        to: WALLET,
        value: DEPOSIT_WEI,
      }],
      // If Blockscout later serves the same internal trace, the symmetric
      // bridge-source filter must prevent a duplicate native credit.
      '8453:internal': [{
        hash: DEPOSIT_TX,
        blockNumber: '49293680',
        timeStamp: '1785370265',
        from: OP_STACK_BRIDGE,
        to: WALLET,
        value: DEPOSIT_WEI,
      }],
    },
  });

  await EthWalletService.syncWallet(7);

  const credits = calls.inserted.filter((row) => row.transfer_type === 'internal');
  assert.equal(credits.length, 1);
  assert.equal(credits[0].from_address, OP_STACK_BRIDGE);
  assert.equal(credits[0].chain_id, 8453);
});

test('the two internal-typed feeds do not clear each other: delete windows split by from_address', async (t) => {
  const { calls } = harness(t, { chainSet: '137' });

  await EthWalletService.syncWallet(7);

  const stateSyncDelete = calls.deletes.find((d) => d.fromAddress);
  const internalDelete = calls.deletes.find((d) => d.types === 'internal' && d.excludeFromAddress);

  // The state-sync feed deletes ONLY its own precompile rows...
  assert.ok(stateSyncDelete, 'the state-sync delete is scoped to from_address');
  assert.equal(stateSyncDelete.fromAddress, PRECOMPILE);
  assert.equal(stateSyncDelete.types, 'internal');
  // ...and the internal feed deletes everything EXCEPT them, so a credit survives
  // an internal resync even when the state-sync feed was skipped this run.
  assert.ok(internalDelete, 'the internal delete excludes the precompile');
  assert.equal(internalDelete.excludeFromAddress, PRECOMPILE);
});

test('the delete SQL applies the from_address include/exclude scope', async () => {
  queries.length = 0;
  await EthTransfer.deleteFromBlock(7, 137, ['internal'], 100, { fromAddress: PRECOMPILE });
  await EthTransfer.deleteFromBlock(7, 137, ['internal'], 100, { excludeFromAddress: PRECOMPILE });
  await EthTransfer.deleteFromBlock(7, 137, ['internal'], 100);

  assert.match(sqlOf(queries[0]), /AND from_address = \$5$/);
  assert.deepEqual(queries[0].params, [7, 137, ['internal'], 100, PRECOMPILE]);
  assert.match(sqlOf(queries[1]), /AND from_address <> \$5$/);
  // No address scope on the plain call: the other five feeds and every other
  // chain pass neither option and clear their whole window.
  assert.doesNotMatch(sqlOf(queries[2]), /from_address/);
  assert.equal(queries[2].params.length, 4);
});

test('the state-sync cursor resumes and advances independently of the internal one', async (t) => {
  const { calls } = harness(t, {
    chainSet: '137',
    cursors: { 137: { last_block_internal: 90000000, last_block_statesync: 84400000 } },
    feedBehavior: {
      '137:statesync': [{
        hash: DEPOSIT_TX, blockNumber: '84000001', timeStamp: '1742000000',
        from: PRECOMPILE, to: WALLET, value: DEPOSIT_WEI,
      }],
    },
  });

  await EthWalletService.syncWallet(7);

  const startOf = (feed) => calls.fetches.find((c) => c.chainId === 137 && c.feed === feed).startBlock;
  const overlap = EthWalletService.REORG_OVERLAP_BLOCKS;
  // Its own cursor, not the internal feed's (which is 5.6M blocks ahead).
  assert.equal(startOf('statesync'), 84400000 - overlap);
  assert.equal(startOf('internal'), 90000000 - overlap);

  const cursorUpdate = calls.cursors.find((c) => c.chainId === 137);
  assert.equal(cursorUpdate.statesync, 90000000, 'the cursor advances to the explicit indexed head');
});

test('an empty successful native-credit scan advances to the scanned chain head', async (t) => {
  const empty = [];
  Object.defineProperty(empty, 'scannedThroughBlock', {
    value: 50000000,
    enumerable: false,
  });
  const { calls } = harness(t, {
    chainSet: '8453',
    feedBehavior: { '8453:statesync': empty },
  });

  await EthWalletService.syncWallet(7);

  const cursorUpdate = calls.cursors.find((c) => c.chainId === 8453);
  assert.equal(cursorUpdate.statesync, 50000000);
});

test('a non-declaring chain never advances or reads the state-sync cursor', async (t) => {
  const { calls } = harness(t, { chainSet: '1' });

  await EthWalletService.syncWallet(7);

  assert.ok(!calls.fetches.some((c) => c.feed === 'statesync'), 'no fetch on a non-declaring chain');
  assert.ok(!calls.deletes.some((d) => d.fromAddress || d.excludeFromAddress), 'no scoped delete');
  // NULL leaves last_block_statesync at its 0 default, unread, forever.
  assert.equal(calls.cursors.find((c) => c.chainId === 1).statesync, null);
});

test('an unreadable Polygon marks all SIX feeds and still reports CHAIN_UNAVAILABLE', async (t) => {
  // The whole-chain verdict is measured against the count of feeds this chain
  // RUNS, not FEED_SPECS.length -- otherwise a chain that runs five could never
  // reach "all unavailable" once a sixth feed exists.
  const unavailable = () => {
    const err = new Error('Free API access is not supported for this chain.');
    err.code = 'ETHERSCAN_CHAIN_UNAVAILABLE';
    throw err;
  };
  const { calls } = harness(t, {
    chainSet: '137',
    feedBehavior: { '137:normal': unavailable },
  });

  await EthWalletService.syncWallet(7);

  // The state-sync feed is marked unavailable WITHOUT being called: the cascade
  // reaches it just like the four account feeds after normal.
  assert.deepEqual(calls.fetches.filter((c) => c.chainId === 137).map((c) => c.feed), ['normal']);
  assert.deepEqual(calls.unsupported.find((u) => u.chainId === 137).list,
    ['normal', 'internal', 'token', 'nft', 'nft1155', 'statesync']);
  assert.equal(calls.chainErrors.find((e) => e.chainId === 137).code, 'CHAIN_UNAVAILABLE');
});

test('a transiently skipped state-sync feed freezes its cursor and keeps its rows', async (t) => {
  const { calls } = harness(t, {
    chainSet: '137',
    cursors: { 137: { last_block_statesync: 5000 } },
    feedBehavior: { '137:statesync': () => { throw new Error('rate limit reached'); } },
  });

  const result = await EthWalletService.syncWallet(7);

  // Transient -> skipped, not unsupported. It badges the wallet and retries.
  assert.deepEqual(result.skippedFeeds, ['Polygon/statesync']);
  assert.deepEqual(calls.unsupported.find((u) => u.chainId === 137).list, []);
  // Its cursor is not advanced, and no state-sync delete ran (its rows survive).
  assert.equal(calls.cursors.find((c) => c.chainId === 137).statesync, null);
  assert.ok(!calls.deletes.some((d) => d.fromAddress), 'no delete without a refetch');
  // The internal feed still ran its exclude-scoped delete, so a stored credit is
  // protected precisely because the state-sync feed did not run this time.
  assert.ok(calls.deletes.some((d) => d.types === 'internal' && d.excludeFromAddress === PRECOMPILE));
});

// ---------------------------------------------------------------------------
// normalizeFeeds: the pure ingest of a state-sync row
// ---------------------------------------------------------------------------

test('normalizeFeeds turns a state-sync row into a non-zero internal leg', () => {
  const rows = EthWalletService.normalizeFeeds(WALLET, {
    statesync: [
      { hash: DEPOSIT_TX, blockNumber: '84000001', timeStamp: '1742000000', from: PRECOMPILE, to: WALLET, value: DEPOSIT_WEI },
      { hash: '0xzero', blockNumber: '84000002', timeStamp: '1742000001', from: PRECOMPILE, to: WALLET, value: '0' },
    ],
  });
  assert.equal(rows.length, 1, 'a zero-value credit is dropped like a zero internal trace');
  assert.equal(rows[0].transfer_type, 'internal');
  assert.equal(rows[0].from_address, PRECOMPILE);
  assert.equal(rows[0].value_wei, DEPOSIT_WEI);
  assert.equal(rows[0].is_error, false);
  assert.equal(rows[0].method_id, null);
});

// ---------------------------------------------------------------------------
// Reconciliation: the native gate now covers the feed on declaring chains
// ---------------------------------------------------------------------------

test('a skipped state-sync feed blocks the Polygon native audit', () => {
  process.env.ETH_CHAINS = '137';
  const gates = EthReconciliationService.chainGates([
    { chainId: 137, unavailable: false, skippedFeeds: ['statesync'], unsupportedFeeds: [] },
  ], null);
  delete process.env.ETH_CHAINS;
  // The credit lives only in this feed, so a gap in it leaves the derived native
  // balance short -- skip rather than report that as drift.
  assert.equal(EthReconciliationService.feedGap(gates.get(137), 'native'), true);
  assert.equal(EthReconciliationService.feedGap(gates.get(137), 'token'), false);
});

test('statesync in REQUIRED_FEEDS.native never falsely gaps a non-declaring chain', () => {
  process.env.ETH_CHAINS = '1';
  const gates = EthReconciliationService.chainGates([
    { chainId: 1, unavailable: false, skippedFeeds: [], unsupportedFeeds: [] },
  ], null);
  delete process.env.ETH_CHAINS;
  // Mainnet never runs the feed, so 'statesync' can never appear in its gap list,
  // so listing it in REQUIRED_FEEDS.native is safe: the native audit still runs.
  assert.equal(EthReconciliationService.feedGap(gates.get(1), 'native'), false);
});

// ---------------------------------------------------------------------------
// The bridge halves: rung 3 classification and the amount/time matcher
// ---------------------------------------------------------------------------

test('the state-sync credit classifies bridge_in and the L1 leg bridge_out', () => {
  const bridging = { bridgeAddresses: new Set([DEPOSIT_MANAGER, PRECOMPILE]) };

  // Polygon side: native POL in from the MRC20 precompile.
  const inRows = buildActivityRows(WALLET, [{
    id: 1, wallet_id: 7, tx_hash: DEPOSIT_TX, chain_id: 137, ordinal: 0,
    transfer_type: 'internal', block_number: 84000001, block_time: '2026-03-19T12:00:00.000Z',
    from_address: PRECOMPILE, to_address: WALLET, value_wei: DEPOSIT_WEI,
    token_contract: null, token_symbol: null, token_decimals: null, token_standard: null,
    token_id: null, is_error: false, counterparty_is_own: false, counterparty_exchange: null,
    method_id: null, method_name: null,
  }], bridging);
  assert.equal(inRows.length, 1);
  assert.equal(inRows[0].category, 'bridge_in');
  assert.equal(inRows[0].counterparty_address, PRECOMPILE);
  assert.equal(inRows[0].legs[0].asset, 'POL', 'the native leg reads Polygon, not ether');
  assert.equal(inRows[0].needs_review, true);

  // L1 side: POL (an ERC-20 on Ethereum) out to the Plasma DepositManager.
  const outRows = buildActivityRows(WALLET, [
    {
      id: 2, wallet_id: 7, tx_hash: '0xL1deposit', chain_id: 1, ordinal: 0,
      transfer_type: 'token', block_number: 1000, block_time: '2026-03-19T11:35:00.000Z',
      from_address: WALLET, to_address: DEPOSIT_MANAGER, value_wei: DEPOSIT_WEI,
      token_contract: '0x455e53cbb86018ac2b8092fdcd39d8444affc3f6', token_symbol: 'POL',
      token_decimals: 18, token_standard: 'erc20', token_id: null, is_error: false,
      counterparty_is_own: false, counterparty_exchange: null, method_id: null, method_name: null,
    },
    {
      id: 3, wallet_id: 7, tx_hash: '0xL1deposit', chain_id: 1, ordinal: 0,
      transfer_type: 'gas', block_number: 1000, block_time: '2026-03-19T11:35:00.000Z',
      from_address: WALLET, to_address: DEPOSIT_MANAGER, value_wei: '2100000000000000',
      token_contract: null, token_symbol: null, token_decimals: null, token_standard: null,
      token_id: null, is_error: false, counterparty_is_own: false, counterparty_exchange: null,
      method_id: null, method_name: null,
    },
  ], bridging);
  assert.equal(outRows[0].category, 'bridge_out');
  assert.equal(outRows[0].counterparty_address, DEPOSIT_MANAGER);
  assert.equal(outRows[0].legs[0].asset, 'POL');
});

test('the two POL halves pair inside the 24h L1-deposit window', () => {
  const scaled = (text) => {
    const [whole, frac = ''] = String(text).split('.');
    return BigInt(whole) * 10n ** 18n + BigInt(`${frac}${'0'.repeat(18)}`.slice(0, 18));
  };
  const T0 = Date.parse('2026-03-19T11:35:00.000Z');
  const out = { id: 2, chain_id: 1, asset: 'POL', amount: scaled('47.25'), rawAmount: '47.25', time: T0 };
  // State-sync credits land in ~25 minutes, well inside the 24h deposit window.
  const inLeg = { id: 1, chain_id: 137, asset: 'POL', amount: scaled('47.25'), rawAmount: '47.25', time: T0 + 25 * 60 * 1000 };

  const links = pairBridgeLegs([out], [inLeg]);
  assert.equal(links.length, 1);
  assert.deepEqual([links[0].out_activity_id, links[0].in_activity_id], [2, 1]);
  assert.equal(links[0].asset, 'POL');
  assert.equal(links[0].fee_amount, '0', 'a canonical deposit takes no cut');
  // POL is its own money on both chains -- no normalization fuses or splits it.
  assert.equal(bridgeAsset('POL'), 'POL');
});

// ---------------------------------------------------------------------------
// Review hardening: failure modes that must fail LOUD, never silently
// ---------------------------------------------------------------------------

test('a malformed log fails the whole feed rather than dropping the row', async (t) => {
  stubScanHead(t);
  const axios = require('axios');
  const original = axios.get;
  // One good log, one with truncated data. Dropping the bad row and returning
  // the good one would let the cursor advance past the dropped deposit -- lost
  // forever -- so the fetch must reject instead (feed skipped, cursor frozen).
  axios.get = async () => ({
    data: { status: '1', result: [depositLog(), { ...depositLog({ block: 84000005, hash: '0xbadbad' }), data: '0x1234' }] },
  });
  t.after(() => { axios.get = original; });
  await assert.rejects(
    EtherscanService.fetchStateSyncDeposits(WALLET, 0, 'key', 137, chains.getChain(137).stateSyncDeposits),
    /malformed/
  );
});

test('a decimal blockNumber is rejected, not misparsed as hex', async (t) => {
  stubScanHead(t);
  const axios = require('axios');
  const original = axios.get;
  // The account feeds return decimal strings; getLogs returns hex. A decimal
  // here still parses "successfully" -- parseInt('84000001', 16) is billions of
  // blocks past the tip -- and would poison the cursor so the feed returns
  // nothing forever after, so the format is enforced.
  axios.get = async () => ({
    data: { status: '1', result: [{ ...depositLog(), blockNumber: '84000001' }] },
  });
  t.after(() => { axios.get = original; });
  await assert.rejects(
    EtherscanService.fetchStateSyncDeposits(WALLET, 0, 'key', 137, chains.getChain(137).stateSyncDeposits),
    /non-hex blockNumber/
  );
});

test('an off-shape 200 is a transport failure, not an empty feed', async (t) => {
  stubScanHead(t);
  const axios = require('axios');
  const original = axios.get;
  // "Fetched OK" is what authorizes the destructive delete of the resume
  // window; reading garbage as "no deposits" would wipe stored credits.
  axios.get = async () => ({ data: { status: '1', result: 'Max rate limit reached' } });
  t.after(() => { axios.get = original; });
  await assert.rejects(
    EtherscanService.fetchStateSyncDeposits(WALLET, 0, 'key', 137, chains.getChain(137).stateSyncDeposits),
    /non-array/
  );
});

test('a walk that cannot progress freezes immediately instead of dropping an unknown tail', async (t) => {
  stubScanHead(t);
  const axios = require('axios');
  const etherscanConfig = require('../src/config/etherscan');
  const original = axios.get;
  const originalThrottled = etherscanConfig.throttled;
  // An API that ignores fromBlock: every request answers the same FULL page.
  // The unbounded paginator spun forever INSIDE the per-user rebuild lane.
  // Stepping over the page would be bounded but incomplete, so the safe result
  // is an immediate cursor-frozen feed failure.
  const page = Array.from({ length: 1000 }, (_, i) =>
    depositLog({ block: 100 + i, hash: `0x${(100 + i).toString(16)}`, logIndex: 0 }));
  let requests = 0;
  etherscanConfig.throttled = (fn) => fn();
  axios.get = async () => { requests += 1; return { data: { status: '1', result: page } }; };
  t.after(() => { axios.get = original; etherscanConfig.throttled = originalThrottled; });
  await assert.rejects(
    EtherscanService.fetchStateSyncDeposits(WALLET, 0, 'key', 137, chains.getChain(137).stateSyncDeposits),
    /full page without advancing past block 1099; cursor frozen/
  );
  assert.equal(requests, 2);
});

test('an internal trace from the precompile is filtered so the two feeds never double-ingest', () => {
  const rows = EthWalletService.normalizeFeeds(WALLET, {
    internal: [
      // The same credit the state-sync feed carries, if txlistinternal ever
      // starts serving the trace: kept, it would double-count the deposit
      // under a second ordinal the internal feed's own delete (which excludes
      // the precompile) could never remove.
      { hash: DEPOSIT_TX, blockNumber: '84000001', timeStamp: '1742000000', from: PRECOMPILE, to: WALLET, value: DEPOSIT_WEI },
      // An ordinary trace from any other contract: must be kept.
      { hash: '0xaaa', blockNumber: '84000002', timeStamp: '1742000001', from: '0x00000000000000000000000000000000deadbeef', to: WALLET, value: '5' },
    ],
    statesync: [
      { hash: DEPOSIT_TX, blockNumber: '84000001', timeStamp: '1742000000', from: PRECOMPILE, to: WALLET, value: DEPOSIT_WEI },
    ],
  }, { stateSyncContract: PRECOMPILE });
  const internalRows = rows.filter((r) => r.transfer_type === 'internal');
  assert.equal(internalRows.length, 2, 'the deposit once (via statesync) plus the ordinary trace');
  assert.equal(internalRows.filter((r) => r.from_address === PRECOMPILE).length, 1);
});

test('MATIC normalizes to POL so pre-rename Plasma deposits pair', () => {
  assert.equal(bridgeAsset('MATIC'), 'POL');
  // The suffix strips FIRST, then the rename maps -- the same composition rule
  // that keeps WETH.e out of a bucket of its own.
  assert.equal(bridgeAsset('MATIC.e'), 'POL');
  assert.equal(bridgeAsset('WETH'), 'ETH');
});
