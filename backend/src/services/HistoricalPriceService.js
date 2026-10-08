'use strict';

const AssetPriceHistory = require('../models/AssetPriceHistory');
const chains = require('../config/chains');
const { parseAssetKey } = require('../utils/assetPriceKey');
const { aliasForAssetKey } = require('../config/tokenPriceAliases');
const logger = require('../config/logger');
const pricing = require('../crypto/pricing');
const { PROVIDER_SPACING_MS } = require('../crypto/pricing/limiter');
const {
  toDateString, addDays, todayUtc, maxDate, foldToDailyClose,
} = require('../crypto/pricing/daily');

// =============================================================================
// PRICE SOURCES -- chosen after probing every candidate live on 2026-07-26,
// not from documentation alone. The probes and their verbatim answers are in
// migrations/043_historical_prices.sql. Each provider's endpoint, limits and
// failure verdicts live in its own file under crypto/pricing/providers/, the
// order they are asked in is crypto/pricing/order.js, and the per-provider
// throttle is crypto/pricing/limiter.js. This file owns the window, the
// coverage verdict and the run budget.
// =============================================================================
//
// Anything no provider will serve stays ABSENT from asset_price_history. A
// missing row reads as `unpriced`, which is the entire point: never $0, and
// never today's price.

// Earliest date any provider here can answer for ETH (Coinbase's ETH-USD
// listing). Requesting older only burns calls to be told nothing, and a
// backfill window is clamped to it. PER NATIVE ASSET, since a chain added later
// may have listed a decade after ether did -- chains.NATIVE_ASSETS carries each
// symbol's floor and this is the ETH default for a symbol with no entry.
const NATIVE_HISTORY_START = '2016-05-18';

// --- the service -----------------------------------------------------------

class HistoricalPriceService {
  // The window an asset's series has to cover, given what the ledger needs and
  // what is already stored.
  //
  // Both ends move: `from` extends backward the first time a wallet's history
  // reaches further back than the stored series (adding a 2016 wallet must
  // backfill 2016, not just resume at yesterday), and `to` always runs to
  // today. The overlap at the recent end is deliberate -- re-fetching the last
  // few days corrects the provisional close stored for a day that had not
  // finished, exactly as BenchmarkService's inclusive resume does.
  static async missingWindow(assetKey, neededFrom, neededTo, { providerFloor = null } = {}) {
    // The earliest date the provider has ALREADY said it will serve. Without
    // it, an asset the plan caps at 365 days looks like "the ledger reaches
    // further back than the series" on every single run, and every run spends a
    // guaranteed refusal re-asking for a decade it will never get.
    const floor = providerFloor ? toDateString(providerFloor) : null;
    const wantedFrom = floor && floor > toDateString(neededFrom) ? floor : toDateString(neededFrom);
    const wantedTo = toDateString(neededTo);
    const stored = await AssetPriceHistory.coveredRange(assetKey);

    // Nothing stored, or the ledger now reaches further back than the series
    // does (a newly added 2016 wallet): fetch the whole window. One call on a
    // paid key, one page walk on the free path, and only on the run that first
    // sees the older history.
    if (!stored.points || toDateString(stored.earliest) > wantedFrom) {
      return { from: wantedFrom, to: wantedTo };
    }

    // Everything old is stored; refresh the trailing edge only. The two-day
    // overlap is deliberate: the close stored for a day that had not finished
    // yet is provisional, and re-fetching corrects it -- exactly what
    // BenchmarkService's inclusive resume does for benchmark_prices.
    const from = maxDate(addDays(toDateString(stored.latest), -2), wantedFrom);
    return { from: from > wantedTo ? wantedTo : from, to: wantedTo };
  }

