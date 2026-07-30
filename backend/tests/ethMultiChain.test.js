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
const EthWalletService = require('../src/services/EthWalletService');
const EtherscanService = require('../src/services/EtherscanService');
const EthWallet = require('../src/models/EthWallet');
const EthWalletChain = require('../src/models/EthWalletChain');
const EthTransfer = require('../src/models/EthTransfer');
const SecretsService = require('../src/services/SecretsService');
const MirrorService = require('../src/services/EthTransactionMirrorService');
const TransactionClassificationService = require('../src/services/TransactionClassificationService');
const { collapseDuplicateKeys } = require('../src/services/SnapshotService');

const sqlOf = (query) => query.text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const WALLET = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
const MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '039_multichain_wallets.sql'), 'utf8'
);

// Shared harness: stubs everything a sync touches except the parts under test,
// and records the (chain, feed) calls the sync actually made.
function harness(t, { chainSet, cursors = {}, feedBehavior = {} } = {}) {
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

  const calls = { fetches: [], deletes: [], cursors: [], unsupported: [], chainErrors: [], cleared: [], inserted: [] };

  stub(EthWallet, 'findById', async () => ({ id: 7, user_id: 1, address: WALLET }));
  stub(SecretsService, 'getUserKey', async () => 'key');
  stub(EthWalletChain, 'ensure', async (walletId, chainId) => ({
    wallet_id: walletId,
    chain_id: chainId,
    last_block_normal: 0, last_block_internal: 0, last_block_token: 0,
    last_block_nft: 0, last_block_1155: 0,
    ...(cursors[chainId] || {}),
  }));

  const feeds = {
    fetchNormalTxs: 'normal',
    fetchInternalTxs: 'internal',
    fetchTokenTxs: 'token',
    fetchNftTxs: 'nft',
    fetch1155Txs: 'nft1155',
  };
  for (const [method, key] of Object.entries(feeds)) {
    stub(EtherscanService, method, async (address, startBlock, apiKey, chainId) => {
      calls.fetches.push({ feed: key, chainId, startBlock, address });
      const behavior = feedBehavior[`${chainId}:${key}`];
      if (typeof behavior === 'function') return behavior();
      return behavior || [];
    });
  }

  stub(EthTransfer, 'deleteFromBlock', async (walletId, chainId, types, block) => {
    calls.deletes.push({ chainId, types: types.join(','), block });
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

test('Gnosis uses a keyless Blockscout account API while zkSync Era remains absent', () => {
  // /v2/chainlist returned 64 chains and none of them was 324 (or any zkSync
  // entry); every request against it answers "Missing or unsupported chainid
  // parameter". A disabled entry would advertise "you may turn this on", so it
  // must not appear at all. Linea took its slot as the ETH-native L2.
  const ids = chains.allChains().map((chain) => chain.id);
  assert.ok(!ids.includes(324), 'chain 324 is not served and must not be in the registry');
  assert.ok(ids.includes(59144), 'Linea replaces zkSync Era as the fifth chain');
  assert.deepEqual(ids.sort((a, b) => a - b), [1, 10, 100, 137, 8453, 42161, 59144]);
  const gnosis = chains.getChain(100);
  assert.equal(gnosis.nativeAsset, 'XDAI');
  assert.equal(gnosis.accountApi.provider, 'Blockscout');
  assert.equal(gnosis.accountApi.requiresApiKey, false);
  assert.equal(gnosis.enabledByDefault, true);
});

test('paid-plan-only chains ship present but disabled', () => {
  delete process.env.ETH_CHAINS;
  const byId = new Map(chains.allChains().map((chain) => [chain.id, chain]));
  // Both are in the chainlist, so they are real and one env var away -- but on
  // the probed (free) key every action including `balance` answers "Free API
  // access is not supported for this chain".
  for (const id of [10, 8453]) {
    assert.equal(byId.get(id).enabled, false, `chain ${id} must default to off`);
    assert.match(byId.get(id).disabledReason, /paid/i);
  }
  // Etherscan full-feed chains default on after live probes. Gnosis also
  // defaults on through its keyless provider; any explicitly partial
  // Blockscout internal range becomes a visible per-feed gap.
  for (const id of [1, 100, 137, 42161, 59144]) {
    assert.equal(byId.get(id).enabled, true, `chain ${id} passed every feed probe and defaults on`);
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
  // The three ETH-native chains still share one series and one price_cache row.
  for (const id of [1, 42161, 59144]) {
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

test('mainnet holding names are byte-identical to their pre-#58 values', () => {
  // Holdings are matched by NAME. Renaming mainnet's rows would strand every
  // existing user's ETH holding and insert a duplicate beside it.
  assert.equal(chains.ethHoldingName(1), 'Ethereum');
  assert.equal(chains.holdingSuffix(1), '');
  assert.equal(chains.ethHoldingName(42161), 'ETH (Arbitrum)');
  assert.equal(chains.holdingSuffix(8453), ' (Base)');
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
  assert.equal(arb.normal, 6000, 'its neighbours on the same chain still advance');
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
    'an unreadable chain must cost one request, not five'
  );
  assert.deepEqual(calls.unsupported.find((u) => u.chainId === 8453).list,
    ['normal', 'internal', 'token', 'nft', 'nft1155'],
    'the gap record still names every feed that went unfetched');
  const baseError = calls.chainErrors.find((e) => e.chainId === 8453);
  assert.equal(baseError.code, 'CHAIN_UNAVAILABLE');
  // Actionable: the two things that actually fix it.
  assert.match(baseError.message, /Upgrade the plan or remove 8453 from ETH_CHAINS/);
  assert.ok(calls.cleared.includes(1), 'mainnet still syncs and reports clean');
  assert.deepEqual(result.unsupportedFeeds.filter((f) => f.startsWith('Base')).length, 5);
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
  assert.equal(calls.cursors.find((c) => c.chainId === 1).normal, 2000);
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
  // OP Mainnet / Base on a free key, the second from zkSync Era's absent id.
  for (const result of [
    'Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage. https://etherscan.io/apis',
    'Missing or unsupported chainid parameter (required for v2 api), please see https://api.etherscan.io/v2/chainlist for the list of supported chainids',
  ]) {
    axios.get = async () => ({ data: { status: '0', message: 'NOTOK', result } });
    await assert.rejects(
      () => EtherscanService.getEthBalance(WALLET, 'key', 8453),
      (err) => {
        // Separated from ETHERSCAN_API_ERROR because the two demand opposite
        // handling: retry-next-sync vs record-a-standing-gap.
        assert.equal(err.code, 'ETHERSCAN_CHAIN_UNAVAILABLE');
        assert.equal(err.chainId, 8453);
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

  // A genuine transient error keeps its own code.
  axios.get = async () => ({ data: { status: '0', message: 'NOTOK', result: 'Something went wrong' } });
  await assert.rejects(
    () => EtherscanService.getEthBalance(WALLET, 'key', 1),
    (err) => err.code === 'ETHERSCAN_API_ERROR'
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
    return { data: { status: '1', result: '42' } };
  };
  t.after(() => { axios.get = original; });

  await EtherscanService.getEthBalance(WALLET, null, 100);

  assert.equal(seen[0].url, 'https://gnosis.blockscout.com/api');
  assert.equal(seen[0].params.chainid, undefined);
  assert.equal(seen[0].params.apikey, undefined);
  assert.equal(seen[0].params.action, 'balance');
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
