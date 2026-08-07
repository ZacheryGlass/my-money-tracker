'use strict';

// Multi-chain wallet sync (#58). The chain set and the live-probe findings
// behind it live in src/config/chains.js; the assertions here are about the
// mechanics that make more than one chain per wallet safe:
//   * every chain resumes from its OWN cursor, with the reorg overlap applied
//     per chain (block numbers are independent sequences)
//   * a feed the chain/key cannot serve freezes its cursor and records a gap
//   * a disabled chain is not synced AND not cleaned up
//   * the dedupe key carries the chain, so two chains cannot collide

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
const etherscanConfig = require('../src/config/etherscan');
const EthWalletService = require('../src/services/EthWalletService');
const EtherscanService = require('../src/services/EtherscanService');
const EthWallet = require('../src/models/EthWallet');
const EthWalletChain = require('../src/models/EthWalletChain');
const EthFeedCoverage = require('../src/models/EthFeedCoverage');
const EthTransfer = require('../src/models/EthTransfer');
const SecretsService = require('../src/services/SecretsService');
const EthDerivedPipeline = require('../src/services/EthDerivedPipeline');
const MirrorService = require('../src/services/EthTransactionMirrorService');
const TransactionClassificationService = require('../src/services/TransactionClassificationService');
const { collapseDuplicateKeys } = require('../src/services/SnapshotService');

const sqlOf = (query) => query.text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const WALLET = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
const MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '039_multichain_wallets.sql'), 'utf8'
);
const INGEST_VERSION_MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '050_chain_ingest_version.sql'), 'utf8'
);
const UTC_CHAIN_TIMES_MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '054_utc_chain_times.sql'), 'utf8'
);