  // Fill one asset's series and record what the provider said about it.
  // Returns a coverage entry; never throws for a provider problem, because one
  // dead token must not stop the other forty assets from being priced.
  static async ensureAsset(asset, coverage = null) {
    const parsed = parseAssetKey(asset.asset_key);
    if (!parsed) {
      return { assetKey: asset.asset_key, status: 'unlisted', detail: 'Unrecognized asset key form' };
    }

    // The native floor is the fallback provider's listing date for THAT symbol,
    // so it bounds the NATIVE window only. Applying it to tokens would clamp a
    // 2015-era ERC-20 (REP, DGD) out of its own fetch window and -- since the
    // stored earliest would then equal the wanted one -- never re-ask, leaving
    // those legs unpriced even on a paid key that has the data.
    const earliest = asset.first_date ? toDateString(asset.first_date) : todayUtc();
    const nativeFloor = parsed.kind === 'native'
      ? (chains.nativeAssetInfo(parsed.symbol)?.historyStart || NATIVE_HISTORY_START)
      : null;
    const neededFrom = nativeFloor ? maxDate(earliest, nativeFloor) : earliest;
    const window = await this.missingWindow(asset.asset_key, neededFrom, todayUtc(), {
      providerFloor: coverage?.status === 'range_limited' ? coverage.earliest_date : null,
    });

    // The route (crypto/pricing/order.js) picks the providers; a declared
    // alias outranks the token route outright.
    const alias = parsed.kind === 'erc20' ? aliasForAssetKey(asset.asset_key) : null;
    const native = parsed.kind === 'native' ? chains.nativeAssetInfo(parsed.symbol) : null;
    // Both native provider ids come from the registry: a symbol with no entry
    // has no way to be priced, and saying so is the only honest answer --
    // fetching ether's series for it would price the asset wrongly and look
    // completely healthy doing it.
    const outcome = parsed.kind === 'native' && !native
      ? {
        status: 'unlisted',
        provider: null,
        detail: `Native asset ${parsed.symbol} has no price source in the registry`,
      }
      : await pricing.fetchDaily({ parsed, native, alias }, window);

    const base = {
      assetKey: asset.asset_key,
      assetSymbol: asset.asset_symbol || (parsed.kind === 'native' ? parsed.symbol : null),
      chainId: parsed.chainId,
      contractAddress: parsed.contract,
      provider: outcome.provider || null,
      detail: outcome.detail || null,
    };

    if (!outcome.points || !outcome.points.length) {
      const range = await AssetPriceHistory.coveredRange(asset.asset_key);
      return {
        ...base,
        status: outcome.status || 'error',
        earliestDate: range.earliest,
        latestDate: range.latest,
        upserted: 0,
        // 'rate_limited' is a run-level condition, not an asset verdict, and is
        // not even a legal coverage status: _fill writes no coverage row for it,
        // so the asset stays exactly as due as it was before the run.
        skipCoverage: outcome.status === 'rate_limited',
      };
    }

    const daily = foldToDailyClose(outcome.points);
    const upserted = await AssetPriceHistory.upsertMany(asset.asset_key, daily, outcome.provider);
    const range = await AssetPriceHistory.coveredRange(asset.asset_key);
    // "Points landed" is NOT "the window is covered". A plan cap, a Coinbase
    // page walk that died halfway, or a provider whose series simply starts
    // later than the ledger does all return a non-empty array that stops short
    // of the dates the ledger needs -- and every row before `earliest` stays
    // unpriced. Comparing the stored earliest to the date the ledger asked for
    // is the only check that catches all three; reporting `covered` off a
    // non-empty array would put a green tick on a series missing its tail.
    const reachedBack = range.earliest && toDateString(range.earliest) <= toDateString(neededFrom);
    const partial = outcome.status === 'range_limited' || outcome.partial === true || !reachedBack;
    return {
      ...base,
      status: partial ? 'range_limited' : 'covered',
      earliestDate: range.earliest,
      latestDate: range.latest,
      upserted,
    };
  }

  // Should this asset be asked again tonight?
  //
  // `unlisted` (CoinGecko answered 404 for a (chain, contract) pair) and
  // `empty` (it answered 200 with no closes) are the two standing verdicts.
  // Neither is permanent -- a token CAN get listed after the fact, and a
  // verdict nothing ever revisits is indistinguishable from a bug -- so both
  // are re-checked on the same slow cadence rather than nightly.
  //
  // `covered` whose series already reaches YESTERDAY is skipped too, and that
  // is a budget decision, not a correctness one: today's close is provisional
  // until the day ends, so re-fetching it buys a number that will be rewritten
  // anyway, and the budget it eats is the budget the tail of the work list
  // never gets. The next run sees a two-day-old latest and fetches, which is
  // also what corrects that provisional close.
  //
  // Accepted interaction with the alias path: tEOSUSD's last candle is
  // ~2026-07-03 (the venue delisted / the pair went stale), so the aliased
  // asset's latest_date never reaches yesterday and it re-fetches nightly
  // forever -- one cheap keyless call, accepted rather than special-cased.
  //
  // `range_limited` and `error` are still retried every run: the first needs
  // its recent window refreshed, the second was transient by definition.
  static shouldFetch(coverage, { recheckUnlistedAfterDays = 30, today = todayUtc() } = {}) {
    if (!coverage) return true;
    if (coverage.status === 'unlisted' || coverage.status === 'empty') {
      if (!coverage.checked_at) return true;
      const ageDays = (Date.now() - new Date(coverage.checked_at).getTime()) / 86400000;
      return ageDays >= recheckUnlistedAfterDays;
    }
    if (coverage.status === 'covered' && coverage.latest_date
        && toDateString(coverage.latest_date) >= addDays(today, -1)) {
      return false;
    }
    return true;
  }

