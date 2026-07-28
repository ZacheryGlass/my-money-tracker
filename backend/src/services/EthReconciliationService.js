'use strict';

const EtherscanService = require('./EtherscanService');
const EthTransfer = require('../models/EthTransfer');
const EthReconciliation = require('../models/EthReconciliation');
const EthWalletChain = require('../models/EthWalletChain');
const chains = require('../config/chains');
const logger = require('../config/logger');
const { toBigIntOrNull, absBigInt } = require('../utils/units');

// The balance audit (#62).
//
// Sync starts every feed at block 0, so the stored ledger is genesis-complete
// and the number derived from it should equal the balance the chain reports --
// EXACTLY, for ETH. Anything else means a movement was missed or misparsed, and
// the whole point of writing the comparison down is that the wallet says so
// instead of silently looking complete.
//
// Two rules govern everything below, both borrowed from the exchange-sync
// reconciliation this mirrors:
//
//   1. REPORT, NEVER CORRECT. The derived figure is the thing under test.
//      Holdings keep coming from the live balance (they always did); the audit
//      never writes back into them, because overwriting the derived number with
//      the live one hides the exact bug it exists to find.
//
//   2. SKIP RATHER THAN GUESS. A wallet whose feeds could not all be fetched
//      has an incomplete ledger, and comparing an incomplete ledger to a
//      complete balance manufactures a mismatch that means nothing. A stored
//      report full of phantom drift is worse than no report: it trains the user
//      to ignore the one signal this feature exists to raise.

// Live-balance lookups per wallet per sync, across all chains. ETH costs
// nothing extra -- refreshHoldings already fetched it -- so this budget governs
// ERC-20 lookups only, at one throttled request each. Twenty covers any wallet
// a person actually manages; past that the audit rotates
// least-recently-checked-first, so a wallet buried under airdropped contracts
// still gets every one of them checked, just across several nights.
const MAX_TOKEN_LOOKUPS = 20;

// A token delta this small is rounding, not a missed transfer: 1e-8 of a unit
// (the same absolute floor the exchange reconciliation uses) or one part per
// million of the live position, whichever is looser.
const DUST_DECIMAL_PLACES = 8;
const RELATIVE_TOLERANCE_EXPONENT = 6;

// NULL token_decimals means 18 in every shared unit helper in this codebase;
// diverging here would scale a real drift into or out of the dust band.
const DEFAULT_DECIMALS = 18;

const SKIP_REASONS = {
  // This run could not fetch one of the feeds the asset is derived from. The
  // rows were never ingested, so the ledger is incomplete rather than stale.
  FEED_GAP: 'feed_gap',
  // The Etherscan key cannot serve this chain at all.
  CHAIN_UNAVAILABLE: 'chain_unavailable',
  // The chain's ingest threw (a DB blip, a cursor write timing out). Isolated
  // per 039: its neighbours still reconcile.
  CHAIN_ERROR: 'chain_error',
  // Never successfully synced, so there is no ledger to compare yet.
  NEVER_SYNCED: 'never_synced',
  // Deferred by MAX_TOKEN_LOOKUPS; it is first in line next sync.
  LOOKUP_BUDGET: 'lookup_budget',
  // No Etherscan key for this wallet's owner, so no live figure can be read at
  // all. Distinct from LOOKUP_BUDGET on purpose: "checked on a later sync" is a
  // promise, and without a key no later sync keeps it.
  NO_API_KEY: 'no_api_key',
  // The live balance call itself failed.
  LIVE_FETCH_FAILED: 'live_fetch_failed',
};

// The feeds each asset class is derived from. A gap in ANY of them makes that
// asset's derived figure incomplete:
//   * native ETH/POL needs `normal` (value transfers plus the gas rows
//     synthesized from txlist), `internal` (native arriving from a contract,
//     which the normal feed cannot see at all), and -- where a chain declares
//     it -- `statesync` (#76: bridged-in native POL, which Polygon credits
//     through the Bor state sync and no account feed reports). `statesync` is
//     safe to list unconditionally: a chain that does not declare the feed never
//     runs it, so its key never appears in unsupported_feeds/skippedFeeds and
//     feedGap can never falsely fire on it. On Polygon a skipped state-sync feed
//     leaves the derived native balance short by exactly the missed deposit, so
//     the audit must skip rather than report that as drift.
//   * ERC-20 balances need `token`
// Note what is deliberately absent: 034's method capture and 038's tx_is_error
// are forward-only gaps, but neither enters balance math -- method_id is a
// display hint and gas legs count regardless of whether the transaction
// reverted -- so a pre-034/pre-038 row reconciles exactly like a fresh one.
// The NFT feeds are absent for the same reason: NFTs are not reconciled.
const REQUIRED_FEEDS = {
  native: ['normal', 'internal', 'statesync'],
  token: ['token'],
};

