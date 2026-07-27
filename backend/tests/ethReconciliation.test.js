'use strict';

// On-chain balance reconciliation (#62). Sync starts every feed at block 0, so
// the stored ledger is genesis-complete and the balance derived from it should
// equal the one the chain reports. These tests are about the three things that
// make that claim worth making:
//
//   * the derivation is exact and counts the right legs (gas as its own term,
//     failed transfers excluded but their gas kept, NFT unit-counts nowhere
//     near a wei total)
//   * a mismatch is reported, never corrected, and a nonzero ETH delta is a
//     hard signal with no tolerance band under it
//   * an incomplete picture is SKIPPED rather than compared -- a missing feed
//     would otherwise manufacture drift that means nothing

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const queries = [];
// Per-test SQL responder: returns undefined to fall through to the empty
// default, so a test only programs the queries it actually cares about.
const responder = { fn: null };

const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      async query(text, params) {
        queries.push({ text, params });
        const answer = responder.fn && responder.fn(text, params);
        return answer || { rows: [], rowCount: 0 };
      }
      connect() { throw new Error('Unexpected connect'); }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const EthReconciliationService = require('../src/services/EthReconciliationService');
const EthReconciliation = require('../src/models/EthReconciliation');
const EthTransfer = require('../src/models/EthTransfer');
const EthWalletChain = require('../src/models/EthWalletChain');
const EtherscanService = require('../src/services/EtherscanService');
const EthWalletService = require('../src/services/EthWalletService');
const EthWallet = require('../src/models/EthWallet');
const SecretsService = require('../src/services/SecretsService');
const MirrorService = require('../src/services/EthTransactionMirrorService');
const EthActivityService = require('../src/services/EthActivityService');
const MethodSignatureService = require('../src/services/MethodSignatureService');
const TransactionClassificationService = require('../src/services/TransactionClassificationService');

const WALLET = { id: 7, user_id: 1, address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045' };
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f';
const ONE_ETH = 1000000000000000000n;

const sqlOf = (query) => query.text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '042_balance_reconciliation.sql'), 'utf8'
);
// The executable half. The file's comments discuss the types it deliberately
// does NOT use, so a naive scan of the whole text reads its own warnings as
// violations.
const MIGRATION_SQL = MIGRATION.replace(/--[^\n]*/g, '');

// Stub harness. Replaces every model call reconcileWallet makes so the tests
// are about the judgement, not about SQL plumbing (the derivation SQL has its
// own assertions further down).
// `persistChecked` makes the upsert/lastCheckedByAsset stubs keep a store that
// reproduces what the upsert SQL actually writes -- checked_at advances only for a COMPARED
// status, and a skip keeps the previous value. That is the only way a test can
// see the rotation as the next sync will see it; hand-feeding lastChecked
// asserts the sort and nothing about what feeds it.
function harness(t, {
  chainSet = '1',
  native = {},
  tokens = [],
  liveWei = {},
  liveTokens = {},
  lastChecked = new Map(),
  persistChecked = false,
} = {}) {
  const restore = [];
  const stub = (obj, key, fn) => { restore.push([obj, key, obj[key]]); obj[key] = fn; };
  const priorChains = process.env.ETH_CHAINS;
  process.env.ETH_CHAINS = chainSet;
  t.after(() => {
    for (const [o, k, v] of restore.reverse()) o[k] = v;
    if (priorChains === undefined) delete process.env.ETH_CHAINS;
    else process.env.ETH_CHAINS = priorChains;
    responder.fn = null;
    queries.length = 0;
  });

  const calls = { stored: [], pruned: [], tokenLookups: [] };

  stub(EthTransfer, 'nativeBalanceDeltas', async () =>
    Object.entries(native).map(([chainId, wei]) => ({ chain_id: Number(chainId), balance_wei: wei })));
  stub(EthTransfer, 'tokenBalanceDeltas', async () => tokens);
  // Stored verdicts, keyed like the real table. Only used when persistChecked
  // is on; `clock` stands in for CURRENT_TIMESTAMP and, exactly like the real
  // one, advances between the per-asset statements.
  const store = new Map(lastChecked);
  let clock = 0;
  const COMPARED = new Set(['match', 'dust', 'mismatch', 'unavailable']);

  stub(EthReconciliation, 'lastCheckedByAsset', async () =>
    (persistChecked ? new Map(store) : lastChecked));
  stub(EthReconciliation, 'upsert', async (walletId, row) => {
    calls.stored.push(row);
    if (persistChecked) {
      const key = `${row.chain_id}:${row.asset_key}`;
      clock += 1;
      const prior = store.get(key);
      store.set(key, {
        checkedAt: COMPARED.has(row.status) ? new Date(clock * 1000) : (prior?.checkedAt ?? null),
        status: row.status,
      });
    }
    return row;
  });
  stub(EthReconciliation, 'pruneMissing', async (walletId, chainIds, keys) => {
    calls.pruned.push({ chainIds, keys });
    return 0;
  });
  stub(EtherscanService, 'getTokenBalance', async (address, contract, apiKey, chainId) => {
    calls.tokenLookups.push({ contract, chainId });
    const answer = liveTokens[`${chainId}:${contract}`];
    if (typeof answer === 'function') return answer();
    if (answer === undefined) throw new Error(`no stub for ${chainId}:${contract}`);
    return answer;
  });
  stub(EthWalletChain, 'findForWallet', async () => []);

  return { calls, stub, liveWei };
}

const rowFor = (calls, chainId, assetKey) =>
  calls.stored.find((row) => row.chain_id === chainId && row.asset_key === assetKey);

// ---------------------------------------------------------------------------
// The derivation itself
// ---------------------------------------------------------------------------

