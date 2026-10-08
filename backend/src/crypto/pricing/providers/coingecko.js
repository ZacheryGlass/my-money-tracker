'use strict';

// CoinGecko: the native assets' first source and the tokens' only one.
//
// /coins/{id}/market_chart/range                         (native assets)
//    https://docs.coingecko.com/reference/coins-id-market-chart-range
//    - Granularity is automatic and NOT requestable on a free key: 5-minutely
//      for the current day, hourly for a 2-90 day span, DAILY above 90 days.
//      A backfill window is years wide, so it answers daily, which is exactly
//      the resolution the series stores. One call per asset per window.
//    - PUBLIC AND DEMO KEYS ARE CAPPED AT 365 DAYS OF HISTORY. A January 2017
//      request answers HTTP 401 with error_code 10012 ("Public API users are
//      limited to querying historical data within the past 365 days"). That is
//      a plan entitlement: a paid key serves the whole history from this one
//      endpoint, which is why it stays first in the native route.
//    - Demo plan: 30 calls/min, 10,000 calls/month.
//
// /coins/{platform}/contract/{contract}/market_chart/range   (tokens)
//    https://docs.coingecko.com/reference/contract-address-market-chart-range
//    The ONLY token option, because a token's identity is a contract on a chain
//    and no fiat-pair venue has a notion of one. The platform slug comes from
//    the network registry's coingeckoPlatform, per chain: the SAME address is a
//    different asset on each chain, and looking one up on the wrong platform
//    answers HTTP 404 "coin not found" -- recorded as `unlisted` for THAT
//    (chain, contract) pair only, never as a global verdict.
//
// Host and key header come from utils/coingecko: demo and pro are two different
// hosts with two different header names, and pairing them wrong is ignored
// rather than rejected -- which would leave a paid key silently capped at the
// 365 days it was bought to escape.

const axios = require('axios');
const SecretsService = require('../../../services/SecretsService');
const chains = require('../../../config/chains');
const coingecko = require('../../../utils/coingecko');
const logger = require('../../../config/logger');
const { throttled } = require('../limiter');
const { dateToUnix, addDays, todayUtc, maxDate } = require('../daily');

const REQUEST_TIMEOUT_MS = 15000;

// CoinGecko's 365-day refusal. HTTP 401 + this code, distinct from a bad key.
const RANGE_LIMIT_CODE = 10012;
// One day inside the documented 365, so a request that straddles midnight UTC
// while the clock ticks over cannot land one day outside the cap.
const FREE_HISTORY_DAYS = 364;

const EMPTY_REASON = 'CoinGecko returned an empty series';

// A 429 is a verdict on the RUN, not on the asset.
//
// The asset is fine; the key is out of budget for the minute, and every call
// after it would be refused too. Recording that as `error` per asset would
// write a provider verdict the provider never gave, and -- worse -- it would
// mark each asset as checked, so a run that got rate-limited at asset 31 would
// look exactly like one that examined all 200. So the queue is shut for the
// rest of the run (later calls short-circuit, spending no network and no wall
// clock) and the affected assets keep their PREVIOUS coverage row, which leaves
// them due again next run. Spot lookups ignore the pause: it is the backfill
// run's state, and the run that set it may be hours old.
let paused = false;

async function authHeaders() {
  const headers = { accept: 'application/json' };
  // Late-bound: tests replace getAppSetting by property assignment.
  const apiKey = await SecretsService.getAppSetting('cg_api_key');
  if (apiKey) headers[coingecko.keyHeader()] = apiKey;
  return headers;
}

// Non-throwing GET. The BODY is the interesting part of a failure here -- a
// 401 carrying error_code 10012 is "your plan stops at 365 days", which is a
// coverage verdict, while a 401 without it is a bad key and a 404 is an asset
// that does not exist. Throwing would flatten all three into "error" and the
// job would re-probe a permanently unlistable token every night.
async function get(url) {
  // The queue is shut for this run: answer without calling, so the remaining
  // assets cost nothing and are recorded as "not asked" rather than "failed".
  if (paused) {
    return {
      ok: false,
      status: 429,
      rateLimited: true,
      message: 'CoinGecko rate limit reached earlier in this run',
    };
  }

  const headers = await authHeaders();
  try {
    const response = await throttled('coingecko', () => axios.get(url, { timeout: REQUEST_TIMEOUT_MS, headers }));
    return { ok: true, status: response.status, data: response.data };
  } catch (error) {
    const status = error.response?.status ?? null;
    const body = error.response?.data ?? null;
    const errorCode = body?.status?.error_code ?? body?.error?.status?.error_code ?? null;
    if (status === 429) {
      paused = true;
      logger.warn({ url }, 'CoinGecko rate limit hit; pausing its queue for the rest of this run');
      return { ok: false, status, errorCode, rateLimited: true, data: body, message: error.message };
    }
    return { ok: false, status, errorCode, data: body, message: error.message };
  }
}