// Exact integer comparison, no floats anywhere: |delta| * 1e8 < 1 unit, or
// |delta| * 1e6 <= |live|. Both are shifts and multiplications on BigInt, so a
// wei-scale difference is never rounded into agreement.
function isDust(delta, live, decimals) {
  const magnitude = absBigInt(delta);
  if (magnitude === 0n) return false;
  const unit = 10n ** BigInt(Math.max(0, decimals));
  if (magnitude * 10n ** BigInt(DUST_DECIMAL_PLACES) < unit) return true;
  if (live != null && magnitude * 10n ** BigInt(RELATIVE_TOLERANCE_EXPONENT) <= absBigInt(live)) return true;
  return false;
}

class EthReconciliationService {
  static get MAX_TOKEN_LOOKUPS() { return MAX_TOKEN_LOOKUPS; }
  static get SKIP_REASONS() { return SKIP_REASONS; }

  // Decides a single asset's verdict from its derived and live figures.
  // Separated out because it is the whole judgement of this feature and it is
  // pure: no clock, no network, no database.
  //
  // ETH gets NO tolerance. The issue is explicit that a nonzero ETH delta is a
  // hard signal -- blob fees, a self-destruct credit, a validator payout, an
  // unsynced feed -- and every one of those is a real movement the ledger is
  // missing. Tokens do get a dust band, because a rebasing or fee-on-transfer
  // contract legitimately changes a balance without emitting a Transfer event
  // the wallet could ever have recorded.
  static classify({ assetType, derived, live, decimals }) {
    if (live == null) {
      return { status: 'unavailable', delta: null, skipReason: SKIP_REASONS.LIVE_FETCH_FAILED };
    }
    const delta = derived - live;
    if (delta === 0n) return { status: 'match', delta, skipReason: null };
    if (assetType === 'token' && isDust(delta, live, decimals)) {
      return { status: 'dust', delta, skipReason: null };
    }
    return { status: 'mismatch', delta, skipReason: null };
  }

  // Which chains this run may reconcile, and why the others may not.
  //
  // Reads the CURRENT run's per-chain results when the sync passes them, and
  // falls back to the stored eth_wallet_chains rows otherwise. The two are NOT
  // in parity: a result carries the run's per-feed detail, while the stored row
  // has collapsed it into one error_code (`CHAIN_UNAVAILABLE`, `FEED_SKIPPED`,
  // or whatever `err.code || 'SYNC_ERROR'` the chain threw). So the fallback is
  // fail-closed -- any error_code that is not the known 'chain cannot be read'
  // verdict skips the chain as CHAIN_ERROR rather than being ignored, because
  // an unrecognised code means the last run left a hole of unknown shape and
  // comparing across it manufactures drift that means nothing.
  static chainGates(chainResults, chainStates) {
    const gates = new Map();
    const stored = new Map((chainStates || []).map((state) => [Number(state.chain_id), state]));

    for (const chain of chains.enabledChains()) {
      const result = (chainResults || []).find((entry) => Number(entry.chainId) === chain.id);
      const state = stored.get(chain.id);
      const gate = { chainId: chain.id, chainName: chain.name, skip: null, unsupportedFeeds: [] };

      if (result) {
        if (result.error) gate.skip = SKIP_REASONS.CHAIN_ERROR;
        else if (result.unavailable) gate.skip = SKIP_REASONS.CHAIN_UNAVAILABLE;
        // A transiently skipped feed is exactly as much of a hole as a
        // permanently unsupported one: its rows were never fetched and its
        // cursor did not move, so anything derived from it is incomplete.
        gate.unsupportedFeeds = [...(result.unsupportedFeeds || []), ...(result.skippedFeeds || [])];
      } else if (state) {
        if (state.error_code === 'CHAIN_UNAVAILABLE') gate.skip = SKIP_REASONS.CHAIN_UNAVAILABLE;
        // 'FEED_SKIPPED', 'SYNC_ERROR', 'CHAIN_SYNC_FAILED' and anything else a
        // future writer stores: the chain's last run did not complete, so its
        // ledger is incomplete by an unknown amount.
        else if (state.error_code) gate.skip = SKIP_REASONS.CHAIN_ERROR;
        else if (!state.last_synced_at) gate.skip = SKIP_REASONS.NEVER_SYNCED;
        gate.unsupportedFeeds = state.unsupported_feeds || [];
      } else {
        // Enabled, but with no chain row and no result: nothing has ever been
        // ingested here, so there is no ledger to audit.
        gate.skip = SKIP_REASONS.NEVER_SYNCED;
      }
      gates.set(chain.id, gate);
    }
    return gates;
  }