test('the native derivation counts gas as its own term, never through the inbound arm', async () => {
  queries.length = 0;
  await EthTransfer.nativeBalanceDeltas(7);
  const sql = sqlOf(queries.at(-1));

  // A gas row's from_address is always the wallet and its to_address is the
  // contract called -- so on a SELF-SEND (from = to = wallet) an inbound arm
  // that accepted gas rows would ADD the fee back, crediting the wallet one
  // transaction fee for every transfer it made to itself.
  assert.match(sql, /SUM\(CASE WHEN t\.transfer_type = 'gas' THEN t\.value_wei ELSE 0 END\)/);
  // The inbound/outbound arms name only the two value-bearing native types.
  assert.match(sql, /t\.transfer_type IN \('native', 'internal'\)[\s\S]*t\.to_address = w\.address/);
  assert.match(sql, /t\.transfer_type IN \('native', 'internal'\)[\s\S]*t\.from_address = w\.address/);
});

test('failed transfers are excluded from value but their gas leg still counts', async () => {
  queries.length = 0;
  await EthTransfer.nativeBalanceDeltas(7);
  const sql = sqlOf(queries.at(-1));

  // A reverted transaction moved no ETH but still burned the fee, which is
  // exactly why gas legs are written is_error = FALSE (038). Both value arms
  // carry the is_error test; the gas term deliberately does not.
  const valueArms = sql.match(/t\.is_error = FALSE/g) || [];
  assert.equal(valueArms.length, 2, 'is_error filters the two value arms and nothing else');
  assert.doesNotMatch(sql, /transfer_type = 'gas' AND t\.is_error/);
});

test('NFT legs can never reach the wei total: their value_wei is a unit count', async () => {
  queries.length = 0;
  await EthTransfer.nativeBalanceDeltas(7);
  const sql = sqlOf(queries.at(-1));

  // 033: an erc721 row's value_wei is 1 (one token), a 1155 row's is the batch
  // count. Summed into a wei balance they are noise with no upper bound.
  assert.doesNotMatch(sql, /nft/i);
  assert.match(sql, /t\.transfer_type IN \('native', 'internal', 'gas'\)/);
});

test('the derivation is exact NUMERIC end to end, cast to text rather than a float', async () => {
  queries.length = 0;
  await EthTransfer.nativeBalanceDeltas(7);
  const sql = sqlOf(queries.at(-1));

  // A uint256 total is past Number precision, and float8 would round away
  // exactly the small drift this audit exists to surface.
  assert.match(sql, /\)::text AS balance_wei/);
  assert.doesNotMatch(sql, /float8|::float|::double/i);
});

test('the derivation groups per chain, because block numbers and feeds are per chain', async () => {
  queries.length = 0;
  await EthTransfer.nativeBalanceDeltas(7);
  const sql = sqlOf(queries.at(-1));
  assert.match(sql, /GROUP BY t\.chain_id/);
});

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

test('ETH gets no tolerance band: one wei of drift is a mismatch', () => {
  const verdict = EthReconciliationService.classify({
    assetType: 'native', derived: ONE_ETH + 1n, live: ONE_ETH, decimals: 18,
  });
  // The issue is explicit: a nonzero ETH delta means a movement was missed --
  // a blob fee, a self-destruct credit, a validator payout, an unsynced feed.
  // Every one of those is real, so there is nothing here to round away.
  assert.equal(verdict.status, 'mismatch');
  assert.equal(verdict.delta, 1n);
});

test('an exact agreement is a match, and the delta is zero rather than absent', () => {
  const verdict = EthReconciliationService.classify({
    assetType: 'native', derived: ONE_ETH, live: ONE_ETH, decimals: 18,
  });
  assert.equal(verdict.status, 'match');
  assert.equal(verdict.delta, 0n);
});

test('a token drifting below the display threshold is dust, not an alarm', () => {
  // 1 wei of an 18-decimal token: 1e-18 of a unit, far under the 1e-8 floor.
  const absolute = EthReconciliationService.classify({
    assetType: 'token', derived: ONE_ETH + 1n, live: ONE_ETH, decimals: 18,
  });
  assert.equal(absolute.status, 'dust');

  // ...and 1e-7 of the position, under the one-part-per-million relative test.
  const relative = EthReconciliationService.classify({
    assetType: 'token', derived: ONE_ETH + 100000000000n, live: ONE_ETH, decimals: 18,
  });
  assert.equal(relative.status, 'dust');
});

test('a token drifting past both tolerances is a mismatch that names the contract', () => {
  // 1e-5 of the position and 1e-5 of a unit: past the relative test and past
  // the absolute floor.
  const verdict = EthReconciliationService.classify({
    assetType: 'token', derived: ONE_ETH + 10000000000000n, live: ONE_ETH, decimals: 18,
  });
  assert.equal(verdict.status, 'mismatch');
});

test('a zero-decimal token has no dust band: its smallest unit is a whole token', () => {
  const verdict = EthReconciliationService.classify({
    assetType: 'token', derived: 5n, live: 4n, decimals: 0,
  });
  assert.equal(verdict.status, 'mismatch');
});

test('an unreadable live balance is unavailable, never a mismatch against zero', () => {
  // Reporting the whole position as missing because a request failed is the
  // fastest way to teach the user to ignore this feature.
  const verdict = EthReconciliationService.classify({
    assetType: 'native', derived: ONE_ETH, live: null, decimals: 18,
  });
  assert.equal(verdict.status, 'unavailable');
  assert.equal(verdict.delta, null);
  assert.equal(verdict.skipReason, EthReconciliationService.SKIP_REASONS.LIVE_FETCH_FAILED);
});

// ---------------------------------------------------------------------------
// Skip while the picture is incomplete
// ---------------------------------------------------------------------------

