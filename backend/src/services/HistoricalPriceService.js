'use strict';

const axios = require('axios');
const AssetPriceHistory = require('../models/AssetPriceHistory');
const SecretsService = require('./SecretsService');
const chains = require('../config/chains');
const { parseAssetKey, NATIVE_ASSET_KEY } = require('../utils/assetPriceKey');
const logger = require('../config/logger');

// =============================================================================
// PRICE SOURCES -- chosen after probing every candidate live on 2026-07-26,
// not from documentation alone. The probes and their verbatim answers are in
// migrations/043_historical_prices.sql; the operational limits are here.
// =============================================================================
//
// 1. CoinGecko /coins/{id}/market_chart/range          (native asset: ETH)
//    https://docs.coingecko.com/reference/coins-id-market-chart-range
//    - Granularity is automatic and NOT requestable on a free key: 5-minutely
//      for the current day, hourly for a 2-90 day span, DAILY above 90 days.
//      A backfill window is years wide, so it answers daily, which is exactly
//      the resolution this table stores. One call per asset per window.
//    - PUBLIC AND DEMO KEYS ARE CAPPED AT 365 DAYS OF HISTORY. A January 2017
//      request answers HTTP 401 with error_code 10012 ("Public API users are
//      limited to querying historical data within the past 365 days"). That is
//      a plan entitlement: a paid key serves the whole history from this one
//      endpoint, which is why it stays first in the ladder.
//    - Demo plan: 30 calls/min, 10,000 calls/month.
//
// 2. Coinbase Exchange GET /products/{product_id}/candles    (native asset)
//    https://docs.cdp.coinbase.com/exchange/reference/exchangerestapi_getproductcandles
//    - Keyless and public. granularity=86400 is a one-day candle; the response
//      is [time, low, high, open, close, volume] with time = bucket start.
//    - MAX 300 CANDLES PER REQUEST (confirmed live: a 517-day request answers
//      "Count of aggregations requested exceeds 300"), so a decade of history
//      is walked in 300-day pages.
//    - ETH-USD goes back to 2016-05-18. THIS is what makes 2017 dollars
//      reachable on a free deployment, and it is why the fallback exists at all.
//    - Public market-data rate limit is ~10 req/s; the throttle below spaces
//      calls far under that.
//
// 3. CoinGecko /coins/{platform}/contract/{contract}/market_chart/range
//    https://docs.coingecko.com/reference/contract-address-market-chart-range
//    (tokens -- the ONLY option, because a token's identity is a contract on a
//    chain and no fiat-pair venue has a notion of one). The platform slug comes
//    from config/chains.js coingeckoPlatform, per chain: the SAME address is a
//    different asset on each chain, and looking one up on the wrong platform
//    answers HTTP 404 "coin not found" -- which this code records as `unlisted`
//    for THAT (chain, contract) pair only, never as a global verdict.
//
// Anything no provider will serve stays ABSENT from asset_price_history. A
// missing row reads as `unpriced`, which is the entire point: never $0, and
// never today's price.

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const COINBASE_EXCHANGE_BASE = 'https://api.exchange.coinbase.com';

// CoinGecko's 365-day refusal. HTTP 401 + this code, distinct from a bad key.
const COINGECKO_RANGE_LIMIT_CODE = 10012;
// One day inside the documented 365, so a request that straddles midnight UTC
// while the clock ticks over cannot land one day outside the cap.
const COINGECKO_FREE_HISTORY_DAYS = 364;

// Coinbase's documented per-request cap. Pages are sized one candle under it so
// an inclusive-boundary off-by-one cannot trip the limit.
const COINBASE_MAX_CANDLES = 300;
const COINBASE_PAGE_DAYS = COINBASE_MAX_CANDLES - 1;

// Earliest date any provider here can answer for ETH (Coinbase's ETH-USD
// listing). Requesting older only burns calls to be told nothing, and a
// backfill window is clamped to it.
const NATIVE_HISTORY_START = '2016-05-18';

const REQUEST_TIMEOUT_MS = 15000;