// Shared harness: stubs everything a sync touches except the parts under test,
// and records the (chain, feed) calls the sync actually made.
function harness(t, { chainSet, cursors = {}, feedBehavior = {}, apiKey = 'key' } = {}) {
  const restore = [];
  const stub = (obj, key, fn) => { restore.push([obj, key, obj[key]]); obj[key] = fn; };
  const priorChains = process.env.ETH_CHAINS;
  if (chainSet !== undefined) process.env.ETH_CHAINS = chainSet;
  t.after(() => {
    // Reverse: a test that re-stubs something the harness already stubbed saved
    // the HARNESS's function as its "original", so restoring forwards would
    // reinstate that stub and leak it into every later test.
    for (const [o, k, v] of restore.reverse()) o[k] = v;
    if (priorChains === undefined) delete process.env.ETH_CHAINS;
    else process.env.ETH_CHAINS = priorChains;
  });

  const calls = {
    fetches: [], heads: [], deletes: [], cursors: [], unsupported: [],
    chainErrors: [], cleared: [], inserted: [], coverage: [],
  };
  const chainStates = new Map();
  const stateFor = (walletId, chainId, ingestVersion) => {
    if (!chainStates.has(chainId)) {
      chainStates.set(chainId, {
        wallet_id: walletId,
        chain_id: chainId,
        ingest_version: ingestVersion,
        last_block_normal: 0, last_block_internal: 0, last_block_token: 0,
        last_block_nft: 0, last_block_1155: 0, last_block_statesync: 0,
        ...(cursors[chainId] || {}),
      });
    }
    return chainStates.get(chainId);
  };

  stub(EthWallet, 'findById', async () => ({ id: 7, user_id: 1, address: WALLET }));
  stub(SecretsService, 'getUserKey', async () => apiKey);
  stub(EthWalletChain, 'ensure', async (walletId, chainId, ingestVersion = 0) =>
    ({ ...stateFor(walletId, chainId, ingestVersion) }));
  stub(EthWalletChain, 'resetForIngestVersion', async (walletId, chainId, ingestVersion) => {
    calls.resets ||= [];
    calls.resets.push({ chainId, ingestVersion });
    const reset = {
      wallet_id: walletId,
      chain_id: chainId,
      ingest_version: ingestVersion,
      last_block_normal: 0, last_block_internal: 0, last_block_token: 0,
      last_block_nft: 0, last_block_1155: 0, last_block_statesync: 0,
    };
    chainStates.set(chainId, reset);
    return { ...reset };
  });
  stub(EthWalletChain, 'resetForRecapture', async (walletId, chainId) => {
    calls.recaptures ||= [];
    calls.recaptures.push(chainId);
    const prior = stateFor(walletId, chainId, 0);
    const reset = {
      ...prior,
      last_block_normal: 0, last_block_internal: 0, last_block_token: 0,
      last_block_nft: 0, last_block_1155: 0, last_block_statesync: 0,
      error_code: null, error_message: null, unsupported_feeds: [],
      last_synced_at: null,
    };
    chainStates.set(chainId, reset);
    return { ...reset };
  });
  stub(EtherscanService, 'coverageBoundary', async (requestApiKey, chainId) => {
    calls.heads.push({ chainId, apiKey: requestApiKey });
    return {
      fromBlock: 0,
      throughBlock: 50000000,
      fromAt: new Date('2015-07-30T00:00:00Z'),
      throughAt: new Date('2026-07-30T00:00:00Z'),
    };
  });
  stub(EthFeedCoverage, 'recordAttempts', async (walletId, chainId, entries) => {
    calls.coverage.push({ walletId, chainId, entries });
    return entries;
  });

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
      address, startBlock, requestApiKey, chainId, feedConfigOrHead, indexedHead
    ) => {
      const coverage = key === 'statesync' ? indexedHead : feedConfigOrHead;
      calls.fetches.push({
        feed: key, chainId, startBlock, address, apiKey: requestApiKey, coverage,
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

  stub(EthTransfer, 'deleteFromBlock', async (walletId, chainId, types, block) => {
    calls.deletes.push({ chainId, types: types.join(','), block });
  });
  stub(EthTransfer, 'bulkInsert', async (rows) => { calls.inserted.push(...rows); return rows.length; });
  stub(EthWalletChain, 'updateCursors', async (walletId, chainId, next) => {
    calls.cursors.push({ chainId, ...next });
    const state = stateFor(walletId, chainId, 0);
    const columns = {
      normal: 'last_block_normal',
      internal: 'last_block_internal',
      token: 'last_block_token',
      nft: 'last_block_nft',
      nft1155: 'last_block_1155',
      statesync: 'last_block_statesync',
    };
    for (const [key, value] of Object.entries(next)) {
      if (value != null) state[columns[key]] = value;
    }
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
  stub(EthTransfer, 'reclassifyCounterparties', async () => {});
  stub(EthWalletService, 'refreshHoldings', async () => ({}));
  stub(MirrorService, 'rebuildForWallet', async () => ({}));
  stub(TransactionClassificationService, 'backfill', async () => {});
  stub(EthWallet, 'clearError', async () => { calls.walletCleared = true; });
  stub(EthWallet, 'setError', async (id, code, message) => { calls.walletError = { code, message }; });
  stub(EthWallet, 'updateSyncTime', async () => {});

  return { calls, stub };
}

// ---------------------------------------------------------------------------
// The registry, as probed live
// ---------------------------------------------------------------------------

test('Gnosis, OP Mainnet, Base, and zkSync Era use keyless providers', () => {
  const ids = chains.allChains().map((chain) => chain.id);
  assert.deepEqual(
    ids.sort((a, b) => a - b),
    [1, 10, 100, 137, 324, 8453, 32401, 42161, 59144]
  );
  const gnosis = chains.getChain(100);
  assert.equal(gnosis.nativeAsset, 'XDAI');
  assert.equal(gnosis.accountApi.provider, 'Blockscout');
  assert.equal(gnosis.accountApi.requiresApiKey, false);
  assert.equal(gnosis.enabledByDefault, true);
  for (const id of [10, 324, 8453]) {
    const chain = chains.getChain(id);
    assert.equal(chain.accountApi.provider, 'Blockscout');
    assert.equal(chain.accountApi.requiresApiKey, false);
    assert.equal(chain.enabledByDefault, true);
    assert.match(chain.rpcUrl, /^https:/);
    if (id === 324) continue;
    assert.equal(chain.stateSyncDeposits.contract, '0x4200000000000000000000000000000000000010');
    assert.equal(chain.stateSyncDeposits.userTopicIndex, 2);
    assert.equal(chain.opStackDeposits.creditSource, chain.stateSyncDeposits.contract);
  }
  const lite = chains.getChain(32401);
  assert.equal(lite.historyProvider, 'zksync-lite');
  assert.equal(lite.requiresApiKey, false);
  assert.equal(lite.enabledByDefault, true);
});

test('all live-probed chains default on through their configured providers', () => {
  delete process.env.ETH_CHAINS;
  const byId = new Map(chains.allChains().map((chain) => [chain.id, chain]));
  // OP/Base use keyless Blockscout because Etherscan gates them by plan. A
  // partial internal range stays a visible per-feed
  // gap rather than disabling the other independently complete feeds.
  for (const id of [1, 10, 100, 137, 324, 8453, 32401, 42161, 59144]) {
    assert.equal(byId.get(id).enabled, true, `chain ${id} defaults on through its configured provider`);
  }
});

test('every chain names a native asset that the price layer knows how to fetch', () => {
  // Was "every chain is ETH-native" until Polygon. The invariant that replaced
  // it is the one that actually matters: a chain whose native symbol has no
  // NATIVE_ASSETS entry cannot be priced at all, and -- worse -- a native leg
  // keyed to an unknown symbol looks exactly like an honestly unpriced one.
  for (const chain of chains.allChains()) {
    assert.ok(chain.nativeAsset, `chain ${chain.id} needs a native asset`);
    const info = chains.nativeAssetInfo(chain.nativeAsset);
    assert.ok(info, `native asset ${chain.nativeAsset} needs a NATIVE_ASSETS entry`);
    assert.ok(info.coingeckoId, `${chain.nativeAsset} needs a CoinGecko id`);
    assert.ok(info.coinbaseProduct, `${chain.nativeAsset} needs a declared fallback product`);
    assert.match(info.historyStart, /^\d{4}-\d{2}-\d{2}$/);
    // Verified against CoinGecko /asset_platforms by chain_identifier: a token
    // priced on the wrong platform comes back unknown, not wrong, so an
    // unverified slug reads as a permanent pricing outage.
    assert.ok(chain.coingeckoPlatform, `chain ${chain.id} needs an asset platform`);
  }
  // All ETH-native chains still share one series and one price_cache row.
  for (const id of [1, 10, 324, 8453, 32401, 42161, 59144]) {
    assert.equal(chains.nativeSymbol(id), 'ETH');
  }
  assert.equal(chains.nativeSymbol(100), 'XDAI');
  assert.equal(chains.nativeSymbol(137), 'POL');
  // An id the registry has never heard of is mainnet's, and mainnet is ether.
  assert.equal(chains.nativeSymbol(999999), 'ETH');
});

test('a native asset that is not ether must be classified as crypto, or it prices as a stock', () => {
  // Wallet holdings are inserted with no category, so classifyTicker falls
  // through to CRYPTO_SET. A miss there does not fail loudly: it asks Yahoo for
  // a bare equity symbol and skips every crypto fallback.
  const { classifyTicker } = require('../src/utils/assetClassifier');
  for (const chain of chains.allChains()) {
    assert.ok(['Crypto', 'Cash'].includes(classifyTicker(chain.nativeAsset, null)),
      `${chain.nativeAsset} must be crypto or cash, never a stock`);
  }
});

test('ETH_CHAINS=1 restores exact mainnet-only sync, and junk cannot disable everything', () => {
  process.env.ETH_CHAINS = '1';
  assert.deepEqual(chains.enabledChainIds(), [1]);
  // An unknown id has no name and no asset platform behind it, so honoring it
  // would mint holdings labelled "(undefined)".
  process.env.ETH_CHAINS = '1,99999';
  assert.deepEqual(chains.enabledChainIds(), [1]);
  // A typo must not silently stop syncing every wallet on earth.
  process.env.ETH_CHAINS = 'nonsense';
  assert.deepEqual(chains.enabledChainIds(), [1]);
  delete process.env.ETH_CHAINS;
});

test('credential gating follows the enabled provider set', (t) => {
  const prior = process.env.ETH_CHAINS;
  t.after(() => {
    if (prior === undefined) delete process.env.ETH_CHAINS;
    else process.env.ETH_CHAINS = prior;
  });

  process.env.ETH_CHAINS = '100';
  assert.equal(chains.enabledChainsRequireApiKey(), false);
  process.env.ETH_CHAINS = '10,100,8453';
  assert.equal(chains.enabledChainsRequireApiKey(), false);
  process.env.ETH_CHAINS = '324,32401';
  assert.equal(chains.enabledChainsRequireApiKey(), false);
  process.env.ETH_CHAINS = '1,100';
  assert.equal(chains.enabledChainsRequireApiKey(), true);
});

test('mainnet holding names are byte-identical to their pre-#58 values', () => {
  // Holdings are matched by NAME. Renaming mainnet's rows would strand every
  // existing user's ETH holding and insert a duplicate beside it.
  assert.equal(chains.ethHoldingName(1), 'Ethereum');
  assert.equal(chains.holdingSuffix(1), '');
  assert.equal(chains.ethHoldingName(42161), 'ETH (Arbitrum)');
  assert.equal(chains.holdingSuffix(8453), ' (Base)');
  assert.equal(chains.ethHoldingName(324), 'ETH (zkSync Era)');
  assert.equal(chains.ethHoldingName(32401), 'ETH (zkSync Lite)');
});

// ---------------------------------------------------------------------------
// Per-chain resume
// ---------------------------------------------------------------------------

test('each chain resumes from its own cursor with the reorg overlap applied', async (t) => {
  const { calls } = harness(t, {
    chainSet: '1,42161',
    cursors: {
      1: { last_block_normal: 1000, last_block_internal: 900, last_block_token: 800, last_block_nft: 700, last_block_1155: 10 },
      // Arbitrum block numbers are a completely independent sequence -- here
      // deliberately far past mainnet's, which is what real L2s look like.
      42161: { last_block_normal: 250000000, last_block_internal: 249999000, last_block_token: 20, last_block_nft: 0, last_block_1155: 0 },
    },
  });

  await EthWalletService.syncWallet(7);

  const startOf = (chainId, feed) =>
    calls.fetches.find((call) => call.chainId === chainId && call.feed === feed).startBlock;

  const overlap = EthWalletService.REORG_OVERLAP_BLOCKS;
  assert.equal(overlap, 64);
  assert.equal(startOf(1, 'normal'), 1000 - overlap);
  assert.equal(startOf(1, 'internal'), 900 - overlap);
  assert.equal(startOf(42161, 'normal'), 250000000 - overlap);
  assert.equal(startOf(42161, 'internal'), 249999000 - overlap);
  // Clamped at 0: a cursor below the overlap must not resume from a negative
  // block, and a fresh feed still backfills from genesis.
  assert.equal(startOf(1, 'nft1155'), 0);
  assert.equal(startOf(42161, 'nft'), 0);

  // Cross-contamination is the failure this guards: mainnet's cursor must never
  // decide where Arbitrum resumes. At 250M vs 1000 blocks, borrowing the wrong
  // one either refetches a decade or skips it entirely.
  assert.notEqual(startOf(1, 'normal'), startOf(42161, 'normal'));
  // Every enabled chain runs every feed.
  assert.equal(calls.fetches.length, 10);
  assert.deepEqual([...new Set(calls.fetches.map((c) => c.chainId))], [1, 42161]);
});

test('full recapture resets every enabled feed to genesis without deleting the wallet', async (t) => {
  const { calls } = harness(t, {
    chainSet: '1,42161',
    cursors: {
      1: {
        last_block_normal: 1000, last_block_internal: 900, last_block_token: 800,
        last_block_nft: 700, last_block_1155: 600, last_block_statesync: 500,
      },
      42161: {
        last_block_normal: 2000, last_block_internal: 1900, last_block_token: 1800,
        last_block_nft: 1700, last_block_1155: 1600, last_block_statesync: 1500,
      },
    },
  });

  await EthWalletService.recaptureWallet(7, { fillPrices: false });

  assert.deepEqual(calls.recaptures, [1, 42161]);
  assert.ok(calls.fetches.length > 0);
  assert.ok(calls.fetches.every((call) => call.startBlock === 0),
    'every active feed replays from genesis after the durable cursor reset');
  assert.ok(!queries.some((query) => /DELETE FROM eth_wallets/i.test(query.text)),
    'recapture never deletes the wallet that owns notes and review decisions');
});

test('deletes are scoped to one chain, so an overlap window cannot wipe another chain', async (t) => {
  const { calls } = harness(t, {
    chainSet: '1,42161',
    cursors: { 1: { last_block_normal: 500 }, 42161: { last_block_normal: 500 } },
  });

  await EthWalletService.syncWallet(7);

  // Identical block windows on two chains, which is exactly the case a
  // chain-blind DELETE gets wrong: Arbitrum block 436 has nothing to do with
  // mainnet block 436, and the reorg overlap makes this happen every sync.
  const nativeDeletes = calls.deletes.filter((d) => d.types === 'native,gas');
  assert.deepEqual(nativeDeletes.map((d) => d.chainId), [1, 42161]);
  assert.ok(nativeDeletes.every((d) => d.block === 500 - 64));
});

test('the delete statement itself carries the chain predicate', async () => {
  queries.length = 0;
  await EthTransfer.deleteFromBlock(7, 42161, ['native', 'gas'], 100);
  const sql = sqlOf(queries[0]);
  assert.match(sql, /wallet_id = \$1 AND chain_id = \$2/);
  assert.deepEqual(queries[0].params, [7, 42161, ['native', 'gas'], 100]);
});

test('rows are stamped with the chain they came from', async (t) => {
  const { calls } = harness(t, {
    chainSet: '1,42161',
    feedBehavior: {
      '1:normal': [{
        blockNumber: '100', timeStamp: '1700000000', hash: '0xsame',
        from: WALLET, to: '0xdef', value: '1000000000000000000',
        gasUsed: '21000', gasPrice: '1000000000', isError: '0',
      }],
      '42161:normal': [{
        blockNumber: '100', timeStamp: '1700000000', hash: '0xsame',
        from: WALLET, to: '0xdef', value: '1000000000000000000',
        gasUsed: '21000', gasPrice: '1000000000', isError: '0',
      }],
    },
  });

  await EthWalletService.syncWallet(7);

  const native = calls.inserted.filter((row) => row.transfer_type === 'native');
  assert.deepEqual(native.map((row) => row.chain_id), [1, 42161]);
  // Same hash, same type, same ordinal on both chains -- the pre-#58 UNIQUE
  // key cannot tell these apart, and ON CONFLICT DO NOTHING would drop the
  // second one silently rather than error.
  assert.equal(new Set(native.map((row) => `${row.tx_hash}:${row.ordinal}`)).size, 1);
});

// ---------------------------------------------------------------------------
// Cross-chain rows must not collide
// ---------------------------------------------------------------------------

test('the dedupe key and its constraint both carry chain_id', async () => {
  queries.length = 0;
  await EthTransfer.bulkInsert([
    { wallet_id: 7, chain_id: 1, tx_hash: '0xsame', ordinal: 0, transfer_type: 'native', block_number: 1, block_time: new Date(0), from_address: WALLET, to_address: '0xdef', value_wei: '1', is_error: false },
    { wallet_id: 7, chain_id: 42161, tx_hash: '0xsame', ordinal: 0, transfer_type: 'native', block_number: 1, block_time: new Date(0), from_address: WALLET, to_address: '0xdef', value_wei: '1', is_error: false },
  ]);
  const sql = sqlOf(queries[0]);
  assert.match(sql, /INSERT INTO eth_transfers \(wallet_id, chain_id,/);
  assert.match(sql, /ON CONFLICT \(wallet_id, chain_id, transfer_type, tx_hash, ordinal\) DO NOTHING/);
  // The migration must actually have swapped the constraint, or ON CONFLICT
  // above has no matching unique index and every insert raises 42P10.
  assert.match(MIGRATION, /UNIQUE \(wallet_id, chain_id, transfer_type, tx_hash, ordinal\)/);
  assert.match(MIGRATION, /pg_get_constraintdef\(oid\) LIKE '%chain_id%'/);
});

test('a caller with no chain writes mainnet rather than a NULL chain', async () => {
  // chain_id is NOT NULL, and a NULL would also make the UNIQUE fall open
  // (NULLs never conflict), so two re-syncs of one tx could both insert.
  queries.length = 0;
  await EthTransfer.bulkInsert([
    { wallet_id: 7, tx_hash: '0xa', ordinal: 0, transfer_type: 'native', block_number: 1, block_time: new Date(0), from_address: WALLET, to_address: '0xdef', value_wei: '1', is_error: false },
  ]);
  assert.equal(queries[0].params[1], 1);
});

test('token balances are grouped per chain, never netted across them', async () => {
  queries.length = 0;
  await EthTransfer.tokenBalanceDeltas(7);
  const sql = sqlOf(queries[0]);
  // The same contract address is a different asset on each chain. Netting one
  // chain's outflow against another's holdings can produce a negative balance,
  // and the holdings filter drops those -- silently deleting a real position.
  assert.match(sql, /GROUP BY t\.chain_id, t\.token_contract/);
  assert.match(sql, /SELECT t\.chain_id/);
});

// ---------------------------------------------------------------------------
// Unsupported feeds: cursor frozen, gap recorded
// ---------------------------------------------------------------------------

test('an unsupported feed freezes its cursor, keeps its rows, and records the gap', async (t) => {
  // ETHERSCAN_FEED_UNSUPPORTED, not CHAIN_UNAVAILABLE: one missing feed says
  // nothing about its neighbours, so it must not cascade.
  const featureMissing = () => {
    const err = new Error('Error! Missing Or invalid Action name');
    err.code = 'ETHERSCAN_FEED_UNSUPPORTED';
    throw err;
  };
  const { calls } = harness(t, {
    chainSet: '1,42161',
    cursors: { 42161: { last_block_internal: 5000 } },
    feedBehavior: {
      '42161:internal': featureMissing,
      '42161:normal': [{
        blockNumber: '6000', timeStamp: '1700000000', hash: '0xa',
        from: WALLET, to: '0xdef', value: '1', gasUsed: '1', gasPrice: '1', isError: '0',
      }],
    },
  });

  await EthWalletService.syncWallet(7);

  const arb = calls.cursors.find((c) => c.chainId === 42161);
  assert.equal(arb.internal, null, 'an unfetched feed must not advance its cursor');
  assert.equal(arb.normal, 50000000, 'its neighbours advance to the explicit indexed head');
  assert.ok(
    !calls.deletes.some((d) => d.chainId === 42161 && d.types === 'internal'),
    'the unfetched feed keeps its stored rows: no delete without a refetch'
  );
  // A single missing feed must not take the other four down with it.
  assert.equal(
    calls.fetches.filter((c) => c.chainId === 42161).length, 5,
    'a per-feed gap does not cascade to the whole chain'
  );

  // The gap is what reconciliation (#62) reads. A missing internal feed means
  // ETH arriving from a contract was never seen, so a derived balance there can
  // legitimately disagree with action=balance -- expected, not a bug to chase.
  assert.deepEqual(calls.unsupported.find((u) => u.chainId === 42161).list, ['internal']);
  assert.deepEqual(calls.unsupported.find((u) => u.chainId === 1).list, []);
  const arbError = calls.chainErrors.find((e) => e.chainId === 42161);
  assert.equal(arbError.code, 'FEED_UNSUPPORTED');
  assert.match(arbError.message, /drift/);

  // Mainnet is untouched by its neighbour's gap.
  assert.ok(calls.cleared.includes(1), 'a healthy chain clears its own error slot');

  // The WALLET badge stays clean: an unsupported feed is a standing property of
  // the chain and the key, so badging it would pin the attention count above
  // zero forever -- and a badge that cannot reach zero gets ignored, costing us
  // the real sync errors too.
  assert.equal(calls.walletCleared, true);
  assert.equal(calls.walletError, undefined);
});

test('a wholly unreadable chain is isolated to its own row', async (t) => {
  const unavailable = () => {
    const err = new Error('Free API access is not supported for this chain.');
    err.code = 'ETHERSCAN_CHAIN_UNAVAILABLE';
    throw err;
  };
  const { calls } = harness(t, {
    chainSet: '1,8453',
    // Only the FIRST feed is wired to fail. The rest must be recognised as
    // unreadable without being called at all -- they would answer identically,
    // and the throttle is global across every user.
    feedBehavior: { '8453:normal': unavailable },
  });

  const result = await EthWalletService.syncWallet(7);

  assert.deepEqual(
    calls.fetches.filter((c) => c.chainId === 8453).map((c) => c.feed),
    ['normal'],
    'an unreadable chain must cost one request, not six'
  );
  assert.deepEqual(calls.unsupported.find((u) => u.chainId === 8453).list,
    ['normal', 'internal', 'token', 'nft', 'nft1155', 'statesync'],
    'the gap record still names every feed that went unfetched');
  const baseError = calls.chainErrors.find((e) => e.chainId === 8453);
  assert.equal(baseError.code, 'CHAIN_UNAVAILABLE');
  // Actionable: the two things that actually fix it.
  assert.match(baseError.message, /Upgrade the plan or remove 8453 from ETH_CHAINS/);
  assert.ok(calls.cleared.includes(1), 'mainnet still syncs and reports clean');
  assert.deepEqual(result.unsupportedFeeds.filter((f) => f.startsWith('Base')).length, 6);
  assert.equal(calls.walletError, undefined, 'a config condition is not a wallet sync failure');
});

test('a transient failure and an unsupported feed are told apart', async (t) => {
  const { calls } = harness(t, {
    chainSet: '1',
    feedBehavior: {
      '1:token': () => { throw new Error('rate limit reached'); },
    },
  });

  const result = await EthWalletService.syncWallet(7);

  // Transient -> retried next sync, and it DOES badge the wallet.
  assert.deepEqual(result.skippedFeeds, ['Ethereum/token']);
  assert.deepEqual(result.unsupportedFeeds, []);
  assert.deepEqual(calls.unsupported.find((u) => u.chainId === 1).list, []);
  assert.equal(calls.chainErrors.find((e) => e.chainId === 1).code, 'FEED_SKIPPED');
  assert.equal(calls.walletError.code, 'FEED_SKIPPED');
  assert.equal(calls.walletCleared, undefined);
});

test('a provider rate limit defers the remaining feeds without spending more requests', async (t) => {
  const rateLimited = () => {
    const error = new Error('Blockscout rate limit reached');
    error.code = 'EXPLORER_RATE_LIMITED';
    error.retryAfterMs = 10000;
    throw error;
  };
  const { calls } = harness(t, {
    chainSet: '1',
    feedBehavior: { '1:normal': rateLimited },
  });

  const result = await EthWalletService.syncWallet(7);

  assert.deepEqual(calls.fetches.map((call) => call.feed), ['normal']);
  assert.deepEqual(result.skippedFeeds, [
    'Ethereum/normal', 'Ethereum/internal', 'Ethereum/token',
    'Ethereum/nft', 'Ethereum/nft1155',
  ]);
  assert.equal(result.chains[0].rateLimited, true);
  assert.equal(result.status, 'deferred');
  assert.deepEqual(result.deferredFeeds, result.skippedFeeds);
  assert.equal(calls.deletes.length, 0, 'no feed is deleted after a rate-limited fetch');
  assert.equal(calls.cursors.every((cursor) => Object.values(cursor).every((value) => value == null || value === 1)), true);
  assert.equal(calls.chainErrors.find((entry) => entry.chainId === 1).code, 'SYNC_DEFERRED');
  assert.equal(calls.walletError.code, 'SYNC_DEFERRED');
  assert.ok(calls.coverage[0].entries.every((entry) => (
    entry.status === 'not_applicable'
    || (entry.status === 'deferred' && entry.retryAfterAt instanceof Date)
  )));
  assert.match(calls.walletError.message, /rate limited/);
});

test('a mid-feed 429 preserves completed cursors and defers only the unfetched tail', async (t) => {
  const rateLimited = () => {
    const error = new Error('Blockscout rate limit reached');
    error.code = 'EXPLORER_RATE_LIMITED';
    error.retryAfterMs = 10000;
    throw error;
  };
  const { calls } = harness(t, {
    chainSet: '1',
    feedBehavior: { '1:token': rateLimited },
  });

  const result = await EthWalletService.syncWallet(7);

  assert.deepEqual(calls.fetches.map((call) => call.feed), ['normal', 'internal', 'token']);
  assert.deepEqual(result.deferredFeeds, [
    'Ethereum/token', 'Ethereum/nft', 'Ethereum/nft1155',
  ]);
  assert.equal(calls.deletes.length, 2, 'only feeds fetched completely replace their overlap window');
  assert.equal(calls.cursors[0].normal, 50000000);
  assert.equal(calls.cursors[0].internal, 50000000);
  assert.equal(calls.cursors[0].token, null);
  const verdicts = new Map(calls.coverage[0].entries.map((entry) => [entry.feed, entry.status]));
  assert.equal(verdicts.get('normal'), 'complete');
  assert.equal(verdicts.get('internal'), 'complete');
  for (const feed of ['token', 'nft', 'nft1155']) assert.equal(verdicts.get(feed), 'deferred');
});

test('a healthy retry clears stale deferred coverage and sync errors', async (t) => {
  let shouldLimit = true;
  const { calls } = harness(t, {
    chainSet: '1',
    feedBehavior: {
      '1:normal': () => {
        if (!shouldLimit) return [];
        const error = new Error('Blockscout rate limit reached');
        error.code = 'EXPLORER_RATE_LIMITED';
        error.retryAfterMs = 1;
        throw error;
      },
    },
  });

  assert.equal((await EthWalletService.syncWallet(7)).status, 'deferred');
  shouldLimit = false;
  const retried = await EthWalletService.syncWallet(7);

  assert.equal(retried.status, 'complete');
  assert.ok(calls.cleared.includes(1), 'the recovered chain clears its stale warning');
  assert.equal(calls.walletCleared, true, 'the recovered wallet clears its stale warning');
  const finalCoverage = calls.coverage.at(-1).entries;
  assert.ok(finalCoverage.every((entry) => (
    entry.status === 'complete' || entry.status === 'not_applicable'
  )));
});

test('the full-wallet job waits outside the user lane and retries deferred wallets automatically', async (t) => {
  const originals = {
    findAllForJobs: EthWallet.findAllForJobs,
    prefetch: EthWalletService._prefetchStateSyncForWallets,
    sync: EthWalletService._syncWallet,
    serialized: EthDerivedPipeline.serializedForUser,
    finishUser: EthDerivedPipeline.finishUser,
  };
  t.after(() => {
    EthWallet.findAllForJobs = originals.findAllForJobs;
    EthWalletService._prefetchStateSyncForWallets = originals.prefetch;
    EthWalletService._syncWallet = originals.sync;
    EthDerivedPipeline.serializedForUser = originals.serialized;
    EthDerivedPipeline.finishUser = originals.finishUser;
  });

  const wallets = [
    { id: 7, user_id: 1, address: WALLET },
    { id: 8, user_id: 1, address: '0x1111111111111111111111111111111111111111' },
  ];
  EthWallet.findAllForJobs = async () => wallets;
  EthWalletService._prefetchStateSyncForWallets = async () => new Map();
  const laneEvents = [];
  EthDerivedPipeline.serializedForUser = async (userId, fn) => {
    laneEvents.push(`enter:${userId}`);
    const value = await fn();
    laneEvents.push(`exit:${userId}`);
    return value;
  };
  EthDerivedPipeline.finishUser = async () => ({});
  const attempts = new Map();
  EthWalletService._syncWallet = async (walletId) => {
    const attempt = Number(attempts.get(walletId) || 0) + 1;
    attempts.set(walletId, attempt);
    if (walletId === 7 && attempt === 1) {
      return {
        status: 'deferred',
        deferredFeeds: ['Base/normal'],
        skippedFeeds: ['Base/normal'],
        unsupportedFeeds: [],
        retryAfterMs: 1,
      };
    }
    return {
      status: walletId === 8 ? 'unsupported' : 'complete',
      deferredFeeds: [],
      skippedFeeds: [],
      unsupportedFeeds: walletId === 8 ? ['Gnosis Chain/internal'] : [],
    };
  };

  const summary = await EthWalletService.syncAllWallets({
    deferredRetryAttempts: 1,
    deferredRetryMaxMs: 100,
  });

  assert.equal(attempts.get(7), 2);
  assert.equal(attempts.get(8), 1, 'healthy and limited wallets are not needlessly replayed');
  assert.equal(summary.processed, 2);
  assert.equal(summary.succeeded, 2);
  assert.equal(summary.failed, 0);
  assert.equal(summary.deferred, 0);
  assert.equal(summary.unsupported, 1);
  assert.equal(summary.results.find((entry) => entry.walletId === 7).attempts, 2);
  assert.deepEqual(laneEvents, ['enter:1', 'exit:1', 'enter:1', 'exit:1'],
    'the cooldown wait occurs between serialized lane acquisitions');
});

test('the full-wallet job retries deferred feeds even when another feed failed', async (t) => {
  const originals = {
    findAllForJobs: EthWallet.findAllForJobs,
    prefetch: EthWalletService._prefetchStateSyncForWallets,
    sync: EthWalletService._syncWallet,
    serialized: EthDerivedPipeline.serializedForUser,
    finishUser: EthDerivedPipeline.finishUser,
  };
  t.after(() => {
    EthWallet.findAllForJobs = originals.findAllForJobs;
    EthWalletService._prefetchStateSyncForWallets = originals.prefetch;
    EthWalletService._syncWallet = originals.sync;
    EthDerivedPipeline.serializedForUser = originals.serialized;
    EthDerivedPipeline.finishUser = originals.finishUser;
  });

  EthWallet.findAllForJobs = async () => [{ id: 7, user_id: 1, address: WALLET }];
  EthWalletService._prefetchStateSyncForWallets = async () => new Map();
  EthDerivedPipeline.serializedForUser = async (_userId, fn) => fn();
  EthDerivedPipeline.finishUser = async () => ({});
  let attempts = 0;
  EthWalletService._syncWallet = async () => {
    attempts += 1;
    return attempts === 1
      ? {
        status: 'failed',
        failedFeeds: ['Polygon/token'],
        deferredFeeds: ['Base/normal'],
        skippedFeeds: ['Polygon/token', 'Base/normal'],
        unsupportedFeeds: [],
        retryAfterMs: 1,
      }
      : {
        status: 'failed',
        failedFeeds: ['Polygon/token'],
        deferredFeeds: [],
        skippedFeeds: ['Polygon/token'],
        unsupportedFeeds: [],
      };
  };

  const summary = await EthWalletService.syncAllWallets({
    deferredRetryAttempts: 1,
    deferredRetryMaxMs: 100,
  });

  assert.equal(attempts, 2, 'deferral is retried independently of the red failure status');
  assert.equal(summary.failed, 1);
  assert.equal(summary.deferred, 0);
  assert.equal(summary.results[0].attempts, 2);
});

test('a rate-limited coverage boundary returns a deferred chain instead of failing the wallet', async (t) => {
  const { calls, stub } = harness(t, { chainSet: '8453' });
  stub(EtherscanService, 'coverageBoundary', async () => {
    const error = new Error('Blockscout rate limit reached; retry after 10s');
    error.code = 'EXPLORER_RATE_LIMITED';
    error.retryAfterMs = 10000;
    throw error;
  });

  const result = await EthWalletService.syncWallet(7);

  assert.deepEqual(calls.fetches, [], 'the boundary failure prevents every feed request');
  assert.deepEqual(result.skippedFeeds, [
    'Base/normal', 'Base/internal', 'Base/token', 'Base/nft', 'Base/nft1155', 'Base/statesync',
  ]);
  assert.equal(result.chains[0].rateLimited, true);
  assert.equal(result.status, 'deferred');
  assert.equal(calls.deletes.length, 0);
  assert.equal(calls.chainErrors[0].code, 'SYNC_DEFERRED');
  assert.equal(calls.walletError.code, 'SYNC_DEFERRED');
  assert.ok(calls.coverage[0].entries.every((entry) => (
    entry.status === 'not_applicable'
    || (entry.status === 'deferred' && entry.retryAfterAt instanceof Date)
  )));
  assert.match(calls.walletError.message, /rate limited/);
});

// A row on the given chain, so a chain can be told apart by what it inserts.
const nativeRow = (block) => ({
  blockNumber: String(block), timeStamp: '1700000000', hash: `0x${block}`,
  from: WALLET, to: '0xdef', value: '1000000000000000000',
  gasUsed: '21000', gasPrice: '1000000000', isError: '0',
});

test('a chain that throws outright is isolated: the chains that landed still rebuild', async (t) => {
  // Not an Etherscan failure -- a DB blip inside the chain's own ingest, which
  // the per-feed handling never sees. Escaping the loop would abandon the whole
  // wallet: every chain that DID land would go without reclassification,
  // holdings and mirror rows, rolling derived state back to the last sync.
  const { calls, stub } = harness(t, {
    chainSet: '1,42161',
    cursors: { 1: { last_block_normal: 1000 }, 42161: { last_block_normal: 250000000 } },
    feedBehavior: {
      '1:normal': [nativeRow(2000)],
      '42161:normal': [nativeRow(250001000)],
    },
  });
  stub(EthTransfer, 'bulkInsert', async (rows) => {
    if (rows.some((row) => row.chain_id === 42161)) throw new Error('deadlock detected');
    calls.inserted.push(...rows);
    return rows.length;
  });
  let rebuilds = 0;
  stub(EthWalletService, 'refreshHoldings', async () => { rebuilds++; return {}; });
  let mirrors = 0;
  stub(MirrorService, 'rebuildForWallet', async () => { mirrors++; return {}; });

  const result = await EthWalletService.syncWallet(7);

  // The point of the fix: derived data is still rebuilt from what did land.
  assert.equal(rebuilds, 1);
  assert.equal(mirrors, 1);
  assert.equal(calls.inserted.filter((row) => row.chain_id === 1).length, 2, 'mainnet still ingested');

  // Mainnet's cursor advances; Arbitrum's is never written at all, so it
  // resumes exactly where it left off. Advancing past rows that were never
  // stored would drop them silently and forever.
  assert.equal(calls.cursors.find((c) => c.chainId === 1).normal, 50000000);
  assert.equal(calls.cursors.find((c) => c.chainId === 42161), undefined);

  // Recorded in the same error slot, with the same convention, as every other
  // per-chain failure state.
  const arbError = calls.chainErrors.find((e) => e.chainId === 42161);
  assert.equal(arbError.code, 'SYNC_ERROR');
  assert.match(arbError.message, /deadlock detected/);
  assert.ok(calls.cleared.includes(1), 'the healthy chain still clears its own slot');

  const arb = result.chains.find((c) => c.chainId === 42161);
  assert.match(arb.error, /deadlock detected/);
  assert.equal(arb.inserted, 0);
  // Transient by assumption and it retries, so the wallet badge can still reach
  // zero -- the same bargain a skipped feed makes.
  assert.equal(calls.walletError.code, 'CHAIN_SYNC_FAILED');
  assert.match(calls.walletError.message, /Arbitrum One chain/);
});

test('a wallet whose every chain fails still throws, as it did before isolation', async (t) => {
  const { calls, stub } = harness(t, { chainSet: '1,42161' });
  stub(EthTransfer, 'bulkInsert', async () => { throw new Error('connection terminated'); });

  // Nothing landed, so there is nothing to rebuild from -- the caller and the
  // nightly job's failure count must see a throw, not a clean empty sync.
  await assert.rejects(() => EthWalletService.syncWallet(7), /connection terminated/);
  assert.equal(calls.walletError.code, 'SYNC_ERROR');
  assert.equal(calls.chainErrors.length, 2, 'each chain still records its own failure');
});

test('the live "unavailable" responses map to ETHERSCAN_CHAIN_UNAVAILABLE', async (t) => {
  const axios = require('axios');
  const original = axios.get;
  t.after(() => { axios.get = original; });

  // Both strings observed live during the feed-parity probe: the first from
  // an Etherscan plan-gated chain, the second from zkSync Era's absent id.
  for (const result of [
    'Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage. https://etherscan.io/apis',
    'Missing or unsupported chainid parameter (required for v2 api), please see https://api.etherscan.io/v2/chainlist for the list of supported chainids',
  ]) {
    axios.get = async () => ({ data: { status: '0', message: 'NOTOK', result } });
    await assert.rejects(
      () => EtherscanService.getEthBalance(WALLET, 'key', 42161),
      (err) => {
        // Separated from ETHERSCAN_API_ERROR because the two demand opposite
        // handling: retry-next-sync vs record-a-standing-gap.
        assert.equal(err.code, 'ETHERSCAN_CHAIN_UNAVAILABLE');
        assert.equal(err.chainId, 42161);
        return true;
      }
    );
  }

  // An unimplemented ACTION is a different verdict: this feed, not this chain.
  // Probed live -- Etherscan answers an unknown action with this exact string.
  axios.get = async () => ({ data: { status: '0', message: 'NOTOK', result: 'Error! Missing Or invalid Action name' } });
  await assert.rejects(
    () => EtherscanService.fetchInternalTxs(WALLET, 0, 'key', 42161),
    (err) => err.code === 'ETHERSCAN_FEED_UNSUPPORTED'
  );

  // Blockscout returns status=2 with partial internal rows while a requested
  // range is not completely indexed. Treating those rows as complete would
  // advance the cursor beyond transfers that have not appeared yet. Reporting
  // the feed gap preserves stored history and makes the limitation visible.
  axios.get = async () => ({
    data: {
      status: '2',
      message: 'Some internal transactions within this block range have not yet been processed',
      result: [{ transactionHash: '0xpartial', blockNumber: '1' }],
    },
  });
  await assert.rejects(
    () => EtherscanService.fetchInternalTxs(WALLET, 0, null, 100),
    (err) => err.code === 'ETHERSCAN_FEED_UNSUPPORTED' && err.chainId === 100
  );
  axios.get = async () => ({
    data: {
      status: '2',
      message: 'Some internal transactions within this block range have not yet been processed',
      result: [],
    },
  });
  await assert.rejects(
    () => EtherscanService.fetchInternalTxs(WALLET, 0, null, 100),
    (err) => err.code === 'ETHERSCAN_FEED_UNSUPPORTED' && err.chainId === 100
  );

  // A genuine transient error keeps its own code.
  axios.get = async () => ({ data: { status: '0', message: 'NOTOK', result: 'Something went wrong' } });
  await assert.rejects(
    () => EtherscanService.getEthBalance(WALLET, 'key', 1),
    (err) => err.code === 'ETHERSCAN_API_ERROR'
  );
});

test('an HTTP 429 from a chain explorer backs off and retries without accepting an empty feed', async (t) => {
  const axios = require('axios');
  const original = axios.get;
  let requests = 0;
  axios.get = async () => {
    requests += 1;
    if (requests === 1) {
      const error = new Error('Request failed with status code 429');
      error.response = { status: 429, headers: { 'retry-after': '0' } };
      throw error;
    }
    return { data: { status: '1', result: '0' } };
  };
  t.after(() => { axios.get = original; });
  t.after(() => { etherscanConfig.resetRateLimits(); });

  assert.equal(await EtherscanService.getEthBalance(WALLET, 'key', 1), '0');
  assert.equal(requests, 2);
});

test('a one-off explorer timeout is retried before the feed is marked failed', async (t) => {
  const axios = require('axios');
  const original = axios.get;
  let requests = 0;
  axios.get = async () => {
    requests += 1;
    if (requests === 1) {
      const error = new Error('timeout of 15000ms exceeded');
      error.code = 'ECONNABORTED';
      throw error;
    }
    return { data: { status: '1', result: '0' } };
  };
  t.after(() => { axios.get = original; });
  t.after(() => { etherscanConfig.resetRateLimits(); });

  assert.equal(await EtherscanService.getEthBalance(WALLET, 'key', 137), '0');
  assert.equal(requests, 2);
});

test('a persistent explorer 429 pauses its provider queue and fails fast on the next request', async (t) => {
  const axios = require('axios');
  const original = axios.get;
  let requests = 0;
  axios.get = async () => {
    requests += 1;
    const error = new Error('Request failed with status code 429');
    error.response = { status: 429, headers: { 'retry-after': '10' } };
    throw error;
  };
  t.after(() => { axios.get = original; });
  t.after(() => { etherscanConfig.resetRateLimits(); });

  const rateLimited = (err) => err.code === 'EXPLORER_RATE_LIMITED'
    && err.retryAfterMs >= 9000;
  await assert.rejects(() => EtherscanService.getEthBalance(WALLET, 'key', 1), rateLimited);
  await assert.rejects(() => EtherscanService.getEthBalance(WALLET, 'key', 1), rateLimited);
  assert.equal(requests, 1, 'the provider pause prevents a second network request');
});

test('provider pauses are isolated by host instead of using one global queue', async (t) => {
  etherscanConfig.resetRateLimits();
  t.after(() => { etherscanConfig.resetRateLimits(); });
  etherscanConfig.pause('account:https://base.blockscout.com/api', 10000);

  let etherscanCalled = false;
  await etherscanConfig.throttled(() => {
    etherscanCalled = true;
  }, { key: 'etherscan:isolated-test', spacingMs: 0 });
  assert.equal(etherscanCalled, true);
  await assert.rejects(
    () => etherscanConfig.throttled(() => {}, {
      key: 'account:https://base.blockscout.com/api', spacingMs: 0,
    }),
    (err) => err.code === 'EXPLORER_RATE_LIMITED'
  );
});

test('the chain id reaches Etherscan as the chainid param', async (t) => {
  const axios = require('axios');
  const original = axios.get;
  const seen = [];
  axios.get = async (url, config) => {
    seen.push(config.params);
    return { data: { status: '1', result: '42' } };
  };
  t.after(() => { axios.get = original; });

  await EtherscanService.getEthBalance(WALLET, 'key', 42161);
  await EtherscanService.getEthBalance(WALLET, 'key');

  assert.equal(seen[0].chainid, 42161);
  // Default is mainnet, so every pre-#58 call site behaves exactly as it did.
  assert.equal(seen[1].chainid, 1);
});

test('a chain-declared account API omits Etherscan key and chainid parameters', async (t) => {
  const axios = require('axios');
  const original = axios.get;
  const seen = [];
  axios.get = async (url, config) => {
    seen.push({ url, params: config.params });
    return { data: { status: '0', message: 'No transactions found', result: [] } };
  };
  t.after(() => { axios.get = original; });

  await EtherscanService.fetchNormalTxs(WALLET, 0, null, 100);

  assert.equal(seen[0].url, 'https://gnosis.blockscout.com/api');
  assert.equal(seen[0].params.chainid, undefined);
  assert.equal(seen[0].params.apikey, undefined);
  assert.equal(seen[0].params.action, 'txlist');
  assert.equal(seen[0].params.endblock, 999999999,
    'OP Mainnet is already above the old 99,999,999 sentinel');
});

test('an account feed is bounded at the shared indexed head and reports empty coverage', async (t) => {
  const axios = require('axios');
  const original = axios.get;
  let seen;
  axios.get = async (url, config) => {
    seen = { url, params: config.params };
    return { data: { status: '0', message: 'No transactions found', result: [] } };
  };
  t.after(() => { axios.get = original; });

  const rows = await EtherscanService.fetchTokenTxs(WALLET, 100, null, 8453, 50000000);

  assert.equal(seen.params.startblock, 100);
  assert.equal(seen.params.endblock, 50000000);
  assert.equal(rows.length, 0);
  assert.equal(rows.scannedThroughBlock, 50000000);
  assert.deepEqual(Object.keys(rows), [], 'coverage metadata does not become a transfer row field');
});

test('an account feed freezes when the indexed head falls behind its resume block', async () => {
  await assert.rejects(
    () => EtherscanService.fetchTokenTxs(WALLET, 101, null, 8453, 100),
    (err) => err.code === 'ETHERSCAN_API_ERROR' && /behind requested block/.test(err.message)
  );
});

test('an account feed freezes when the explorer repeats a page outside the advanced range', async (t) => {
  const original = EtherscanService._request;
  let calls = 0;
  const firstPage = Array.from({ length: 1000 }, (_, i) => ({
    blockNumber: String(100 + i),
    hash: `0x${i}`,
  }));
  EtherscanService._request = async () => {
    calls += 1;
    return firstPage.map((row) => ({ ...row }));
  };
  t.after(() => { EtherscanService._request = original; });

  await assert.rejects(
    () => EtherscanService.fetchTokenTxs(WALLET, 100, null, 8453, 5000),
    (err) => err.code === 'ETHERSCAN_API_ERROR'
      && /outside requested range 1099-5000/.test(err.message)
      && /cursor frozen/.test(err.message)
  );
  assert.equal(calls, 2, 'a provider that ignores startblock is rejected immediately');
});

test('an account feed freezes on malformed or out-of-range block numbers', async (t) => {
  const original = EtherscanService._request;
  EtherscanService._request = async () => [{ blockNumber: 'not-a-block', hash: '0xbad' }];
  t.after(() => { EtherscanService._request = original; });

  await assert.rejects(
    () => EtherscanService.fetchNormalTxs(WALLET, 100, null, 8453, 5000),
    (err) => err.code === 'ETHERSCAN_API_ERROR'
      && /block "not-a-block" outside requested range/.test(err.message)
  );
});

test('a block at the provider 10000-row ceiling freezes instead of dropping an unknown tail', async (t) => {
  const original = EtherscanService._request;
  let calls = 0;
  EtherscanService._request = async () => {
    calls += 1;
    const size = calls === 1 ? 1000 : 10000;
    return Array.from({ length: size }, (_, i) => ({
      blockNumber: '42',
      hash: `0x${i}`,
    }));
  };
  t.after(() => { EtherscanService._request = original; });

  await assert.rejects(
    () => EtherscanService.fetchNormalTxs(WALLET, 42, null, 8453, 5000),
    (err) => err.code === 'ETHERSCAN_API_ERROR'
      && /block 42 reached the 10000-row provider limit/.test(err.message)
      && /cursor frozen/.test(err.message)
  );
  assert.equal(calls, 2);
});

test('a keyless-only chain set syncs without an Etherscan credential', async (t) => {
  const { calls } = harness(t, {
    chainSet: '100',
    apiKey: null,
    feedBehavior: {
      '100:normal': [{
        blockNumber: '42',
        timeStamp: '1700000000',
        hash: '0xkeyless',
        from: WALLET,
        to: '0x1111111111111111111111111111111111111111',
        value: '1',
        gasUsed: '0',
        gasPrice: '0',
        isError: '0',
      }],
    },
  });

  const result = await EthWalletService.syncWallet(7);

  assert.deepEqual(result.chains.map((row) => row.chainId), [100]);
  assert.ok(calls.fetches.every((call) => call.chainId === 100));
  assert.ok(calls.fetches.every((call) => call.apiKey == null));
  assert.equal(calls.inserted[0].chain_id, 100);
});

test('Gnosis live balances use keyless RPC instead of Blockscout indexed balances', async (t) => {
  const axios = require('axios');
  const originalGet = axios.get;
  const originalPost = axios.post;
  let getCalled = false;
  const rpcCalls = [];
  axios.get = async () => { getCalled = true; throw new Error('Blockscout balance must not be used'); };
  axios.post = async (url, body) => {
    rpcCalls.push({ url, body });
    return { data: { jsonrpc: '2.0', id: 1, result: '0x2a' } };
  };
  t.after(() => { axios.get = originalGet; axios.post = originalPost; });

  assert.equal(await EtherscanService.getEthBalance(WALLET, null, 100), '42');
  assert.equal(await EtherscanService.getTokenBalance(
    WALLET, '0x1111111111111111111111111111111111111111', null, 100
  ), '42');
  assert.equal(getCalled, false);
  assert.equal(rpcCalls[0].url, 'https://rpc.gnosischain.com');
  assert.equal(rpcCalls[0].body.method, 'eth_getBalance');
  assert.equal(rpcCalls[1].body.method, 'eth_call');
  assert.match(rpcCalls[1].body.params[0].data, /^0x70a08231[0-9a-f]{64}$/);
});

test('OP Mainnet and Base live balances use their public RPC endpoints', async (t) => {
  const axios = require('axios');
  const originalPost = axios.post;
  const seen = [];
  axios.post = async (url, body) => {
    seen.push({ url, method: body.method });
    return { data: { jsonrpc: '2.0', id: 1, result: '0x2a' } };
  };
  t.after(() => { axios.post = originalPost; });

  assert.equal(await EtherscanService.getEthBalance(WALLET, null, 10), '42');
  assert.equal(await EtherscanService.getEthBalance(WALLET, null, 8453), '42');
  assert.deepEqual(seen, [
    { url: 'https://mainnet.optimism.io', method: 'eth_getBalance' },
    { url: 'https://mainnet.base.org', method: 'eth_getBalance' },
  ]);
});

test('Blockscout log coverage uses the explorer indexed head, not the newer RPC head', async (t) => {
  const axios = require('axios');
  const originalGet = axios.get;
  let seenUrl;
  axios.get = async (url) => {
    seenUrl = url;
    return { data: { items: [{ height: 49295092 }] } };
  };
  t.after(() => { axios.get = originalGet; });

  assert.equal(await EtherscanService._latestBlockNumber(null, 8453), 49295092);
  assert.equal(seenUrl, 'https://base.blockscout.com/api/v2/blocks?type=block');
});

test('a body-level Blockscout throttle on the indexed-head boundary is retried', async (t) => {
  const axios = require('axios');
  const originalGet = axios.get;
  let requests = 0;
  axios.get = async () => {
    requests += 1;
    if (requests === 1) {
      return {
        headers: { 'retry-after': '0' },
        data: { message: 'Too many requests' },
      };
    }
    return { data: { items: [{ height: 49295092 }] } };
  };
  t.after(() => { axios.get = originalGet; });
  t.after(() => { etherscanConfig.resetRateLimits(); });

  assert.equal(await EtherscanService._latestBlockNumber(null, 8453), 49295092);
  assert.equal(requests, 2);
});

test('HTTP and body-level throttles share one bounded retry budget', async (t) => {
  const axios = require('axios');
  const originalGet = axios.get;
  let requests = 0;
  axios.get = async () => {
    requests += 1;
    if (requests === 2) {
      return {
        headers: { 'retry-after': '0' },
        data: { status: '0', message: 'Too many requests', result: 'rate limit reached' },
      };
    }
    const error = new Error('HTTP 429');
    error.response = { status: 429, headers: { 'retry-after': '0' } };
    throw error;
  };
  t.after(() => { axios.get = originalGet; });
  t.after(() => { etherscanConfig.resetRateLimits(); });

  await assert.rejects(
    () => EtherscanService._request(
      { module: 'account', action: 'txlist', address: WALLET },
      { apiKey: null, chainId: 8453 }
    ),
    (error) => error.code === 'EXPLORER_RATE_LIMITED'
  );
  assert.equal(requests, 3, 'two configured retries permit three total attempts');
});

test('Etherscan proxy JSON-RPC responses supply the Polygon log coverage head', async (t) => {
  const axios = require('axios');
  const originalGet = axios.get;
  let seen;
  axios.get = async (url, config) => {
    seen = { url, params: config.params };
    return { data: { jsonrpc: '2.0', id: 83, result: '0x56f00de' } };
  };
  t.after(() => { axios.get = originalGet; });

  assert.equal(await EtherscanService._latestBlockNumber('test-key', 137), 91160798);
  assert.equal(seen.url, 'https://api.etherscan.io/v2/api');
  assert.equal(seen.params.chainid, 137);
  assert.equal(seen.params.module, 'proxy');
  assert.equal(seen.params.action, 'eth_blockNumber');
});

test('Blockscout head falls back to the documented legacy explorer endpoint', async (t) => {
  const axios = require('axios');
  const originalGet = axios.get;
  const calls = [];
  axios.get = async (url, config = {}) => {
    calls.push({ url, params: config.params });
    if (url.includes('/api/v2/blocks')) {
      const error = new Error('Request failed with status code 500');
      error.response = { status: 500 };
      throw error;
    }
    return { data: { jsonrpc: '2.0', id: 1, result: '0x2f0b0f5' } };
  };
  t.after(() => { axios.get = originalGet; });

  assert.equal(await EtherscanService._latestBlockNumber(null, 8453), 49328373);
  assert.equal(calls[0].url, 'https://base.blockscout.com/api/v2/blocks?type=block');
  assert.equal(calls[1].url, 'https://base.blockscout.com/api/v2/blocks?type=block',
    'one transient v2 failure is retried before changing endpoints');
  assert.equal(calls[2].url, 'https://base.blockscout.com/api');
  assert.equal(calls[2].params.module, 'block');
  assert.equal(calls[2].params.action, 'eth_block_number');
});

test('a direct OP Stack self-deposit becomes one bridge-classifiable inbound credit', () => {
  const bridge = '0x4200000000000000000000000000000000000010';
  const [credit] = EthWalletService.normalizeFeeds(WALLET, {
    normal: [{
      blockNumber: '49289908',
      timeStamp: '1785369163',
      hash: '0xdirectdeposit',
      from: WALLET,
      to: WALLET,
      value: '71088375931383555894',
      gasUsed: '21000',
      gasPrice: '0',
      input: '0x',
      isError: '0',
      opStackType: '0x7e',
      opStackSourceHash: `0x${'1'.repeat(64)}`,
      opStackMintWei: '71088375931383555894',
    }],
  }, { opStackDeposits: { creditSource: bridge } });

  assert.equal(credit.transfer_type, 'native');
  assert.equal(credit.from_address, bridge);
  assert.equal(credit.to_address, WALLET);
  assert.equal(credit.value_wei, '71088375931383555894');
  assert.equal(credit.ordinal, 0);
});

test('OP Stack deposit metadata is restored from JSON-RPC before normalization', async (t) => {
  const hash = `0x${'a'.repeat(64)}`;
  const sourceHash = `0x${'b'.repeat(64)}`;
  const originalPaged = EtherscanService._fetchPaged;
  const originalRpc = EtherscanService._rpcRequest;
  EtherscanService._fetchPaged = async () => [{
    hash,
    from: WALLET,
    to: WALLET,
    value: '7',
    gasPrice: '0',
    isError: '0',
  }];
  EtherscanService._rpcRequest = async (chainId, method, params) => {
    assert.equal(chainId, 8453);
    assert.equal(method, 'eth_getTransactionByHash');
    assert.deepEqual(params, [hash]);
    return {
      hash,
      type: '0x7e',
      sourceHash,
      mint: '0xb',
      value: '0x7',
    };
  };
  t.after(() => {
    EtherscanService._fetchPaged = originalPaged;
    EtherscanService._rpcRequest = originalRpc;
  });

  const rows = await EtherscanService.fetchNormalTxs(WALLET, 0, null, 8453, 50000000);
  const [row] = rows;
  assert.equal(row.opStackType, '0x7e');
  assert.equal(row.opStackSourceHash, sourceHash);
  assert.equal(row.opStackMintWei, '11');
  assert.equal(rows.scannedThroughBlock, 50000000,
    'RPC enrichment preserves the account feed coverage boundary');
});

test('a failed OP Stack execution keeps the independent mint credit', () => {
  const [credit] = EthWalletService.normalizeFeeds(WALLET, {
    normal: [{
      blockNumber: '49289908',
      timeStamp: '1785369163',
      hash: '0xfaileddeposit',
      from: WALLET,
      to: '0x1111111111111111111111111111111111111111',
      value: '5',
      gasUsed: '99999',
      gasPrice: '0',
      input: '0x1234',
      isError: '1',
      opStackType: '0x7e',
      opStackSourceHash: `0x${'4'.repeat(64)}`,
      opStackMintWei: '11',
    }],
  }, { opStackDeposits: chains.getChain(8453).opStackDeposits });

  assert.equal(credit.from_address, '0x4200000000000000000000000000000000000010');
  assert.equal(credit.to_address, WALLET);
  assert.equal(credit.value_wei, '11');
  assert.equal(credit.is_error, false, 'the unconditional mint itself succeeded and must count in balance math');
});

test('an OP Stack deposit sent onward is net-zero for the tracked L2 sender', () => {
  const rows = EthWalletService.normalizeFeeds(WALLET, {
    normal: [{
      blockNumber: '49289908',
      timeStamp: '1785369163',
      hash: '0xdeposittosomeoneelse',
      from: WALLET,
      to: '0x1111111111111111111111111111111111111111',
      value: '1000000000000000000',
      gasUsed: '21000',
      gasPrice: '0',
      input: '0x',
      isError: '0',
      opStackType: '0x7e',
      opStackSourceHash: `0x${'2'.repeat(64)}`,
      opStackMintWei: '1000000000000000000',
    }],
  }, { opStackDeposits: chains.getChain(8453).opStackDeposits });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].from_address, '0x4200000000000000000000000000000000000010');
  assert.equal(rows[0].value_wei, '1000000000000000000');
  assert.equal(rows[1].from_address, WALLET);
  assert.equal(rows[1].to_address, '0x1111111111111111111111111111111111111111');
  assert.equal(rows[1].value_wei, '1000000000000000000',
    'mint and execution stay separate so exact balance math nets them to zero');
});

test('a pre-version OP/Base chain resets every cursor and reingests from genesis once', async (t) => {
  const { calls } = harness(t, {
    chainSet: '8453',
    cursors: {
      8453: {
        ingest_version: 0,
        last_block_normal: 49000000,
        last_block_internal: 49000000,
        last_block_token: 49000000,
        last_block_nft: 49000000,
        last_block_1155: 49000000,
        last_block_statesync: 49000000,
      },
    },
  });

  await EthWalletService.syncWallet(7);

  assert.deepEqual(calls.resets, [{ chainId: 8453, ingestVersion: 1 }]);
  assert.ok(calls.fetches.every((call) => call.startBlock === 0),
    'the provider and normalization change heals every historical feed');
  assert.ok(calls.deletes.every((call) => call.block === 0),
    'each successful feed replaces its full old window');
});

test('empty OP Stack feeds persist indexed coverage and resume incrementally on the next sync', async (t) => {
  const { calls } = harness(t, { chainSet: '8453' });

  await EthWalletService.syncWallet(7);
  await EthWalletService.syncWallet(7);

  const cursorWrites = calls.cursors.filter((write) => write.chainId === 8453);
  assert.equal(cursorWrites.length, 2);
  for (const field of ['normal', 'internal', 'token', 'nft', 'nft1155', 'statesync']) {
    assert.equal(cursorWrites[0][field], 50000000, `${field} records empty-feed coverage`);
  }
  const secondFetches = calls.fetches.filter((call) => call.chainId === 8453).slice(6);
  assert.equal(secondFetches.length, 6);
  assert.ok(secondFetches.every((call) => call.startBlock === 50000000 - 64),
    'the second sync uses the stored indexed head with only the reorg overlap');
  assert.ok(secondFetches.every((call) => call.coverage === 50000000),
    'all account and native-credit feeds share one indexed coverage boundary');
});

test('coverage names the actual Base state-sync provider', async (t) => {
  const { calls } = harness(t, { chainSet: '8453' });

  await EthWalletService.syncWallet(7);

  const entry = calls.coverage
    .find((attempt) => attempt.chainId === 8453)
    .entries.find((row) => row.feed === 'statesync');
  assert.equal(entry.provider, 'Blockscout (https://base.blockscout.com/api)');
});

test('OP Stack deposit reshaping declines every off-shape enriched row', () => {
  const config = chains.getChain(8453).opStackDeposits;
  const base = {
    blockNumber: '1',
    timeStamp: '1700000000',
    hash: '0xnear',
    from: WALLET,
    to: WALLET,
    value: '1',
    gasUsed: '21000',
    gasPrice: '0',
    input: '0x',
    isError: '0',
    opStackType: '0x7e',
    opStackSourceHash: `0x${'3'.repeat(64)}`,
    opStackMintWei: '1',
  };
  for (const patch of [
    { opStackType: undefined },
    { opStackSourceHash: '0x1234' },
    { opStackMintWei: 'not-decimal' },
    { isError: undefined },
    { to: 'not-an-address' },
  ]) {
    assert.equal(EthWalletService.opStackDepositEffects({ ...base, ...patch }, config), null);
  }
});

test('Blockscout internal transactionHash is normalized to the ingestion hash field', async (t) => {
  const axios = require('axios');
  const original = axios.get;
  axios.get = async () => ({
    data: {
      status: '1',
      message: 'OK',
      result: [{
        transactionHash: '0xblockscout',
        blockNumber: '42',
        timeStamp: '1700000000',
        from: WALLET,
        to: '0xdef',
        value: '1',
      }],
    },
  });
  t.after(() => { axios.get = original; });

  const rows = await EtherscanService.fetchInternalTxs(WALLET, 0, null, 100);
  assert.equal(rows[0].hash, '0xblockscout');
  assert.equal(rows[0].transactionHash, '0xblockscout');
});

// ---------------------------------------------------------------------------
// Disabling a chain
// ---------------------------------------------------------------------------

test('a disabled chain is not synced at all', async (t) => {
  const { calls } = harness(t, { chainSet: '1' });

  await EthWalletService.syncWallet(7);

  assert.deepEqual([...new Set(calls.fetches.map((c) => c.chainId))], [1]);
  assert.ok(calls.fetches.every((c) => c.chainId === 1));
  assert.ok(calls.deletes.every((d) => d.chainId === 1));
  assert.ok(calls.cursors.every((c) => c.chainId === 1));
  // No error slot is written for a chain that was never asked to sync -- a
  // disabled chain is not a degraded one.
  assert.ok(calls.chainErrors.every((e) => e.chainId === 1));
  assert.deepEqual(calls.cleared, [1]);
});

test('a disabled chain keeps its stored holdings: cleanup is scoped to refreshed chains', async (t) => {
  const restore = [];
  const stub = (obj, key, fn) => { restore.push([obj, key, obj[key]]); obj[key] = fn; };
  const priorChains = process.env.ETH_CHAINS;
  process.env.ETH_CHAINS = '1';
  t.after(() => {
    for (const [o, k, v] of restore) o[k] = v;
    if (priorChains === undefined) delete process.env.ETH_CHAINS;
    else process.env.ETH_CHAINS = priorChains;
  });

  stub(EthWallet, 'findById', async () => ({ id: 7, user_id: 1, address: WALLET }));
  stub(EthWallet, 'getAccountForWallet', async () => ({ id: 9 }));
  stub(SecretsService, 'getUserKey', async () => 'key');
  stub(EtherscanService, 'getEthBalance', async () => '1000000000000000000');
  // Arbitrum was synced before and is now switched off; its row survives.
  stub(EthWalletChain, 'findForWallet', async () => [
    { wallet_id: 7, chain_id: 1, error_code: null },
    { wallet_id: 7, chain_id: 42161, error_code: null },
  ]);
  stub(EthTransfer, 'tokenBalanceDeltas', async () => [
    { chain_id: 42161, token_contract: '0xtok', token_symbol: 'ARB', token_decimals: 18, balance_units: '5000000000000000000' },
  ]);

  queries.length = 0;
  const result = await EthWalletService.refreshHoldings(7);

  // Only mainnet was re-derived, so only mainnet's rows are eligible for
  // deletion. A cleanup keyed on names alone would reap every Arbitrum row the
  // moment the chain was switched off -- which is the difference between
  // "stop syncing" and "delete my history".
  const cleanup = queries.find((q) => /DELETE FROM holdings/.test(q.text));
  assert.match(sqlOf(cleanup), /COALESCE\(chain_id, \$2\) = ANY\(\$3::int\[\]\)/);
  assert.deepEqual(cleanup.params[2], [1], 'only the chains refreshed this run');
  assert.deepEqual(result.chains, [1]);
  // The disabled chain's token was not re-derived either -- its stored holding
  // stands rather than being rewritten from a stale delta.
  assert.equal(result.tokens, 0);
  // Mainnet's ETH row keeps its exact pre-#58 identity.
  const inserted = queries.filter((q) => /INSERT INTO holdings/.test(q.text));
  assert.ok(inserted.some((q) => q.params.includes('Ethereum') && q.params.includes('ETH')));
});

test('an L2 whose balance call fails keeps last night’s position', async (t) => {
  const restore = [];
  const stub = (obj, key, fn) => { restore.push([obj, key, obj[key]]); obj[key] = fn; };
  const priorChains = process.env.ETH_CHAINS;
  process.env.ETH_CHAINS = '1,42161';
  t.after(() => {
    for (const [o, k, v] of restore) o[k] = v;
    if (priorChains === undefined) delete process.env.ETH_CHAINS;
    else process.env.ETH_CHAINS = priorChains;
  });

  stub(EthWallet, 'findById', async () => ({ id: 7, user_id: 1, address: WALLET }));
  stub(EthWallet, 'getAccountForWallet', async () => ({ id: 9 }));
  stub(SecretsService, 'getUserKey', async () => 'key');
  stub(EthWalletChain, 'findForWallet', async () => []);
  stub(EthTransfer, 'tokenBalanceDeltas', async () => []);
  stub(EtherscanService, 'getEthBalance', async (address, apiKey, chainId) => {
    if (chainId === 42161) throw new Error('timeout of 15000ms exceeded');
    return '1000000000000000000';
  });

  queries.length = 0;
  const result = await EthWalletService.refreshHoldings(7);

  assert.deepEqual(result.chains, [1], 'the failed chain is not marked refreshed');
  const cleanup = queries.find((q) => /DELETE FROM holdings/.test(q.text));
  assert.deepEqual(cleanup.params[2], [1]);

  // Mainnet keeps its pre-#58 fail-loud contract: an unreadable mainnet balance
  // means nothing derived from this run can be trusted.
  stub(EtherscanService, 'getEthBalance', async () => { throw new Error('timeout of 15000ms exceeded'); });
  await assert.rejects(() => EthWalletService.refreshHoldings(7), /timeout/);
});

// ---------------------------------------------------------------------------
// Cursor seeding from the existing wallet rows
// ---------------------------------------------------------------------------

test('039 seeds every existing wallet as chain 1 from its stored cursors', () => {
  // Without this, the first post-upgrade sync resumes chain 1 from block 0 and
  // re-ingests every wallet's entire history.
  assert.match(MIGRATION, /INSERT INTO eth_wallet_chains/);
  assert.match(MIGRATION, /FROM eth_wallets w/);
  const seed = MIGRATION.slice(MIGRATION.indexOf('INSERT INTO eth_wallet_chains'));
  for (const column of ['last_block_normal', 'last_block_internal', 'last_block_token', 'last_block_nft', 'last_block_1155']) {
    assert.ok(seed.includes(`w.${column}`), `${column} must be carried over, NFT cursors included`);
  }
  assert.match(seed, /SELECT w\.id, 1,/, 'existing wallets have only ever synced mainnet');
});

test('039’s seed is DO NOTHING, never DO UPDATE', () => {
  // Migrations re-run on every boot and eth_wallets.last_block_* is frozen from
  // #58 on, so a DO UPDATE would rewind every live chain-1 cursor to a stale
  // value at every restart. Because sync DELETES its resume window before
  // re-inserting, that is not merely wasted refetching: each boot would delete
  // and rebuild the wallet's whole transfer history.
  const seed = MIGRATION.slice(MIGRATION.indexOf('INSERT INTO eth_wallet_chains'));
  assert.match(seed, /ON CONFLICT \(wallet_id, chain_id\) DO NOTHING/);
  assert.ok(!/DO UPDATE/i.test(seed), 'the seed must never update a live cursor row');
});

test('039 carries all five cursors plus the per-chain error and gap columns', () => {
  const table = MIGRATION.slice(
    MIGRATION.indexOf('CREATE TABLE IF NOT EXISTS eth_wallet_chains'),
    MIGRATION.indexOf('INSERT INTO eth_wallet_chains')
  );
  for (const column of [
    'last_block_normal', 'last_block_internal', 'last_block_token',
    'last_block_nft', 'last_block_1155',
    'error_code', 'error_message', 'unsupported_feeds', 'last_synced_at',
  ]) {
    assert.ok(table.includes(column), `eth_wallet_chains needs ${column}`);
  }
  assert.match(table, /PRIMARY KEY \(wallet_id, chain_id\)/);
  // The NFT cursors default to 0 like they do on the wallet row, so a
  // newly-enabled chain backfills NFTs from genesis on its first sync.
  assert.match(table, /last_block_nft BIGINT NOT NULL DEFAULT 0/);
  assert.match(table, /last_block_1155 BIGINT NOT NULL DEFAULT 0/);
});

test('050 adds an idempotent conservative ingestion version marker', () => {
  assert.match(INGEST_VERSION_MIGRATION,
    /ADD COLUMN IF NOT EXISTS ingest_version INT NOT NULL DEFAULT 0/);
  assert.equal(chains.getChain(10).ingestVersion, 1);
  assert.equal(chains.getChain(8453).ingestVersion, 1);
});

test('054 converts raw and derived chain times from intended UTC wall clocks exactly once', () => {
  for (const table of ['eth_transfers', 'eth_activity']) {
    assert.match(
      UTC_CHAIN_TIMES_MIGRATION,
      new RegExp(`table_name = '${table}'[\\s\\S]*?data_type = 'timestamp without time zone'[\\s\\S]*?ALTER TABLE ${table}[\\s\\S]*?block_time TYPE TIMESTAMPTZ[\\s\\S]*?USING block_time AT TIME ZONE 'UTC'`)
    );
  }
  assert.equal(
    (UTC_CHAIN_TIMES_MIGRATION.match(/data_type = 'timestamp without time zone'/g) || []).length,
    2,
    'both type changes are guarded so the boot-time migration rerun cannot shift timestamps'
  );
});

test('chain ingestion version writes are explicit and reset every feed cursor', async () => {
  queries.length = 0;
  await EthWalletChain.ensure(7, 8453, 1);
  await EthWalletChain.resetForIngestVersion(7, 8453, 1);

  const insert = queries.find((q) => /INSERT INTO eth_wallet_chains/.test(q.text));
  assert.match(sqlOf(insert), /\(wallet_id, chain_id, ingest_version\) VALUES \(\$1, \$2, \$3\)/);
  assert.deepEqual(insert.params, [7, 8453, 1]);

  const reset = queries.find((q) => /SET last_block_normal = 0/.test(q.text));
  for (const cursor of [
    'last_block_normal', 'last_block_internal', 'last_block_token',
    'last_block_nft', 'last_block_1155', 'last_block_statesync',
  ]) {
    assert.match(sqlOf(reset), new RegExp(`${cursor} = 0`));
  }
  assert.match(sqlOf(reset), /ingest_version = \$3/);
  assert.match(sqlOf(reset), /ingest_version < \$3/);
});

test('the explicit recapture reset clears every cursor and no annotation table', async () => {
  queries.length = 0;
  await EthWalletChain.resetForRecapture(7, 8453);

  const reset = queries.at(-1);
  for (const cursor of [
    'last_block_normal', 'last_block_internal', 'last_block_token',
    'last_block_nft', 'last_block_1155', 'last_block_statesync',
  ]) {
    assert.match(sqlOf(reset), new RegExp(`${cursor} = 0`));
  }
  assert.match(sqlOf(reset), /WHERE wallet_id = \$1 AND chain_id = \$2/);
  assert.deepEqual(reset.params, [7, 8453]);
  for (const annotationTable of [
    'eth_activity_overrides', 'eth_address_notes', 'eth_address_labels',
    'eth_reconciliation_adjustments',
  ]) {
    assert.doesNotMatch(reset.text, new RegExp(annotationTable));
  }
});

test('039 keeps every statement idempotent for the boot-time re-run', () => {
  const statements = MIGRATION
    .replace(/--[^\n]*/g, '')
    // DO blocks are checked separately: the statements inside them are the
    // catalog-guarded ones, which is exactly how a constraint swap stays
    // re-runnable without an IF NOT EXISTS it cannot have.
    .replace(/DO \$\$[\s\S]*?\$\$/g, 'DO_BLOCK')
    .split(/;\s*(?=\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    if (/^ALTER TABLE/i.test(statement)) {
      assert.match(statement, /ADD COLUMN IF NOT EXISTS/i, `not idempotent: ${statement.slice(0, 80)}`);
    }
    if (/^CREATE TABLE/i.test(statement)) assert.match(statement, /IF NOT EXISTS/i);
    if (/^CREATE INDEX/i.test(statement)) assert.match(statement, /IF NOT EXISTS/i);
  }
  // Constraint swaps cannot use IF NOT EXISTS, so they need a catalog guard.
  assert.match(MIGRATION, /DO \$\$\s*BEGIN\s*IF NOT EXISTS \(SELECT 1 FROM pg_constraint/);

  // Both backfills are guarded on IS NULL, which is what makes the boot-time
  // re-run a no-op instead of rewriting rows a later sync has already set.
  for (const update of statements.filter((s) => /^UPDATE/i.test(s))) {
    assert.match(update, /chain_id IS NULL/, `not idempotent: ${update.slice(0, 80)}`);
  }
});

test('039 backfills chain_id onto transactions the mirror wrote before the column existed', () => {
  // Without this, "NULL chain_id means not on-chain" -- which the column
  // comment promises and the activity layer relies on -- is false for every
  // pre-#58 mirrored row: they carry an eth_transfer_id and a NULL chain.
  const start = MIGRATION.indexOf('UPDATE transactions t');
  const backfill = MIGRATION.slice(start, MIGRATION.indexOf(';', start));
  assert.match(backfill, /SET chain_id = e\.chain_id/);
  assert.match(backfill, /FROM eth_transfers e/);
  assert.match(backfill, /t\.eth_transfer_id = e\.id/);
  // Taken from the transfer, not defaulted to 1, so it stays correct once an L2
  // sync has mirrored rows of its own.
  assert.ok(!/SET chain_id = 1/.test(backfill));
});

// ---------------------------------------------------------------------------
// Mirror + snapshots
// ---------------------------------------------------------------------------

test('the transactions mirror carries chain_id through', async (t) => {
  const restore = [];
  const stub = (obj, key, fn) => { restore.push([obj, key, obj[key]]); obj[key] = fn; };
  t.after(() => { for (const [o, k, v] of restore) o[k] = v; });

  stub(EthWallet, 'findById', async () => ({ id: 7, user_id: 1, address: WALLET }));
  stub(EthWallet, 'getAccountForWallet', async () => ({ id: 9 }));
  // No price stub: the mirror fetches nothing since #73. usd_at_time is what
  // the valuation pass already wrote onto the leg.
  const transfers = [
    { id: 1, chain_id: 42161, transfer_type: 'native', tx_hash: '0xa', block_time: new Date(0), from_address: WALLET, to_address: '0xdef', value_wei: '1000000000000000000', is_error: false, counterparty_is_own: false, counterparty_exchange: null, usd_at_time: '3000.00', usd_basis: 'exact' },
  ];
  const originalQuery = require('../src/config/database').query;
  restore.push([require('../src/config/database'), 'query', originalQuery]);
  require('../src/config/database').query = async (text, params) => {
    queries.push({ text, params });
    if (/FROM eth_transfers WHERE wallet_id/.test(text)) return { rows: transfers };
    return { rows: [] };
  };

  queries.length = 0;
  await MirrorService.rebuildForWallet(7);

  const insert = queries.find((q) => /INSERT INTO transactions/.test(q.text));
  assert.match(sqlOf(insert), /INSERT INTO transactions \(eth_transfer_id, date, name, amount, category, chain_id,/);
  // The chain has to ride on the ledger row itself: the activity layer and the
  // #63 chain column cannot tell an Arbitrum gas fee from a mainnet one
  // otherwise, and they read transactions, not eth_transfers.
  assert.equal(insert.params[5], 42161);
});

// The per-chain platform invariant moved with #73: the mirror stopped fetching
// prices entirely, and the chain-scoped CoinGecko lookup now lives in the
// historical series fill. The invariant itself is unchanged and still the one
// that matters -- an Arbitrum contract asked against the ethereum platform is a
// 404, which would be recorded as a permanent "this token has no price" verdict
// against a perfectly listed token.
test('per-chain token prices use that chain’s CoinGecko platform', async (t) => {
  const restore = [];
  const stub = (obj, key, fn) => { restore.push([obj, key, obj[key]]); obj[key] = fn; };
  t.after(() => { for (const [o, k, v] of restore) o[k] = v; });

  const axios = require('axios');
  const HistoricalPriceService = require('../src/services/HistoricalPriceService');
  const AssetPriceHistory = require('../src/models/AssetPriceHistory');
  const SecretsService = require('../src/services/SecretsService');

  const MAINNET_TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const ARBITRUM_TOKEN = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  const urls = [];
  stub(axios, 'get', async (url) => {
    urls.push(url);
    return { status: 200, data: { prices: [[Date.parse('2026-07-01T00:00:00Z'), 1.5]] } };
  });
  stub(SecretsService, 'getAppSetting', async () => null);
  stub(AssetPriceHistory, 'ledgerAssetsForWallet', async () => ([
    { asset_key: `erc20:1:${MAINNET_TOKEN}`, asset_symbol: 'A', first_date: '2026-06-01' },
    { asset_key: `erc20:42161:${ARBITRUM_TOKEN}`, asset_symbol: 'B', first_date: '2026-06-01' },
  ]));
  stub(AssetPriceHistory, 'coverageFor', async () => new Map());
  stub(AssetPriceHistory, 'coveredRange', async () => ({ earliest: null, latest: null, points: 0 }));
  stub(AssetPriceHistory, 'upsertMany', async () => 1);
  stub(AssetPriceHistory, 'upsertCoverage', async () => null);

  await HistoricalPriceService.ensureAssetsForWallet(7);

  assert.ok(urls.some((url) => url.includes(`/coins/ethereum/contract/${MAINNET_TOKEN}/market_chart/range`)));
  assert.ok(urls.some((url) => url.includes(`/coins/arbitrum-one/contract/${ARBITRUM_TOKEN}/market_chart/range`)));
  // Never pooled into one platform: two contracts, two chain-scoped calls.
  assert.equal(urls.filter((url) => url.includes('/market_chart/range')).length, 2);
});

test('same-ticker holdings in one account collapse instead of aborting the snapshot job', () => {
  // TickerSnapshot upserts on (date, account, ticker). Two ETH rows in one
  // account would appear twice in one INSERT ... ON CONFLICT DO UPDATE, and
  // Postgres errors outright -- killing the nightly job for every user.
  const collapsed = collapseDuplicateKeys([
    { snapshotDate: '2026-07-26', accountId: 9, ticker: 'ETH', name: 'ETH (Arbitrum)', value: 300, quantity: 0.1, price: 3000, holdingId: 22 },
    { snapshotDate: '2026-07-26', accountId: 9, ticker: 'ETH', name: 'Ethereum', value: 3000, quantity: 1, price: 3000, holdingId: 11 },
    { snapshotDate: '2026-07-26', accountId: 9, ticker: null, name: 'USDC 0x1234…5678', value: 50, quantity: null, price: null, holdingId: 33 },
    { snapshotDate: '2026-07-26', accountId: 9, ticker: null, name: 'USDC 0x1234…5678 (Base)', value: 20, quantity: null, price: null, holdingId: 44 },
  ]);

  assert.equal(collapsed.length, 3);
  const eth = collapsed.find((s) => s.ticker === 'ETH');
  assert.equal(eth.value, 3300, 'the account total must stay exact');
  assert.equal(eth.quantity, 1.1);
  // Lowest holding id wins the label, so the series keeps one stable name --
  // holdings arrive ordered by updated_at, so "first seen" would flap.
  assert.equal(eth.name, 'Ethereum');
  // Chain-suffixed token names are already distinct keys and stay separate.
  assert.deepEqual(
    collapsed.filter((s) => s.ticker === null).map((s) => s.name).sort(),
    ['USDC 0x1234…5678', 'USDC 0x1234…5678 (Base)']
  );
});

test('the collapse is keyed on the raw ticker, exactly like the index it protects', () => {
  // idx_ticker_snapshots_unique is (snapshot_date, account_id, ticker) with no
  // case folding, so 'aapl' and 'AAPL' are two rows Postgres inserts happily.
  // Folding case here would merge two legitimately separate series and lose the
  // second's history -- a wider collapse than the crash it exists to prevent.
  const collapsed = collapseDuplicateKeys([
    { accountId: 9, ticker: 'AAPL', name: 'Apple', value: 100, quantity: 1, price: 100, holdingId: 1 },
    { accountId: 9, ticker: 'aapl', name: 'apple', value: 200, quantity: 2, price: 100, holdingId: 2 },
  ]);
  assert.equal(collapsed.length, 2);
  assert.deepEqual(collapsed.map((s) => s.value).sort((a, b) => a - b), [100, 200]);
});

test('a merged quantity is dropped when one side has none', () => {
  // quantity * price must never disagree with value: a tickered row merged with
  // a manually valued one has no meaningful share count.
  const [merged] = collapseDuplicateKeys([
    { accountId: 9, ticker: 'ETH', name: 'Ethereum', value: 3000, quantity: 1, price: 3000, holdingId: 11 },
    { accountId: 9, ticker: 'ETH', name: 'ETH (Base)', value: 100, quantity: null, price: null, holdingId: 22 },
  ]);
  assert.equal(merged.value, 3100);
  assert.equal(merged.quantity, null);
  assert.equal(merged.price, null);
});

test('the ETH holding is summed across chains, not read from one row', async () => {
  queries.length = 0;
  await EthWallet.getEthQuantity(7);
  // Reading a single row would report whichever chain the planner returned
  // first -- an L2-heavy wallet showing a fraction of its balance, silently.
  assert.match(sqlOf(queries[0]), /SELECT SUM\(h\.quantity\) AS quantity/);
  assert.match(sqlOf(queries[0]), /UPPER\(h\.ticker\) = 'ETH'/);
});

test('address labels stay chain-agnostic', async () => {
  queries.length = 0;
  await EthTransfer.reclassifyCounterparties(1);
  // Exchanges and bridges are the same counterparty whatever chain they are
  // reached on, so a chain column here would fragment one verdict into five and
  // make the triage queue undrainable.
  for (const query of queries) {
    assert.ok(!/chain_id/.test(query.text), 'classification must not join on chain');
  }
});