test('a chain whose ingest threw is skipped, and its neighbours are not', () => {
  process.env.ETH_CHAINS = '1,42161';
  const gates = EthReconciliationService.chainGates([
    { chainId: 1, unavailable: false, skippedFeeds: [], unsupportedFeeds: [] },
    { chainId: 42161, error: 'boom', errorCode: 'SYNC_ERROR', skippedFeeds: [], unsupportedFeeds: [] },
  ], null);
  delete process.env.ETH_CHAINS;

  assert.equal(gates.get(1).skip, null);
  assert.equal(gates.get(42161).skip, EthReconciliationService.SKIP_REASONS.CHAIN_ERROR);
});

test('a chain the key cannot serve at all is skipped rather than compared to nothing', () => {
  process.env.ETH_CHAINS = '1';
  const gates = EthReconciliationService.chainGates([
    { chainId: 1, unavailable: true, skippedFeeds: [], unsupportedFeeds: ['normal', 'internal', 'token', 'nft', 'nft1155'] },
  ], null);
  delete process.env.ETH_CHAINS;
  assert.equal(gates.get(1).skip, EthReconciliationService.SKIP_REASONS.CHAIN_UNAVAILABLE);
});

test('a missing internal feed blocks the ETH audit but not the token audit', () => {
  process.env.ETH_CHAINS = '1';
  const gates = EthReconciliationService.chainGates([
    { chainId: 1, unavailable: false, skippedFeeds: [], unsupportedFeeds: ['internal'] },
  ], null);
  delete process.env.ETH_CHAINS;
  const gate = gates.get(1);

  // ETH arriving from a contract is visible ONLY in internal traces, so a chain
  // without them genuinely cannot reproduce its own ETH balance. ERC-20 rows
  // come from the token feed and are unaffected -- skipping them too would
  // throw away a good audit to describe a hole somewhere else.
  assert.equal(EthReconciliationService.feedGap(gate, 'native'), true);
  assert.equal(EthReconciliationService.feedGap(gate, 'token'), false);
});

test('a transiently skipped feed is as much of a hole as a permanently missing one', () => {
  process.env.ETH_CHAINS = '1';
  const gates = EthReconciliationService.chainGates([
    { chainId: 1, unavailable: false, skippedFeeds: ['token'], unsupportedFeeds: [] },
  ], null);
  delete process.env.ETH_CHAINS;
  // Its rows were never fetched and its cursor did not move, so the ledger is
  // incomplete rather than merely stale -- exactly the unsupported case.
  assert.equal(EthReconciliationService.feedGap(gates.get(1), 'token'), true);
});

test('the stored-state fallback skips a chain on ANY error code, not just an unavailable one', () => {
  // eth_wallet_chains collapses the run's per-feed detail into one error_code,
  // so the fallback cannot tell how big the hole is -- only that there is one.
  // Ignoring codes it does not recognise would let a caller without
  // chainResults compare an incomplete ledger and report phantom drift.
  process.env.ETH_CHAINS = '1,42161';
  for (const code of ['FEED_SKIPPED', 'SYNC_ERROR', 'CHAIN_SYNC_FAILED', 'ETHERSCAN_NOT_CONFIGURED']) {
    const gates = EthReconciliationService.chainGates(null, [
      { chain_id: 1, last_synced_at: new Date(), error_code: code, unsupported_feeds: [] },
      { chain_id: 42161, last_synced_at: new Date(), error_code: null, unsupported_feeds: [] },
    ]);
    assert.equal(gates.get(1).skip, EthReconciliationService.SKIP_REASONS.CHAIN_ERROR, code);
    assert.equal(gates.get(42161).skip, null, code);
  }
  const unavailable = EthReconciliationService.chainGates(null, [
    { chain_id: 1, last_synced_at: new Date(), error_code: 'CHAIN_UNAVAILABLE', unsupported_feeds: [] },
  ]);
  assert.equal(unavailable.get(1).skip, EthReconciliationService.SKIP_REASONS.CHAIN_UNAVAILABLE);
  delete process.env.ETH_CHAINS;
});

