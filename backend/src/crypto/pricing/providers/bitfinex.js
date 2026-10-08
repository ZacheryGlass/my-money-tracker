'use strict';

// Bitfinex GET /v2/candles/trade:1D:{symbol}/hist           (ALIASED tokens only)
// https://docs.bitfinex.com/reference/rest-public-candles
//   - Keyless and public. sort=1 answers oldest-first; each candle is
//     [MTS, OPEN, CLOSE, HIGH, LOW, VOLUME] with MTS = the candle START in
//     MILLISECONDS. Documented cap of 10,000 candles per request -- ~27 years
//     of dailies, so any real window is one call.
//   - Reached ONLY through config/tokenPriceAliases.js, the hand-declared
//     escape hatch for a token CoinGecko's contract endpoint can never price
//     (probes documented there). tEOSUSD's dailies start 2017-07-01, which is
//     what makes the 2017-18 EOS ERC-20 legs priceable on a free deployment.
//
// The venue quotes in its own quote currency and the close is stored as USD
// outright: exactly true for a USD pair like tEOSUSD, and a DECLARED
// approximation for any stablecoin-quoted alias someone adds later (a USDT
// close treated as USD) -- the alias registry is where that call is made,
// visibly, per entry.

const axios = require('axios');
const logger = require('../../../config/logger');
const { throttled } = require('../limiter');
const { toDateString, dateToUnix, maxDate } = require('../daily');

const BASE = 'https://api-pub.bitfinex.com';
const REQUEST_TIMEOUT_MS = 15000;

// The documented per-request cap. The page walk below exists for correctness,
// not because any real window needs a second page.
const MAX_CANDLES = 10000;

// Same run-level rule as the CoinGecko queue (see its provider): the candles
// route budget is CoinGecko-demo sized, and an alias asset that 429'd was
// never examined.
let paused = false;

async function get(url) {
  // Shut for this run: answer without calling, so later aliased assets spend
  // no network and no wall clock.
  if (paused) {
    return {
      ok: false,
      status: 429,
      rateLimited: true,
      message: 'Bitfinex rate limit reached earlier in this run',
    };
  }
  try {
    const response = await throttled('bitfinex', () => axios.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: { accept: 'application/json', 'User-Agent': 'my-money-tracker' },
    }));
    return { ok: true, status: response.status, data: response.data };
  } catch (error) {
    const status = error.response?.status ?? null;
    if (status === 429) {
      // A verdict on the RUN, not the asset. Writing `error` would invent a
      // verdict AND refresh checked_at, rotating the asset to the back of the
      // staleness order having learned nothing.
      paused = true;
      logger.warn({ url }, 'Bitfinex rate limit hit; pausing its queue for the rest of this run');
      return { ok: false, status, rateLimited: true, data: error.response?.data ?? null, message: error.message };
    }
    return {
      ok: false,
      status,
      data: error.response?.data ?? null,
      message: error.message,
    };
  }
}

// Daily candles for one trading pair, oldest-first.
async function dailyCandles(symbol, from, to) {
  const points = [];
  let startMs = dateToUnix(from) * 1000;
  // Inclusive of all of `to` (UTC): MTS is the candle START, so `to`'s own
  // candle sits at exactly 00:00:00Z of `to`.
  const endMs = dateToUnix(to) * 1000 + 86399999;

  while (startMs <= endMs) {
    const url = `${BASE}/v2/candles/trade:1D:${encodeURIComponent(symbol)}/hist`
      + `?start=${startMs}&end=${endMs}&sort=1&limit=${MAX_CANDLES}`;
    const result = await get(url);

    if (!result.ok) {
      // Out of budget for the minute: not this asset's problem, and no
      // partial-store either -- any real window is one page, and the caller
      // must see rateLimited so NO coverage row is written and the asset
      // stays exactly as due as it was.
      if (result.rateLimited) {
        return { rateLimited: true, detail: `Bitfinex rate limited: ${result.message}` };
      }
      // A partial walk is still worth storing, same as the Coinbase walk: the
      // pages that landed are real closes, and the next run resumes the gap.
      return points.length
        ? { points, partial: true, detail: `Bitfinex HTTP ${result.status ?? '?'}: ${result.message}` }
        : { error: `Bitfinex HTTP ${result.status ?? '?'}: ${result.message}` };
    }
    // An off-shape 200 is a transport failure, never an empty series. Bitfinex's
    // own error payload is an ARRAY (["error", code, message]), so a non-array
    // ELEMENT is off-shape too: reading that page as "no candles" would cache an
    // `empty` verdict off a maintenance response.
    if (!Array.isArray(result.data) || result.data.some((candle) => !Array.isArray(candle))) {
      return { error: 'Bitfinex returned a non-candle response' };
    }

    let lastMts = null;
    for (const candle of result.data) {
      if (candle.length < 3) continue;
      // [MTS, OPEN, CLOSE, HIGH, LOW, VOLUME]; MTS is the candle START in
      // MILLISECONDS and CLOSE is that day's close -- the daily convention.
      points.push([Number(candle[0]), candle[2]]);
      lastMts = Number(candle[0]);
    }

    // A short page is the end of the series inside the window.
    if (result.data.length < MAX_CANDLES) break;
    // A full page that cannot advance the cursor would loop forever; stopping
    // keeps what landed and the covered-range check reports any shortfall.
    if (!Number.isFinite(lastMts) || lastMts + 1 <= startMs) break;
    startMs = lastMts + 1;
  }
  return { points };
}