// One global throttle across every provider and every caller, the same shape
// and for the same reason as config/etherscan.js: the nightly job walks tens of
// assets and a user-triggered sync can land on top of it, so the spacing has to
// be a property of the process rather than of one loop. 250 ms is far under
// Coinbase's ~10 req/s and comfortably inside CoinGecko's 30 calls/min for the
// handful of calls a daily run makes.
const REQUEST_SPACING_MS = 250;
let queue = Promise.resolve();

function throttled(fn) {
  const run = queue.then(fn);
  queue = run
    .catch(() => {})
    .then(() => new Promise((resolve) => setTimeout(resolve, REQUEST_SPACING_MS)));
  return run;
}

// --- date helpers ----------------------------------------------------------
//
// Everything here is UTC and date-only. A price row is keyed by a DATE, so a
// local-timezone Date.toISOString() slice would silently shift a whole series
// by a day for anyone west of Greenwich.

function toDateString(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function dateToUnix(dateString) {
  return Math.floor(Date.parse(`${toDateString(dateString)}T00:00:00Z`) / 1000);
}

function addDays(dateString, days) {
  const at = Date.parse(`${toDateString(dateString)}T00:00:00Z`) + days * 86400000;
  return new Date(at).toISOString().slice(0, 10);
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function maxDate(a, b) {
  return toDateString(a) >= toDateString(b) ? toDateString(a) : toDateString(b);
}

// THE DAILY CONVENTION, in one function.
//
// The stored price for date D is the LAST observation the provider reported
// with a timestamp inside D (UTC). Uniform across providers and granularities:
//
//   * CoinGecko above a 90-day span emits one point per day stamped 00:00:00
//     UTC, so D's stored price is that snapshot -- CoinGecko's own convention,
//     the same one its /coins/{id}/history?date= endpoint uses.
//   * CoinGecko inside 90 days emits hourly points, so D's stored price is the
//     23:00 observation -- a true daily close.
//   * Coinbase emits one candle per day whose `close` IS D's close.
//
// The spread between those readings is one day's intraday movement on a series
// whose whole resolution is one day. Each row records its `source`, so a
// provider switch mid-series is visible rather than inferred.
function foldToDailyClose(observations) {
  const byDate = new Map();
  for (const [timestampMs, price] of observations) {
    // null and '' both coerce to 0 through Number(), which would store a
    // fabricated $0 close for a gap the provider reported as "no data" -- the
    // exact silent-zero this feature exists to remove. Reject them by identity
    // before any coercion.
    if (price === null || price === undefined || price === '') continue;
    const value = Number(price);
    if (!Number.isFinite(value) || value < 0) continue;
    if (!Number.isFinite(Number(timestampMs))) continue;
    const date = new Date(Number(timestampMs)).toISOString().slice(0, 10);
    const existing = byDate.get(date);
    if (!existing || Number(timestampMs) >= existing.at) {
      byDate.set(date, { at: Number(timestampMs), price: value });
    }
  }
  return [...byDate.entries()]
    .map(([date, entry]) => ({ date, price: entry.price }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// --- providers -------------------------------------------------------------

// Non-throwing CoinGecko GET. The BODY is the interesting part of a failure
// here -- a 401 carrying error_code 10012 is "your plan stops at 365 days",
// which is a coverage verdict, while a 401 without it is a bad key and a 404 is
// an asset that does not exist. Throwing would flatten all three into "error"
// and the job would re-probe a permanently unlistable token every night.
async function getCoinGecko(url) {
  const headers = { accept: 'application/json' };
  const apiKey = await SecretsService.getAppSetting('cg_api_key');
  if (apiKey) headers['x-cg-api-key'] = apiKey;

  try {
    const response = await throttled(() => axios.get(url, { timeout: REQUEST_TIMEOUT_MS, headers }));
    return { ok: true, status: response.status, data: response.data };
  } catch (error) {
    const status = error.response?.status ?? null;
    const body = error.response?.data ?? null;
    const errorCode = body?.status?.error_code ?? body?.error?.status?.error_code ?? null;
    return { ok: false, status, errorCode, data: body, message: error.message };
  }
}

async function getCoinbase(url) {
  try {
    const response = await throttled(() => axios.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      // Coinbase rejects requests with no User-Agent from some networks; naming
      // the client is also simple courtesy on a keyless public endpoint.
      headers: { accept: 'application/json', 'User-Agent': 'my-money-tracker' },
    }));
    return { ok: true, status: response.status, data: response.data };
  } catch (error) {
    return {
      ok: false,
      status: error.response?.status ?? null,
      data: error.response?.data ?? null,
      message: error.message,
    };
  }
}

// CoinGecko range for the native asset or for a token contract. Returns a
// verdict, never a throw:
//   { points }                     -- observations, possibly empty
//   { rangeLimited: true }         -- the plan will not serve dates this old
//   { unlisted: true }             -- the provider has no such asset
//   { error }                      -- transient; retried next run
async function coinGeckoRange(pathSegment, from, to) {
  const url = `${COINGECKO_BASE}/${pathSegment}/market_chart/range`
    + `?vs_currency=usd&from=${dateToUnix(from)}&to=${dateToUnix(to) + 86399}`;
  const result = await getCoinGecko(url);

  if (result.ok) {
    const prices = Array.isArray(result.data?.prices) ? result.data.prices : null;
    // An off-shape 200 is a transport failure, never an empty series -- the
    // same rule the method-signature cache applies to Sourcify. Storing "no
    // prices" for a healthy asset would freeze it unpriced until someone
    // noticed.
    if (!prices) return { error: 'CoinGecko returned no prices array' };
    return { points: prices };
  }
  if (result.errorCode === COINGECKO_RANGE_LIMIT_CODE) {
    return { rangeLimited: true, detail: 'CoinGecko plan serves only the last 365 days' };
  }
  if (result.status === 404) {
    return { unlisted: true, detail: 'CoinGecko has no series for this asset' };
  }
  return { error: `CoinGecko HTTP ${result.status ?? '?'}: ${result.message}` };
}

// The 365-day cap is a property of the WINDOW, not of the asset: the same call
// that is refused for 2017 succeeds for the last year. Retrying narrowed is
// what makes the difference between "this token has NO prices at all" and
// "this token has the prices the plan will serve, and the years before them are
// honestly unpriced" -- and tokens have no second provider to fall back to, so
// without this a free-tier key leaves every token leg at $0.00 forever.
//
// Returned with rangeLimited still set, so coverage records `range_limited`
// rather than a clean `covered` over a series that is missing its whole tail.
async function coinGeckoRangeBounded(pathSegment, from, to) {
  const first = await coinGeckoRange(pathSegment, from, to);
  if (!first.rangeLimited) return first;

  const narrowed = maxDate(from, addDays(todayUtc(), -COINGECKO_FREE_HISTORY_DAYS));
  // Already inside the cap and still refused: narrowing changes nothing, and a
  // second guaranteed refusal per asset per night is pure waste.
  if (narrowed <= from || narrowed > to) return first;

  const second = await coinGeckoRange(pathSegment, narrowed, to);
  if (second.points && second.points.length) {
    return { ...second, rangeLimited: true, detail: `${first.detail}; served from ${narrowed}` };
  }
  return first;
}

// Coinbase daily candles, walked in 300-candle pages from `from` to `to`.
// Newest-page-first is irrelevant here (each page is an explicit window), but
// the cap is not: exceeding it answers an error, not a truncated page.
async function coinbaseDailyCandles(productId, from, to) {
  const points = [];
  let windowStart = toDateString(from);
  const windowEnd = toDateString(to);

  while (windowStart <= windowEnd) {
    const pageLimit = addDays(windowStart, COINBASE_PAGE_DAYS);
    const pageEnd = pageLimit < windowEnd ? pageLimit : windowEnd;
    const url = `${COINBASE_EXCHANGE_BASE}/products/${encodeURIComponent(productId)}/candles`
      + `?granularity=86400&start=${windowStart}T00:00:00Z&end=${pageEnd}T00:00:00Z`;
    const result = await getCoinbase(url);

    if (!result.ok) {
      if (result.status === 404) return { unlisted: true, detail: `Coinbase has no ${productId} product` };
      // A partial walk is still worth storing: the pages that landed are real
      // closes, and the next run resumes from the gap.
      return points.length
        ? { points, partial: true, detail: `Coinbase HTTP ${result.status ?? '?'}: ${result.message}` }
        : { error: `Coinbase HTTP ${result.status ?? '?'}: ${result.message}` };
    }
    if (!Array.isArray(result.data)) return { error: 'Coinbase returned a non-array candle response' };

    for (const candle of result.data) {
      if (!Array.isArray(candle) || candle.length < 5) continue;
      // [time, low, high, open, close, volume]; time is the bucket START in
      // SECONDS, and `close` is that day's close.
      points.push([Number(candle[0]) * 1000, candle[4]]);
    }

    if (pageEnd >= windowEnd) break;
    windowStart = addDays(pageEnd, 1);
  }
  return { points };
}

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

    // NATIVE_HISTORY_START is Coinbase's ETH-USD listing date, so it bounds the
    // NATIVE window only. Applying it to tokens would clamp a 2015-era ERC-20
    // (REP, DGD) out of its own fetch window and -- since the stored earliest
    // would then equal the wanted one -- never re-ask, leaving those legs
    // unpriced even on a paid key that has the data.
    const earliest = asset.first_date ? toDateString(asset.first_date) : todayUtc();
    const neededFrom = parsed.kind === 'native' ? maxDate(earliest, NATIVE_HISTORY_START) : earliest;
    const window = await this.missingWindow(asset.asset_key, neededFrom, todayUtc(), {
      providerFloor: coverage?.status === 'range_limited' ? coverage.earliest_date : null,
    });

    const outcome = parsed.kind === 'native'
      ? await this._fetchNative(window)
      : await this._fetchToken(parsed, window);

    const base = {
      assetKey: asset.asset_key,
      assetSymbol: asset.asset_symbol || (parsed.kind === 'native' ? NATIVE_ASSET_KEY : null),
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
      };
    }

    const daily = foldToDailyClose(outcome.points);
    const upserted = await AssetPriceHistory.upsertMany(asset.asset_key, daily, outcome.provider);
    const range = await AssetPriceHistory.coveredRange(asset.asset_key);
    return {
      ...base,
      // A series that landed but could not reach far enough back is
      // `range_limited`, not `covered`: the rows before its earliest date stay
      // unpriced and the user is owed that distinction rather than a green tick.
      status: outcome.status === 'range_limited' ? 'range_limited' : 'covered',
      earliestDate: range.earliest,
      latestDate: range.latest,
      upserted,
    };
  }

  // ETH. CoinGecko first (the issue's stated source, and one call covers any
  // window on a paid key), Coinbase Exchange when the plan refuses the dates --
  // which on a free key is every date older than a year, i.e. exactly the
  // history this feature exists to value.
  static async _fetchNative(window) {
    const cg = await coinGeckoRange('coins/ethereum', window.from, window.to);
    if (cg.points && cg.points.length) return { ...cg, provider: 'coingecko' };

    const reason = cg.rangeLimited
      ? cg.detail
      : cg.error || cg.detail || 'CoinGecko returned an empty series';

    // Coinbase before a narrowed CoinGecko retry, deliberately: it covers the
    // WHOLE window back to 2016, so the series stays on one source and one
    // convention instead of splicing a year of CoinGecko onto a decade of
    // Coinbase at an invisible seam.
    const cb = await coinbaseDailyCandles('ETH-USD', window.from, window.to);
    if (cb.points && cb.points.length) {
      return { ...cb, provider: 'coinbase-exchange', detail: `CoinGecko fell through: ${reason}` };
    }

    // Both refused. A narrowed CoinGecko window is the last resort: a year of
    // ETH prices beats none, and it is recorded as range_limited so the older
    // rows stay honestly unpriced rather than looking covered.
    if (cg.rangeLimited) {
      const narrowed = maxDate(window.from, addDays(todayUtc(), -COINGECKO_FREE_HISTORY_DAYS));
      if (narrowed > window.from && narrowed <= window.to) {
        const retry = await coinGeckoRange('coins/ethereum', narrowed, window.to);
        if (retry.points && retry.points.length) {
          return {
            ...retry,
            provider: 'coingecko',
            status: 'range_limited',
            detail: `${reason}; Coinbase: ${cb.error || cb.detail || 'no candles'}; served from ${narrowed}`,
          };
        }
      }
    }

    return {
      status: cg.rangeLimited ? 'range_limited' : 'error',
      provider: null,
      detail: `${reason}; Coinbase: ${cb.error || cb.detail || 'no candles'}`,
    };
  }

  // A token, against ITS CHAIN's CoinGecko asset platform. Never a pooled
  // lookup: the same contract address is a different asset per chain (039), and
  // asking the wrong platform answers 404 -- which would be recorded as a
  // permanent `unlisted` verdict against a perfectly listed token.
  static async _fetchToken(parsed, window) {
    const platform = chains.getChain(parsed.chainId)?.coingeckoPlatform;
    if (!platform) {
      return {
        status: 'unlisted',
        provider: null,
        detail: `Chain ${parsed.chainId} has no CoinGecko asset platform in the registry`,
      };
    }
    // Bounded, not plain: a token has no fiat-pair fallback, so a plan cap
    // refusing the full window would otherwise leave it with no prices at all.
    const result = await coinGeckoRangeBounded(
      `coins/${platform}/contract/${parsed.contract}`, window.from, window.to
    );
    if (result.points && result.points.length) {
      return {
        ...result,
        provider: 'coingecko',
        // The tail is genuinely missing; saying `covered` would claim otherwise.
        status: result.rangeLimited ? 'range_limited' : undefined,
      };
    }
    if (result.unlisted) return { status: 'unlisted', provider: null, detail: result.detail };
    if (result.rangeLimited) return { status: 'range_limited', provider: null, detail: result.detail };
    return {
      status: 'error',
      provider: null,
      detail: result.error || 'CoinGecko returned an empty series',
    };
  }

  // Should this asset be asked again tonight?
  //
  // `unlisted` is the one permanent verdict -- CoinGecko answered 404 for a
  // (chain, contract) pair, and a contract does not start existing later. It is
  // re-checked on a slow cadence anyway, because a token CAN get listed after
  // the fact and a verdict nothing ever revisits is indistinguishable from a
  // bug. Everything else is retried every run: `covered` needs yesterday's
  // close appended, `range_limited` needs its recent window refreshed, and
  // `error` was transient by definition.
  static shouldFetch(coverage, { recheckUnlistedAfterDays = 30 } = {}) {
    if (!coverage) return true;
    if (coverage.status !== 'unlisted') return true;
    if (!coverage.checked_at) return true;
    const ageDays = (Date.now() - new Date(coverage.checked_at).getTime()) / 86400000;
    return ageDays >= recheckUnlistedAfterDays;
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
    const coverage = await AssetPriceHistory.coverageFor(assets.map((asset) => asset.asset_key));

    const due = assets.filter((asset) => this.shouldFetch(coverage.get(asset.asset_key)));
    const skippedKnown = assets.length - due.length;
    // Ordered by transfer count in the query, so a budget bite drops the assets
    // the user sees least -- and says so rather than reporting a clean run.
    const budgeted = due.slice(0, maxAssets);
    const deferred = due.length - budgeted.length;
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
      await AssetPriceHistory.upsertCoverage(entry);
      results.push(entry);
    }

    return {
      assets: assets.length,
      fetched: budgeted.length,
      skippedKnown,
      deferred,
      covered: results.filter((entry) => entry.status === 'covered').length,
      unlisted: results.filter((entry) => entry.status === 'unlisted').length,
      rangeLimited: results.filter((entry) => entry.status === 'range_limited').length,
      failed: results.filter((entry) => entry.status === 'error').length,
      upserted: results.reduce((sum, entry) => sum + (entry.upserted || 0), 0),
      results,
    };
  }
}

module.exports = HistoricalPriceService;
module.exports.foldToDailyClose = foldToDailyClose;
module.exports.NATIVE_HISTORY_START = NATIVE_HISTORY_START;
module.exports.COINBASE_PAGE_DAYS = COINBASE_PAGE_DAYS;
module.exports.COINGECKO_RANGE_LIMIT_CODE = COINGECKO_RANGE_LIMIT_CODE;