test('a chain that has never synced is skipped: there is no ledger to audit yet', () => {
  process.env.ETH_CHAINS = '1,42161';
  const gates = EthReconciliationService.chainGates(null, [
    { chain_id: 1, last_synced_at: new Date(), unsupported_feeds: [] },
    { chain_id: 42161, last_synced_at: null, unsupported_feeds: [] },
  ]);
  delete process.env.ETH_CHAINS;
  assert.equal(gates.get(1).skip, null);
  assert.equal(gates.get(42161).skip, EthReconciliationService.SKIP_REASONS.NEVER_SYNCED);
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

test('a fully explained wallet reports delta 0 for ETH and for each token', async (t) => {
  const { calls } = harness(t, {
    native: { 1: ONE_ETH.toString() },
    tokens: [
      { chain_id: 1, token_contract: USDC, token_symbol: 'USDC', token_decimals: 6, balance_units: '250000000' },
      { chain_id: 1, token_contract: DAI, token_symbol: 'DAI', token_decimals: 18, balance_units: ONE_ETH.toString() },
    ],
    liveTokens: { [`1:${USDC}`]: '250000000', [`1:${DAI}`]: ONE_ETH.toString() },
  });

  const summary = await EthReconciliationService.reconcileWallet(WALLET, {
    liveWeiByChain: { 1: ONE_ETH.toString() },
    chainResults: [{ chainId: 1, unavailable: false, skippedFeeds: [], unsupportedFeeds: [] }],
    apiKey: 'key',
  });

  assert.equal(summary.mismatches, 0);
  assert.equal(summary.matched, 3);
  assert.equal(rowFor(calls, 1, 'ETH').status, 'match');
  assert.equal(rowFor(calls, 1, 'ETH').delta_units, '0');
  assert.equal(rowFor(calls, 1, USDC).status, 'match');
  assert.equal(rowFor(calls, 1, DAI).status, 'match');
});

test('a non-ether chain audits under its OWN native key, not ETH', async (t) => {
  // eth_reconciliation is keyed (wallet, chain, asset_key), so a Polygon row
  // keyed 'ETH' would not collide with mainnet's -- it would just label POL as
  // ether everywhere the audit is read, and the ledger's native-drift banner
  // would report the wrong asset for a real missing transfer.
  const { calls } = harness(t, {
    chainSet: '137',
    native: { 137: ONE_ETH.toString() },
  });

  await EthReconciliationService.reconcileWallet(WALLET, {
    liveWeiByChain: { 137: ONE_ETH.toString() },
    chainResults: [{ chainId: 137, unavailable: false, skippedFeeds: [], unsupportedFeeds: [] }],
    apiKey: 'key',
  });

  const row = rowFor(calls, 137, 'POL');
  assert.ok(row, 'the Polygon native row must be keyed POL');
  assert.equal(row.asset_type, 'native');
  assert.equal(row.token_symbol, 'POL');
  assert.equal(rowFor(calls, 137, 'ETH'), undefined, 'nothing may be keyed ETH on Polygon');
});

test('a synthetic missing transfer produces a nonzero delta and a wallet-level flag', async (t) => {
  // The ledger is short one 1 ETH deposit: the chain says 3 ETH, the stored
  // transfers only add up to 2.
  const { calls } = harness(t, {
    native: { 1: (2n * ONE_ETH).toString() },
  });

  const summary = await EthReconciliationService.reconcileWallet(WALLET, {
    liveWeiByChain: { 1: (3n * ONE_ETH).toString() },
    chainResults: [{ chainId: 1, unavailable: false, skippedFeeds: [], unsupportedFeeds: [] }],
    apiKey: 'key',
  });

  const row = rowFor(calls, 1, 'ETH');
  assert.equal(row.status, 'mismatch');
  assert.equal(row.derived_units, (2n * ONE_ETH).toString());
  assert.equal(row.live_units, (3n * ONE_ETH).toString());
  assert.equal(row.delta_units, (-ONE_ETH).toString());
  // native_mismatches is what the wallet card badges on; a token delta alone
  // must not raise it.
  assert.equal(summary.nativeMismatches, 1);

  // Reported, never corrected. Nothing in the audit path writes a holding: the
  // derived number is the thing under test, and overwriting it with the live
  // one would hide the very bug this exists to find.
  assert.ok(calls.stored.every((stored) => stored.status !== undefined));
});

test('a token mismatch names the offending contract rather than a bare number', async (t) => {
  const { calls } = harness(t, {
    native: { 1: ONE_ETH.toString() },
    tokens: [{ chain_id: 1, token_contract: DAI, token_symbol: 'DAI', token_decimals: 18, balance_units: (2n * ONE_ETH).toString() }],
    liveTokens: { [`1:${DAI}`]: ONE_ETH.toString() },
  });

  await EthReconciliationService.reconcileWallet(WALLET, {
    liveWeiByChain: { 1: ONE_ETH.toString() },
    chainResults: [{ chainId: 1, unavailable: false, skippedFeeds: [], unsupportedFeeds: [] }],
    apiKey: 'key',
  });

  const row = rowFor(calls, 1, DAI);
  assert.equal(row.status, 'mismatch');
  assert.equal(row.asset_key, DAI);
  assert.equal(row.token_symbol, 'DAI');
  // Decimals ride along so the UI can scale the delta without going back to
  // the transfer rows to find out what a unit means.
  assert.equal(row.token_decimals, 18);
});

test('a negative derived token balance is audited, not dropped', async (t) => {
  // holdings drop these (a position cannot be negative), but a ledger claiming
  // the wallet sent more than it ever received is the loudest possible evidence
  // of a missed inbound transfer.
  const { calls } = harness(t, {
    native: { 1: '0' },
    tokens: [{ chain_id: 1, token_contract: USDC, token_symbol: 'USDC', token_decimals: 6, balance_units: '-1000000' }],
    liveTokens: { [`1:${USDC}`]: '0' },
  });

  await EthReconciliationService.reconcileWallet(WALLET, {
    liveWeiByChain: { 1: '0' },
    chainResults: [{ chainId: 1, unavailable: false, skippedFeeds: [], unsupportedFeeds: [] }],
    apiKey: 'key',
  });

  const row = rowFor(calls, 1, USDC);
  assert.equal(row.status, 'mismatch');
  assert.equal(row.delta_units, '-1000000');
});

test('an incomplete chain is skipped without spending a live lookup on it', async (t) => {
  const { calls } = harness(t, {
    native: { 1: ONE_ETH.toString() },
    tokens: [{ chain_id: 1, token_contract: USDC, token_symbol: 'USDC', token_decimals: 6, balance_units: '250000000' }],
  });

  const summary = await EthReconciliationService.reconcileWallet(WALLET, {
    liveWeiByChain: { 1: ONE_ETH.toString() },
    chainResults: [{ chainId: 1, unavailable: false, skippedFeeds: [], unsupportedFeeds: ['internal', 'token'] }],
    apiKey: 'key',
  });

  const eth = rowFor(calls, 1, 'ETH');
  assert.equal(eth.status, 'skipped');
  assert.equal(eth.skip_reason, EthReconciliationService.SKIP_REASONS.FEED_GAP);
  // The live figure is cleared rather than stored beside an incomplete derived
  // one: a stale pair invites exactly the comparison the skip refuses to make.
  assert.equal(eth.live_units, null);
  assert.equal(eth.delta_units, null);
  assert.equal(rowFor(calls, 1, USDC).status, 'skipped');
  // Nothing was asked of Etherscan for a chain whose answer could not be used.
  assert.equal(calls.tokenLookups.length, 0);
  assert.equal(summary.mismatches, 0);
  assert.equal(summary.skipped, 2);
});

test('one unreadable token poisons neither its neighbours nor the audit', async (t) => {
  const { calls } = harness(t, {
    native: { 1: ONE_ETH.toString() },
    tokens: [
      { chain_id: 1, token_contract: USDC, token_symbol: 'USDC', token_decimals: 6, balance_units: '250000000' },
      { chain_id: 1, token_contract: DAI, token_symbol: 'DAI', token_decimals: 18, balance_units: ONE_ETH.toString() },
    ],
    liveTokens: {
      [`1:${USDC}`]: () => { throw new Error('Etherscan says no'); },
      [`1:${DAI}`]: ONE_ETH.toString(),
    },
  });

  const summary = await EthReconciliationService.reconcileWallet(WALLET, {
    liveWeiByChain: { 1: ONE_ETH.toString() },
    chainResults: [{ chainId: 1, unavailable: false, skippedFeeds: [], unsupportedFeeds: [] }],
    apiKey: 'key',
  });

  assert.equal(rowFor(calls, 1, USDC).status, 'unavailable');
  assert.equal(rowFor(calls, 1, DAI).status, 'match');
  assert.equal(rowFor(calls, 1, 'ETH').status, 'match');
  assert.equal(summary.unavailable, 1);
});

test('token lookups are budgeted and the deferred ones say so', async (t) => {
  const budget = EthReconciliationService.MAX_TOKEN_LOOKUPS;
  const contracts = Array.from({ length: budget + 3 }, (_, i) =>
    `0x${String(i).padStart(40, '0')}`);
  const liveTokens = Object.fromEntries(contracts.map((c) => [`1:${c}`, '1']));
  const { calls } = harness(t, {
    native: { 1: '0' },
    tokens: contracts.map((contract) => ({
      chain_id: 1, token_contract: contract, token_symbol: 'SPAM', token_decimals: 0, balance_units: '1',
    })),
    liveTokens,
  });

  const summary = await EthReconciliationService.reconcileWallet(WALLET, {
    liveWeiByChain: { 1: '0' },
    chainResults: [{ chainId: 1, unavailable: false, skippedFeeds: [], unsupportedFeeds: [] }],
    apiKey: 'key',
  });

  // The Etherscan throttle is global across users AND chains, so an unbounded
  // per-token walk would monopolise it for every other sync on the box.
  assert.equal(calls.tokenLookups.length, budget);
  assert.equal(summary.deferred, 3);
  // Written down, not silently dropped: a truncated audit that says nothing
  // reads as "everything checks out".
  const deferred = calls.stored.filter((row) => row.skip_reason === EthReconciliationService.SKIP_REASONS.LOOKUP_BUDGET);
  assert.equal(deferred.length, 3);
});

test('the lookup budget rotates least-recently-checked first, so nothing starves', async (t) => {
  const older = new Date('2026-01-01T00:00:00Z');
  const newer = new Date('2026-07-01T00:00:00Z');
  const { calls } = harness(t, {
    native: { 1: '0' },
    tokens: [
      { chain_id: 1, token_contract: DAI, token_symbol: 'DAI', token_decimals: 18, balance_units: '1' },
      { chain_id: 1, token_contract: USDC, token_symbol: 'USDC', token_decimals: 6, balance_units: '1' },
    ],
    liveTokens: { [`1:${USDC}`]: '1', [`1:${DAI}`]: '1' },
    lastChecked: new Map([
      [`1:${DAI}`, { checkedAt: newer, status: 'match' }],
      [`1:${USDC}`, { checkedAt: older, status: 'match' }],
    ]),
  });

  await EthReconciliationService.reconcileWallet(WALLET, {
    liveWeiByChain: { 1: '0' },
    chainResults: [{ chainId: 1, unavailable: false, skippedFeeds: [], unsupportedFeeds: [] }],
    apiKey: 'key',
  });

  // Without this a wallet holding more tokens than the budget would re-check
  // the same head of the list nightly and never reach the tail at all.
  assert.deepEqual(calls.tokenLookups.map((call) => call.contract), [USDC, DAI]);
});

test('the deferred tail is checked on the NEXT run, using the timestamps the first run wrote', async (t) => {
  // The rotation's real test. Feeding lastChecked by hand only asserts the
  // sort; this asserts the thing the sort depends on -- that a row written
  // BECAUSE it was skipped does not come away with a fresher checked_at than
  // the assets that were actually compared. Each upsert is its own statement,
  // so a blanket CURRENT_TIMESTAMP hands the deferred tail the LATEST stamps of
  // the run and it sorts last again, every night, forever.
  const budget = EthReconciliationService.MAX_TOKEN_LOOKUPS;
  const contracts = Array.from({ length: budget + 3 }, (_, i) =>
    `0x${String(i).padStart(40, '0')}`);
  const { calls } = harness(t, {
    persistChecked: true,
    native: { 1: '0' },
    tokens: contracts.map((contract) => ({
      chain_id: 1, token_contract: contract, token_symbol: 'SPAM', token_decimals: 0, balance_units: '1',
    })),
    liveTokens: Object.fromEntries(contracts.map((c) => [`1:${c}`, '1'])),
  });

  const options = {
    liveWeiByChain: { 1: '0' },
    chainResults: [{ chainId: 1, unavailable: false, skippedFeeds: [], unsupportedFeeds: [] }],
    apiKey: 'key',
  };
  await EthReconciliationService.reconcileWallet(WALLET, options);
  const firstRun = calls.tokenLookups.map((call) => call.contract);
  calls.tokenLookups.length = 0;
  await EthReconciliationService.reconcileWallet(WALLET, options);
  const secondRun = calls.tokenLookups.map((call) => call.contract);

  assert.equal(firstRun.length, budget);
  const deferred = contracts.filter((contract) => !firstRun.includes(contract));
  assert.equal(deferred.length, 3);
  // The three the budget could not reach lead the next run, ahead of every
  // token that was already compared.
  assert.deepEqual(secondRun.slice(0, 3), deferred);
});

test('a token whose derived balance nets to zero keeps its unresolved verdict', async (t) => {
  // "Derived zero" is a claim by the LEDGER, which is the thing under test.
  // Dropping the row on that claim lets pruneMissing delete last night's
  // mismatch precisely when the chain may still hold the token.
  const { calls } = harness(t, {
    native: { 1: '0' },
    tokens: [
      { chain_id: 1, token_contract: DAI, token_symbol: 'DAI', token_decimals: 18, balance_units: '0' },
      { chain_id: 1, token_contract: USDC, token_symbol: 'USDC', token_decimals: 6, balance_units: '0' },
    ],
    liveTokens: { [`1:${DAI}`]: ONE_ETH.toString(), [`1:${USDC}`]: '0' },
    lastChecked: new Map([
      [`1:${DAI}`, { checkedAt: new Date('2026-01-01T00:00:00Z'), status: 'mismatch' }],
      // Already compared at zero and the chain agreed: sold off, so it retires.
      [`1:${USDC}`, { checkedAt: new Date('2026-01-01T00:00:00Z'), status: 'match' }],
    ]),
  });

  await EthReconciliationService.reconcileWallet(WALLET, {
    liveWeiByChain: { 1: '0' },
    chainResults: [{ chainId: 1, unavailable: false, skippedFeeds: [], unsupportedFeeds: [] }],
    apiKey: 'key',
  });

  assert.equal(rowFor(calls, 1, DAI).status, 'mismatch');
  assert.equal(rowFor(calls, 1, USDC), undefined);
  assert.deepEqual(calls.pruned[0].keys, ['1:ETH', `1:${DAI}`]);
});

test('a chain whose live balance never arrived spends no token lookups on it', async (t) => {
  const { calls } = harness(t, {
    chainSet: '1,42161',
    native: { 1: '0', 42161: '0' },
    tokens: [
      { chain_id: 42161, token_contract: DAI, token_symbol: 'DAI', token_decimals: 18, balance_units: '1' },
      { chain_id: 1, token_contract: USDC, token_symbol: 'USDC', token_decimals: 6, balance_units: '1' },
    ],
    liveTokens: { [`1:${USDC}`]: '1' },
  });

  await EthReconciliationService.reconcileWallet(WALLET, {
    // Arbitrum's balance call failed in refreshHoldings, so it has no entry.
    liveWeiByChain: { 1: '0' },
    chainResults: [
      { chainId: 1, unavailable: false, skippedFeeds: [], unsupportedFeeds: [] },
      { chainId: 42161, unavailable: false, skippedFeeds: [], unsupportedFeeds: [] },
    ],
    apiKey: 'key',
  });

  // The key just proved it cannot reach Arbitrum; spending up to twenty
  // throttled tokenbalance calls there starves the chains that ARE readable.
  assert.deepEqual(calls.tokenLookups.map((call) => call.chainId), [1]);
  assert.equal(rowFor(calls, 42161, DAI).status, 'unavailable');
  assert.equal(rowFor(calls, 42161, DAI).skip_reason,
    EthReconciliationService.SKIP_REASONS.LIVE_FETCH_FAILED);
});

test('no Etherscan key is its own skip reason, not the lookup budget', async (t) => {
  const { calls } = harness(t, {
    native: { 1: '0' },
    tokens: [{ chain_id: 1, token_contract: DAI, token_symbol: 'DAI', token_decimals: 18, balance_units: '1' }],
  });

  const summary = await EthReconciliationService.reconcileWallet(WALLET, {
    liveWeiByChain: { 1: '0' },
    chainResults: [{ chainId: 1, unavailable: false, skippedFeeds: [], unsupportedFeeds: [] }],
    apiKey: null,
  });

  // 'lookup_budget' renders as "checked on a later sync", which is a promise no
  // later sync can keep while there is no key to check with.
  assert.equal(rowFor(calls, 1, DAI).skip_reason, EthReconciliationService.SKIP_REASONS.NO_API_KEY);
  assert.equal(summary.deferred, 0);
  assert.equal(calls.tokenLookups.length, 0);
});

test('cleanup is scoped to the chains the run actually walked', async (t) => {
  const { calls } = harness(t, {
    chainSet: '1',
    native: { 1: '0', 42161: '5' },
  });

  await EthReconciliationService.reconcileWallet(WALLET, {
    liveWeiByChain: { 1: '0' },
    chainResults: [{ chainId: 1, unavailable: false, skippedFeeds: [], unsupportedFeeds: [] }],
    apiKey: 'key',
  });

  // Arbitrum is switched off: its stored verdict must survive, exactly as its
  // holdings and its transfers do. Deleting it would make "this chain is off"
  // read as "this chain passed".
  assert.deepEqual(calls.pruned[0].chainIds, [1]);
  // Kept keys carry their chain. The same contract address is a different asset
  // on every chain, so a bare key list would let mainnet's row shield a stale
  // Arbitrum verdict for the same address from ever being cleaned up.
  assert.deepEqual(calls.pruned[0].keys, ['1:ETH']);
});

test('a chain with no transfers at all derives zero, which the chain agreeing on is a match', async (t) => {
  const { calls } = harness(t, { chainSet: '1,42161', native: { 1: ONE_ETH.toString() } });

  await EthReconciliationService.reconcileWallet(WALLET, {
    liveWeiByChain: { 1: ONE_ETH.toString(), 42161: '0' },
    chainResults: [
      { chainId: 1, unavailable: false, skippedFeeds: [], unsupportedFeeds: [] },
      { chainId: 42161, unavailable: false, skippedFeeds: [], unsupportedFeeds: [] },
    ],
    apiKey: 'key',
  });

  const arbitrum = rowFor(calls, 42161, 'ETH');
  assert.equal(arbitrum.derived_units, '0');
  assert.equal(arbitrum.status, 'match');
});

test('a chain whose live balance never arrived is unavailable, not drifting', async (t) => {
  // refreshHoldings keeps an L2's previous holdings when its balance call
  // fails; the audit must report that as "not checked", not as a wallet that
  // lost all its ETH.
  const { calls } = harness(t, { chainSet: '1,42161', native: { 1: '0', 42161: ONE_ETH.toString() } });

  await EthReconciliationService.reconcileWallet(WALLET, {
    liveWeiByChain: { 1: '0' },
    chainResults: [
      { chainId: 1, unavailable: false, skippedFeeds: [], unsupportedFeeds: [] },
      { chainId: 42161, unavailable: false, skippedFeeds: [], unsupportedFeeds: [] },
    ],
    apiKey: 'key',
  });

  const arbitrum = rowFor(calls, 42161, 'ETH');
  assert.equal(arbitrum.status, 'unavailable');
  assert.equal(arbitrum.live_units, null);
});

// ---------------------------------------------------------------------------
// The sync is never held hostage by its own audit
// ---------------------------------------------------------------------------

test('a failing audit leaves the sync itself successful', async (t) => {
  const restore = [];
  const stub = (obj, key, fn) => { restore.push([obj, key, obj[key]]); obj[key] = fn; };
  const priorChains = process.env.ETH_CHAINS;
  process.env.ETH_CHAINS = '1';
  t.after(() => {
    for (const [o, k, v] of restore.reverse()) o[k] = v;
    if (priorChains === undefined) delete process.env.ETH_CHAINS;
    else process.env.ETH_CHAINS = priorChains;
  });

  stub(EthWallet, 'findById', async () => WALLET);
  stub(SecretsService, 'getUserKey', async () => 'key');
  stub(EthWalletChain, 'ensure', async (walletId, chainId) => ({
    wallet_id: walletId, chain_id: chainId,
    last_block_normal: 0, last_block_internal: 0, last_block_token: 0,
    last_block_nft: 0, last_block_1155: 0,
  }));
  for (const method of ['fetchNormalTxs', 'fetchInternalTxs', 'fetchTokenTxs', 'fetchNftTxs', 'fetch1155Txs']) {
    stub(EtherscanService, method, async () => []);
  }
  stub(EthTransfer, 'deleteFromBlock', async () => {});
  stub(EthTransfer, 'bulkInsert', async () => 0);
  stub(EthTransfer, 'reclassifyCounterparties', async () => {});
  stub(EthWalletChain, 'updateCursors', async () => {});
  stub(EthWalletChain, 'setUnsupportedFeeds', async () => {});
  stub(EthWalletChain, 'setError', async () => {});
  stub(EthWalletChain, 'clearError', async () => {});
  stub(EthWalletChain, 'updateSyncTime', async () => {});
  stub(EthWalletService, 'refreshHoldings', async () => ({ liveWeiByChain: { 1: '0' } }));
  stub(MirrorService, 'rebuildForWallet', async () => ({}));
  stub(EthActivityService, 'rebuildForWallet', async () => ({}));
  stub(MethodSignatureService, 'decodePendingForWallet', async () => ({}));
  stub(TransactionClassificationService, 'backfill', async () => {});
  stub(EthWallet, 'clearError', async () => {});
  stub(EthWallet, 'updateSyncTime', async () => {});
  let walletError = null;
  stub(EthWallet, 'setError', async (id, code, message) => { walletError = { code, message }; });
  stub(EthReconciliationService, 'reconcileWallet', async () => { throw new Error('audit exploded'); });

  const result = await EthWalletService.syncWallet(WALLET.id);

  // The audit is a VERDICT ON the sync, not a step of it. Everything above it
  // already landed; failing the sync here would trade a real balance and a real
  // transfer history for an opinion about them.
  assert.equal(result.reconciliation, null);
  assert.equal(walletError, null, 'a failed audit must not badge the wallet as a sync error');
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test('the migration keys one verdict per (wallet, chain, asset) on a NOT NULL asset key', () => {
  // A nullable token_contract as the conflict target would never conflict, so
  // every sync would insert another native row for the same chain, forever.
  assert.match(MIGRATION, /asset_key VARCHAR\(42\) NOT NULL/);
  assert.match(MIGRATION, /UNIQUE \(wallet_id, chain_id, asset_key\)/);
});

test('the migration stores base units as exact NUMERIC, never a float', () => {
  for (const column of ['derived_units', 'live_units', 'delta_units']) {
    assert.match(MIGRATION_SQL, new RegExp(`${column} NUMERIC\\(78, 0\\)`));
  }
  assert.doesNotMatch(MIGRATION_SQL, /DOUBLE PRECISION|REAL|FLOAT/i);
});

test('the migration re-runs cleanly: every statement is idempotent or catalog-guarded', () => {
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS eth_reconciliation/);
  // Postgres has no ADD CONSTRAINT IF NOT EXISTS for CHECK, so both checks are
  // added under a pg_constraint guard -- a re-boot must neither fail nor
  // duplicate them.
  const guards = MIGRATION.match(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/g) || [];
  assert.equal(guards.length, 2);
  for (const index of MIGRATION.match(/CREATE INDEX[^;]*/g) || []) {
    assert.match(index, /IF NOT EXISTS/);
  }
});

test('the status vocabulary is enforced in the database, not just in the service', () => {
  assert.match(MIGRATION, /CHECK \(status IN \('match', 'dust', 'mismatch', 'skipped', 'unavailable'\)\)/);
  assert.match(MIGRATION, /CHECK \(asset_type IN \('native', 'token'\)\)/);
});

test('a stored verdict is fully replaced, live figure included, rather than half-updated', async () => {
  queries.length = 0;
  await EthReconciliation.upsert(7, {
    chain_id: 1, asset_key: 'ETH', asset_type: 'native',
    derived_units: '1', live_units: null, delta_units: null, status: 'unavailable',
  });
  const sql = sqlOf(queries.at(-1));

  // COALESCE here would leave last night's live number beside tonight's derived
  // one, and the pair would be compared by eye with the stale half reading as
  // current.
  assert.match(sql, /live_units = EXCLUDED\.live_units/);
  assert.doesNotMatch(sql, /live_units = COALESCE/);
  assert.match(sql, /ON CONFLICT \(wallet_id, chain_id, asset_key\) DO UPDATE/);
});

test('checked_at advances only when the asset was actually compared', async () => {
  queries.length = 0;
  await EthReconciliation.upsert(7, {
    chain_id: 1, asset_key: DAI, asset_type: 'token',
    derived_units: '1', live_units: null, delta_units: null,
    status: 'skipped', skip_reason: 'lookup_budget',
  });
  const sql = sqlOf(queries.at(-1));

  // A row written BECAUSE the budget deferred it must not come away looking
  // freshly checked: every upsert is its own statement, so the deferred tail
  // would carry the run's latest timestamps, sort last again next night, and be
  // audited never.
  assert.match(sql, /checked_at = CASE WHEN EXCLUDED\.status IN \('match', 'dust', 'mismatch', 'unavailable'\) THEN CURRENT_TIMESTAMP ELSE eth_reconciliation\.checked_at END/);
  assert.doesNotMatch(sql, /checked_at = CURRENT_TIMESTAMP/);
  // ...and the same rule on the INSERT arm, so a first-ever skip stores NULL --
  // the value the rotation reads as "never compared", which sorts first.
  assert.match(sql, /CASE WHEN \$10::text IN \('match', 'dust', 'mismatch', 'unavailable'\) THEN CURRENT_TIMESTAMP ELSE NULL END/);
});

test('the migration makes checked_at nullable, idempotently', () => {
  // NULL is the never-compared value the rotation depends on. The column
  // shipped NOT NULL DEFAULT CURRENT_TIMESTAMP, and this file re-runs on every
  // boot, so both ALTERs have to be no-ops the second time.
  assert.match(MIGRATION_SQL, /checked_at TIMESTAMP,/);
  assert.doesNotMatch(MIGRATION_SQL, /checked_at TIMESTAMP NOT NULL/);
  assert.match(MIGRATION_SQL, /ALTER TABLE eth_reconciliation ALTER COLUMN checked_at DROP NOT NULL;/);
  assert.match(MIGRATION_SQL, /ALTER TABLE eth_reconciliation ALTER COLUMN checked_at DROP DEFAULT;/);
});

test('the rotation reader carries the stored status, and the summary can be scoped to one wallet', async () => {
  queries.length = 0;
  await EthReconciliation.lastCheckedByAsset(7);
  // The candidate filter needs last run's verdict, not just its clock: a
  // derived-zero token only retires once the CHAIN agreed it was zero.
  assert.match(sqlOf(queries.at(-1)), /SELECT chain_id, asset_key, checked_at, status/);

  queries.length = 0;
  await EthReconciliation.summaryForUser(1, { walletId: 7 });
  // Headline counts describe the same scope as the rows under them; totalling
  // every wallet above a wallet-filtered feed reads as drift on the wallet on
  // screen.
  assert.match(sqlOf(queries.at(-1)), /w\.user_id = \$1 AND[\s\S]*r\.wallet_id = \$2/);
});

// ---------------------------------------------------------------------------
// Reads are user-scoped and fail closed
// ---------------------------------------------------------------------------

test('every read joins eth_wallets and filters on the owner', async () => {
  queries.length = 0;
  await EthReconciliation.findForUser(1, { walletId: 7 });
  await EthReconciliation.summaryForWallets(1, [7]);
  await EthReconciliation.openIssuesForWallets(1, [7]);
  await EthReconciliation.summaryForUser(1);

  assert.equal(queries.length, 4);
  for (const query of queries) {
    const sql = sqlOf(query);
    assert.match(sql, /JOIN eth_wallets w ON w\.id = r\.wallet_id/);
    assert.match(sql, /w\.user_id = \$1/);
  }
});

test('a read without a userId throws rather than querying across every user', async () => {
  await assert.rejects(() => EthReconciliation.findForUser(null), /requires a userId/);
  await assert.rejects(() => EthReconciliation.summaryForUser(undefined), /requires a userId/);
  await assert.rejects(() => EthReconciliation.summaryForWallets(null, [1]), /requires a userId/);
  await assert.rejects(() => EthReconciliation.openIssuesForWallets(null, [1]), /requires a userId/);
});

test('reads hide verdicts for tokens the user has since ignored', async () => {
  queries.length = 0;
  await EthReconciliation.findForUser(1, {});
  // Ignoring a token takes effect immediately everywhere else; the audit must
  // not be the one surface still arguing about a spam contract until whenever
  // the next nightly sync happens to prune it.
  assert.match(sqlOf(queries.at(-1)), /NOT EXISTS \( SELECT 1 FROM eth_ignored_tokens/);
});