  static feedGap(gate, assetType) {
    if (!gate.unsupportedFeeds?.length) return false;
    return REQUIRED_FEEDS[assetType].some((feed) => gate.unsupportedFeeds.includes(feed));
  }

  /**
   * Audit one wallet and store the result.
   *
   * `liveWeiByChain` comes from refreshHoldings, which has just fetched every
   * enabled chain's ETH balance. Reusing it is not an optimisation detail: a
   * second `action=balance` per chain would double the audit's cost against a
   * globally throttled key to re-read a number this sync already holds.
   *
   * Never throws for one asset's sake. A failure on a (chain, asset) is recorded
   * against that row and the rest of the audit continues -- and the caller wraps
   * the whole thing anyway, because an audit is a verdict on the sync, never a
   * gate in front of it.
   */
  static async reconcileWallet(wallet, { liveWeiByChain = {}, chainResults = null, apiKey = null } = {}) {
    const chainStates = chainResults ? null : await EthWalletChain.findForWallet(wallet.id);
    const gates = this.chainGates(chainResults, chainStates);
    // Unreachable while enabledChains() floors at mainnet, and shaped exactly
    // like the real summary anyway so a caller reading .matched off it cannot
    // silently get undefined the day that floor moves.
    if (!gates.size) {
      return {
        assets: 0, checked: 0, matched: 0, dust: 0, mismatches: 0,
        nativeMismatches: 0, skipped: 0, unavailable: 0, deferred: 0,
      };
    }

    const nativeRows = await EthTransfer.nativeBalanceDeltas(wallet.id);
    const nativeByChain = new Map(nativeRows.map((row) => [Number(row.chain_id), row.balance_wei]));
    const tokenRows = await EthTransfer.tokenBalanceDeltas(wallet.id);
    const lastChecked = await EthReconciliation.lastCheckedByAsset(wallet.id);

    const summary = {
      assets: 0, checked: 0, matched: 0, dust: 0, mismatches: 0,
      nativeMismatches: 0, skipped: 0, unavailable: 0, deferred: 0,
    };
    const writtenKeys = [];
    const reconciledChainIds = [];

    // ---- native ETH, one row per enabled chain -----------------------------
    for (const [chainId, gate] of gates) {
      reconciledChainIds.push(chainId);
      // '0' rather than null when a chain has no transfers at all: a wallet that
      // has never touched Arbitrum genuinely derives zero there, and the chain
      // reporting zero back is a match, not an absence of information.
      const derived = toBigIntOrNull(nativeByChain.get(chainId) ?? '0') ?? 0n;
      const skip = gate.skip || (this.feedGap(gate, 'native') ? SKIP_REASONS.FEED_GAP : null);
      const live = skip ? null : toBigIntOrNull(liveWeiByChain[chainId]);

      let verdict;
      if (skip) {
        verdict = { status: 'skipped', delta: null, skipReason: skip };
      } else if (live == null) {
        // refreshHoldings skipped or failed this chain's balance call; it
        // already logged why. Recorded as unavailable rather than skipped:
        // the ledger is fine, the live side is what is missing.
        verdict = { status: 'unavailable', delta: null, skipReason: SKIP_REASONS.LIVE_FETCH_FAILED };
      } else {
        verdict = this.classify({ assetType: 'native', derived, live, decimals: DEFAULT_DECIMALS });
      }

      await this._store(wallet.id, {
        chain_id: chainId,
        // The native symbol, matching the asset_price_history key. Rows are
        // stored per (wallet, chain, asset_key), so every pre-Polygon 'ETH'
        // row keeps its identity and needs no migration.
        asset_key: chains.nativeSymbol(chainId),
        asset_type: 'native',
        token_symbol: chains.nativeSymbol(chainId),
        token_decimals: DEFAULT_DECIMALS,
        derived_units: derived.toString(),
        live_units: live == null ? null : live.toString(),
        delta_units: verdict.delta == null ? null : verdict.delta.toString(),
        status: verdict.status,
        skip_reason: verdict.skipReason,
      }, summary, writtenKeys, { assetType: 'native' });
    }

    // ---- ERC-20 tokens -----------------------------------------------------
    //
    // Tokens with a nonzero derived balance. A NEGATIVE one is kept
    // deliberately -- holdings drop those, but a ledger that says the wallet
    // sent more than it ever received is the loudest possible evidence of a
    // missed inbound transfer, and dropping it would hide the best signal here.
    //
    // A derived ZERO is kept too, unless a previous run already compared it and
    // the chain AGREED it was zero. "Derived zero" is a statement by the ledger,
    // and the ledger is the thing under test: dropping the row on the ledger's
    // own say-so deletes last night's verdict (pruneMissing reaps anything not
    // rewritten) exactly when the chain may still be holding the token. Once a
    // 'match' at zero is on record, the pair agree and the row can retire --
    // which is what makes a token genuinely sold to zero stop being audited.
    //
    // Remaining blind spot, named deliberately: a token the wallet holds on
    // chain but has NEVER recorded a transfer for derives no row and has no
    // stored verdict, so it is invisible to this audit entirely. Catching it
    // would need an address-level token enumeration, which the feeds this sync
    // uses do not provide.
    const candidates = tokenRows
      .filter((row) => gates.has(Number(row.chain_id)))
      .map((row) => ({
        chainId: Number(row.chain_id),
        contract: row.token_contract,
        symbol: row.token_symbol,
        decimals: row.token_decimals != null ? Number(row.token_decimals) : DEFAULT_DECIMALS,
        derived: toBigIntOrNull(row.balance_units) ?? 0n,
      }))
      .filter((row) => {
        if (row.derived !== 0n) return true;
        const prior = lastChecked.get(`${row.chainId}:${row.contract}`);
        return prior != null && prior.status !== 'match';
      });

    // Least-recently-checked first so a token set larger than the budget is
    // covered across successive syncs. Never-COMPARED tokens lead: they either
    // have no row at all, or one written by a skip, whose checked_at the upsert
    // deliberately leaves NULL rather than stamping (a stamped skip would sort
    // the deferred tail behind the assets just checked and starve it forever).
    // The contract breaks ties so the order is stable and a rotation cannot
    // livelock on two tokens with identical timestamps.
    candidates.sort((a, b) => {
      const aAt = lastChecked.get(`${a.chainId}:${a.contract}`)?.checkedAt;
      const bAt = lastChecked.get(`${b.chainId}:${b.contract}`)?.checkedAt;
      if (!aAt && bAt) return -1;
      if (aAt && !bAt) return 1;
      if (aAt && bAt && aAt.getTime?.() !== bAt.getTime?.()) return aAt - bAt;
      return a.contract < b.contract ? -1 : a.contract > b.contract ? 1 : 0;
    });

    let lookups = 0;
    for (const token of candidates) {
      const gate = gates.get(token.chainId);
      const skip = gate.skip || (this.feedGap(gate, 'token') ? SKIP_REASONS.FEED_GAP : null);
      let verdict;
      let live = null;

      if (skip) {
        verdict = { status: 'skipped', delta: null, skipReason: skip };
      } else if (!apiKey) {
        // No key at all. Not 'lookup_budget': that reason promises the asset is
        // first in line next sync, and without a key there is no next sync that
        // can keep the promise. Not counted as deferred either, for the same
        // reason.
        verdict = { status: 'skipped', delta: null, skipReason: SKIP_REASONS.NO_API_KEY };
      } else if (toBigIntOrNull(liveWeiByChain[token.chainId]) == null) {
        // This chain's ETH balance could not be read this run, so the key
        // cannot reach it right now. Spending up to MAX_TOKEN_LOOKUPS throttled
        // `tokenbalance` calls against a chain that has already proved
        // unreadable buys nothing and starves the chains that ARE readable.
        verdict = { status: 'unavailable', delta: null, skipReason: SKIP_REASONS.LIVE_FETCH_FAILED };
      } else if (lookups >= MAX_TOKEN_LOOKUPS) {
        // Budget exhausted. Written down rather than left out: a silently
        // truncated audit reads as "everything checks out".
        summary.deferred += 1;
        verdict = { status: 'skipped', delta: null, skipReason: SKIP_REASONS.LOOKUP_BUDGET };
      } else {
        lookups += 1;
        try {
          live = toBigIntOrNull(await EtherscanService.getTokenBalance(
            wallet.address, token.contract, apiKey, token.chainId
          ));
        } catch (err) {
          // Isolated per (chain, asset), per 039: one unreadable contract must
          // not decide anything about its neighbours or about the sync.
          logger.warn({ walletId: wallet.id, chainId: token.chainId, contract: token.contract, err },
            'Token balance lookup failed; that asset is reported unchecked');
          live = null;
        }
        verdict = live == null
          ? { status: 'unavailable', delta: null, skipReason: SKIP_REASONS.LIVE_FETCH_FAILED }
          : this.classify({ assetType: 'token', derived: token.derived, live, decimals: token.decimals });
      }

      await this._store(wallet.id, {
        chain_id: token.chainId,
        asset_key: token.contract,
        asset_type: 'token',
        token_symbol: token.symbol,
        token_decimals: token.decimals,
        derived_units: token.derived.toString(),
        live_units: live == null ? null : live.toString(),
        delta_units: verdict.delta == null ? null : verdict.delta.toString(),
        status: verdict.status,
        skip_reason: verdict.skipReason,
      }, summary, writtenKeys, { assetType: 'token' });
    }

    // Verdicts for assets this run no longer tracks (sold to zero, newly
    // ignored) are dropped -- but only on the chains actually walked, so a
    // disabled chain keeps its last verdict rather than silently losing it.
    try {
      await EthReconciliation.pruneMissing(wallet.id, reconciledChainIds, [...new Set(writtenKeys)]);
    } catch (err) {
      logger.warn({ walletId: wallet.id, err }, 'Reconciliation cleanup failed; stale rows kept');
    }

    if (summary.deferred) {
      logger.info({ walletId: wallet.id, deferred: summary.deferred, budget: MAX_TOKEN_LOOKUPS },
        'Token balance lookups deferred to the next sync by the per-wallet budget');
    }
    logger.info({ walletId: wallet.id, ...summary }, 'ETH balance reconciliation');
    return summary;
  }