// One range request. Returns a verdict, never a throw:
//   { points }                     -- observations, possibly empty
//   { rangeLimited: true }         -- the plan will not serve dates this old
//   { rateLimited: true }          -- the KEY is out of budget; not this asset's
//                                     problem, and no coverage row is written
//   { unlisted: true }             -- the provider has no such asset
//   { error }                      -- transient; retried next run
async function range(pathSegment, from, to) {
  const url = `${coingecko.baseUrl()}/${pathSegment}/market_chart/range`
    + `?vs_currency=usd&from=${dateToUnix(from)}&to=${dateToUnix(to) + 86399}`;
  const result = await get(url);

  if (result.ok) {
    const prices = Array.isArray(result.data?.prices) ? result.data.prices : null;
    // An off-shape 200 is a transport failure, never an empty series -- the
    // same rule the method-signature cache applies to Sourcify. Storing "no
    // prices" for a healthy asset would freeze it unpriced until someone
    // noticed.
    if (!prices) return { error: 'CoinGecko returned no prices array' };
    return { points: prices };
  }
  if (result.rateLimited) {
    return { rateLimited: true, detail: `CoinGecko rate limited: ${result.message}` };
  }
  if (result.errorCode === RANGE_LIMIT_CODE) {
    return { rangeLimited: true, detail: 'CoinGecko plan serves only the last 365 days' };
  }
  if (result.status === 404) {
    return { unlisted: true, detail: 'CoinGecko has no series for this asset' };
  }
  return { error: `CoinGecko HTTP ${result.status ?? '?'}: ${result.message}` };
}

// A token is asked against ITS CHAIN's asset platform. Never a pooled lookup:
// the same contract address is a different asset per chain (039).
function pathFor(request) {
  if (request.parsed.kind === 'native') return `coins/${request.native.coingeckoId}`;
  const platform = chains.getChain(request.parsed.chainId)?.coingeckoPlatform;
  return platform ? `coins/${platform}/contract/${request.parsed.contract}` : null;
}

// This provider's own verdict on a failed range: what the asset's coverage
// says when CoinGecko is the only source asked.
function verdict(result) {
  if (result.unlisted) return { status: 'unlisted', provider: null, detail: result.detail };
  if (result.rangeLimited) return { status: 'range_limited', provider: null, detail: result.detail };
  // Out of budget for the minute: not an asset verdict, and no coverage row.
  if (result.rateLimited) return { status: 'rate_limited', provider: null, detail: result.detail };
  // A well-formed 200 carrying an empty prices array. NOT an error: the
  // provider answered, and it answered "nothing". Recording it as `error`
  // re-probed the same dead contract every single night, which is precisely
  // what the coverage table exists to stop -- so it gets `empty`, rechecked
  // on the same slow cadence as `unlisted` (a series can appear later).
  if (Array.isArray(result.points)) return { status: 'empty', provider: 'coingecko', detail: EMPTY_REASON };
  return { status: 'error', provider: null, detail: result.error || EMPTY_REASON };
}

module.exports = {
  id: 'coingecko',
  label: 'CoinGecko',
  limiter: 'coingecko',
  emptyReason: EMPTY_REASON,

  supports(request) {
    return request.parsed.kind === 'native' ? Boolean(request.native?.coingeckoId) : request.parsed.kind === 'erc20';
  },

  async fetchDaily(request, window) {
    const pathSegment = pathFor(request);
    if (!pathSegment) {
      // A wrong platform answers 404, which would be recorded as a permanent
      // `unlisted` verdict against a perfectly listed token -- so no request.
      return {
        status: 'unlisted',
        provider: null,
        detail: `Chain ${request.parsed.chainId} has no CoinGecko asset platform in the registry`,
      };
    }
    const result = await range(pathSegment, window.from, window.to);
    if (result.points && result.points.length) return { ...result, provider: 'coingecko' };
    return { ...result, ...verdict(result) };
  },

  // The 365-day cap is a property of the WINDOW, not of the asset: the same
  // call that is refused for 2017 succeeds for the last year. Asked only after
  // every provider in the route has failed, so a native series stays on one
  // source (Coinbase covers the whole window back to 2016) instead of splicing
  // a year of CoinGecko onto a decade of Coinbase at an invisible seam -- and
  // for a token, which has no second source, it is the difference between "no
  // prices at all" and "the prices the plan will serve". Recorded
  // range_limited either way, so the older rows stay honestly unpriced.
  async retryNarrowed(request, window, failed) {
    if (!failed.rangeLimited) return null;
    const narrowed = maxDate(window.from, addDays(todayUtc(), -FREE_HISTORY_DAYS));
    // Already inside the cap and still refused: narrowing changes nothing, and
    // a second guaranteed refusal per asset per night is pure waste.
    if (narrowed <= window.from || narrowed > window.to) return null;
    const retry = await range(pathFor(request), narrowed, window.to);
    return retry.points && retry.points.length ? { ...retry, servedFrom: narrowed } : null;
  },

  resetRun() {
    paused = false;
  },

  // Spot and list lookups for PriceService: same key, same header, same queue.
  // `url` may be a demo-host literal; it moves onto the pro host when the plan
  // says so. Throws on transport errors, like the axios call it replaces.
  async fetchJson(url, { timeout = REQUEST_TIMEOUT_MS } = {}) {
    const headers = await authHeaders();
    return throttled('coingecko', () => axios.get(coingecko.withPlanHost(url), { timeout, headers }));
  },

  RANGE_LIMIT_CODE,
  FREE_HISTORY_DAYS,
};