module.exports = {
  id: 'bitfinex',
  label: 'Bitfinex',
  limiter: 'bitfinex',
  emptyReason: 'no candles',

  supports(request) {
    return Boolean(request.alias?.bitfinexSymbol);
  },

  // The window clamps to the venue's first candle, mirroring the native
  // floor's shape but NOT its semantics: neededFrom stays the ledger's own
  // earliest date, so a ledger that reaches back before the series gets an
  // honest `range_limited` (the pre-listing rows stay unpriced) instead of the
  // clamped-to-covered green tick the native path deliberately gives ETH.
  async fetchDaily(request, window) {
    const { alias } = request;
    const seriesStart = toDateString(alias.historyStart);
    const from = maxDate(window.from, seriesStart);
    if (from > toDateString(window.to)) {
      // The whole window predates the series. Nothing to fetch, and nothing
      // to fabricate: the verdict is the plan-cap verdict, not `empty`.
      return {
        status: 'range_limited',
        provider: 'bitfinex',
        detail: `Bitfinex ${alias.bitfinexSymbol} series starts ${seriesStart}`,
      };
    }

    const result = await dailyCandles(alias.bitfinexSymbol, from, window.to);
    // Out of budget for the minute: not an asset verdict, and no coverage row.
    if (result.rateLimited) {
      return { status: 'rate_limited', provider: null, detail: result.detail };
    }
    if (result.points && result.points.length) {
      const clamped = from > toDateString(window.from);
      return {
        ...result,
        provider: 'bitfinex',
        // A clamped start or a dead page walk both leave ledger dates
        // uncovered; the reached-back check would catch them too, but saying
        // it here keeps the detail naming the actual reason.
        status: clamped || result.partial ? 'range_limited' : undefined,
        detail: clamped
          ? `Bitfinex ${alias.bitfinexSymbol} series starts ${seriesStart}`
          : result.detail,
      };
    }
    if (Array.isArray(result.points)) {
      // Zero candles over a window that INCLUDES the declared historyStart is
      // a contradiction, never `empty`: the registry asserts a candle exists
      // at that date (probed live), and the live venue answers HTTP 200 []
      // for an UNKNOWN symbol -- while `empty` feeds asset_price_coverage's
      // unlisted/empty set, exactly the spam quarantine's "provider says no
      // market" evidence. A typo'd symbol must not make real inbound
      // transfers quarantine-eligible, so the verdict is a transient `error`
      // that stays due.
      if (from === seriesStart) {
        logger.warn({ symbol: alias.bitfinexSymbol, from, to: toDateString(window.to) },
          'Bitfinex answered zero candles over a window including the declared series start; '
          + 'recording a transient error, not an empty series');
        return {
          status: 'error',
          provider: null,
          detail: `Bitfinex answered no ${alias.bitfinexSymbol} candles despite the declared`
            + ` series start ${seriesStart} being in the window`,
        };
      }
      return {
        status: 'empty',
        provider: 'bitfinex',
        detail: `Bitfinex answered no ${alias.bitfinexSymbol} candles for the window`,
      };
    }
    return {
      status: 'error',
      provider: null,
      detail: result.error || 'Bitfinex returned an empty series',
    };
  },

  resetRun() {
    paused = false;
  },

  dailyCandles,
};