  // One row's write plus its tally. Wrapped so a single failed INSERT (a value
  // that will not fit, a lock timeout) costs exactly that one asset's verdict.
  static async _store(walletId, row, summary, writtenKeys, { assetType }) {
    summary.assets += 1;
    if (row.status === 'match') summary.matched += 1;
    else if (row.status === 'dust') summary.dust += 1;
    else if (row.status === 'mismatch') {
      summary.mismatches += 1;
      if (assetType === 'native') summary.nativeMismatches += 1;
    } else if (row.status === 'unavailable') summary.unavailable += 1;
    else if (row.status === 'skipped') summary.skipped += 1;
    if (row.status === 'match' || row.status === 'dust' || row.status === 'mismatch') summary.checked += 1;

    // Keyed by (chain, asset): the same contract address is a different asset on
    // each chain, so a bare key would let mainnet's USDC shield a stale Arbitrum
    // verdict for the same address from cleanup.
    const key = `${row.chain_id}:${row.asset_key}`;
    try {
      await EthReconciliation.upsert(walletId, row);
    } catch (err) {
      logger.warn({ walletId, chainId: row.chain_id, asset: row.asset_key, err },
        'Could not store a reconciliation verdict; the other assets are unaffected');
      // Falls through to the push below deliberately: pruneMissing deletes
      // anything not in this list, and a row that merely failed to UPDATE must
      // not then be DELETED -- that turns a transient write error into data loss.
    }
    writtenKeys.push(key);
  }
}

module.exports = EthReconciliationService;