  // The nightly pass: extend every ledger asset's series, then record coverage.
  // Global, like the price-update and benchmark jobs -- the series is shared
  // market data.
  static async backfillLedgerAssets({ maxAssets = 200 } = {}) {
    return this._fill(await AssetPriceHistory.ledgerAssetsForJobs(), maxAssets);
  }

  // The same pass narrowed to one wallet, run during its sync.
  //
  // Without it a wallet added today would show a decade of history as unpriced
  // until the nightly job next ran -- and "unpriced" is a load-bearing signal,
  // so handing a new user a screen full of it would teach them to ignore it.
  // The budget is smaller than the job's on purpose: a sync is interactive, and
  // the nightly run picks up whatever this defers.
  static async ensureAssetsForWallet(walletId, { maxAssets = 25 } = {}) {
    return this._fill(await AssetPriceHistory.ledgerAssetsForWallet(walletId), maxAssets);
  }

  static async _fill(assets, maxAssets) {
    pricing.resetRun();
    const coverage = await AssetPriceHistory.coverageFor(assets.map((asset) => asset.asset_key));

    const due = assets.filter((asset) => this.shouldFetch(coverage.get(asset.asset_key)));
    const skippedKnown = assets.length - due.length;

    // ORDERED BY STALENESS, not by transfer count.
    //
    // The work-list query orders by COUNT(*) DESC, which is a stable ordering
    // over an ordering that barely changes -- so slicing the first maxAssets
    // out of it hands the SAME assets the whole budget every single run and the
    // tail is not deferred, it is starved forever. Never-checked first, then
    // longest-unchecked, makes the rotation actually rotate: an asset the
    // budget dropped tonight is at the FRONT tomorrow. Transfer count stays as
    // the tiebreak, so among equally stale assets the busiest still wins.
    const staleness = (asset) => {
      const seen = coverage.get(asset.asset_key);
      return seen?.checked_at ? new Date(seen.checked_at).getTime() : -Infinity;
    };
    const ordered = [...due].sort((a, b) => staleness(a) - staleness(b));

    const budgeted = ordered.slice(0, maxAssets);
    const deferred = ordered.length - budgeted.length;
    if (deferred > 0) {
      logger.warn({ assets: assets.length, budgeted: budgeted.length, deferred },
        'Historical price backfill hit its per-run asset budget; the rest resume next run');
    }

    const results = [];
    for (const asset of budgeted) {
      let entry;
      try {
        entry = await this.ensureAsset(asset, coverage.get(asset.asset_key) || null);
      } catch (err) {
        // A thrown provider or DB error is one asset's problem. Recording it as
        // `error` keeps it in tomorrow's work list instead of stranding it.
        logger.warn({ assetKey: asset.asset_key, err }, 'Historical price fetch failed for one asset');
        entry = {
          assetKey: asset.asset_key,
          assetSymbol: asset.asset_symbol || null,
          status: 'error',
          detail: err.message,
        };
      }
      // A rate-limited asset was never actually examined, so its previous
      // coverage row stands -- writing anything here (even 'error') would both
      // invent a verdict and refresh checked_at, pushing the asset to the BACK
      // of the staleness rotation for a run that never asked about it.
      if (!entry.skipCoverage) await AssetPriceHistory.upsertCoverage(entry);
      results.push(entry);
    }

    return {
      assets: assets.length,
      fetched: budgeted.length,
      skippedKnown,
      deferred,
      covered: results.filter((entry) => entry.status === 'covered').length,
      unlisted: results.filter((entry) => entry.status === 'unlisted').length,
      empty: results.filter((entry) => entry.status === 'empty').length,
      rangeLimited: results.filter((entry) => entry.status === 'range_limited').length,
      rateLimited: results.filter((entry) => entry.status === 'rate_limited').length,
      failed: results.filter((entry) => entry.status === 'error').length,
      upserted: results.reduce((sum, entry) => sum + (entry.upserted || 0), 0),
      results,
    };
  }
}

module.exports = HistoricalPriceService;
module.exports.foldToDailyClose = foldToDailyClose;
// Exported for the same reason foldToDailyClose is: the pure fetch half of
// the alias path, exercisable without a database.
module.exports.bitfinexDailyCandles = pricing.provider('bitfinex').dailyCandles;
// Mutable on purpose: the suite zeroes the spacing (see the limiter's comment).
module.exports.PROVIDER_SPACING_MS = PROVIDER_SPACING_MS;
// The pause is per RUN and _fill clears it, so nothing in production needs
// this; a test that calls ensureAsset directly is its own run and does.
module.exports.resetProviderPauses = pricing.resetRun;
module.exports.NATIVE_HISTORY_START = NATIVE_HISTORY_START;
module.exports.COINBASE_PAGE_DAYS = pricing.provider('coinbase-exchange').PAGE_DAYS;
module.exports.COINGECKO_RANGE_LIMIT_CODE = pricing.provider('coingecko').RANGE_LIMIT_CODE;
