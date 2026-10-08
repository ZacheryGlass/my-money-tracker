'use strict';

// Coinbase Exchange GET /products/{product_id}/candles     (native assets)
// https://docs.cdp.coinbase.com/exchange/reference/exchangerestapi_getproductcandles
//   - Keyless and public. granularity=86400 is a one-day candle; the response
//     is [time, low, high, open, close, volume] with time = bucket start.
//   - MAX 300 CANDLES PER REQUEST (confirmed live: a 517-day request answers
//     "Count of aggregations requested exceeds 300"), so a decade of history
//     is walked in 300-day pages.
//   - ETH-USD goes back to 2016-05-18. THIS is what makes 2017 dollars
//     reachable on a free deployment, and it is why the fallback exists at all.
//   - Public market-data rate limit is ~10 req/s; the limiter spaces calls far
//     under that.
// The product id comes from the network registry's native asset entry.

const axios = require('axios');
const { throttled } = require('../limiter');
const { toDateString, addDays } = require('../daily');

const BASE = 'https://api.exchange.coinbase.com';
const REQUEST_TIMEOUT_MS = 15000;

// The documented per-request cap. Pages are sized one candle under it so an
// inclusive-boundary off-by-one cannot trip the limit.
const MAX_CANDLES = 300;
const PAGE_DAYS = MAX_CANDLES - 1;

async function get(url) {
  try {
    const response = await throttled('coinbase', () => axios.get(url, {
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

// Daily candles, walked in 300-candle pages from `from` to `to`. Each page is
// an explicit window, but the cap is not optional: exceeding it answers an
// error, not a truncated page.
async function dailyCandles(productId, from, to) {
  const points = [];
  let windowStart = toDateString(from);
  const windowEnd = toDateString(to);

  while (windowStart <= windowEnd) {
    const pageLimit = addDays(windowStart, PAGE_DAYS);
    const pageEnd = pageLimit < windowEnd ? pageLimit : windowEnd;
    const url = `${BASE}/products/${encodeURIComponent(productId)}/candles`
      + `?granularity=86400&start=${windowStart}T00:00:00Z&end=${pageEnd}T00:00:00Z`;
    const result = await get(url);

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

module.exports = {
  id: 'coinbase-exchange',
  label: 'Coinbase',
  limiter: 'coinbase',
  emptyReason: 'no candles',

  supports(request) {
    return request.parsed.kind === 'native' && Boolean(request.native?.coinbaseProduct);
  },

  async fetchDaily(request, window) {
    const result = await dailyCandles(request.native.coinbaseProduct, window.from, window.to);
    if (result.points && result.points.length) {
      return {
        ...result,
        provider: 'coinbase-exchange',
        // A page walk that died partway carries `partial`, and it has to carry
        // a status too: the pages that landed are real closes, but the window
        // is not covered and must not be ticked as such.
        status: result.partial ? 'range_limited' : undefined,
      };
    }
    return {
      ...result,
      status: result.unlisted ? 'unlisted' : Array.isArray(result.points) ? 'empty' : 'error',
      provider: null,
      detail: result.error || result.detail || 'no candles',
    };
  },

  PAGE_DAYS,
};
