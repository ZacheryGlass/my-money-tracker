'use strict';

const { isPro: coinGeckoIsPro } = require('../../utils/coingecko');
const providerCalls = require('../infra/providerCalls');

// One throttle PER PROVIDER, process-wide across every caller -- the same shape
// and for the same reason as config/etherscan.js (the nightly job walks tens of
// assets and a user-triggered sync can land on top of it, so the spacing has to
// be a property of the process rather than of one loop), but NOT one shared
// spacing: the providers' limits differ by an order of magnitude.
//
//   * CoinGecko demo: 30 calls/min. A single 250 ms queue is 240 calls/min --
//     eight times the limit -- so with a 200-asset budget the first thirty
//     assets would succeed and every one after them would 429, night after
//     night, always the same thirty. 2100 ms is 28 calls/min, just under.
//     The spot price lookups (PriceService) share this queue: the limit is
//     the key's, not the caller's.
//   * CoinGecko pro: the paid tiers start at 500 calls/min, so a pro key drops
//     to the same 250 ms as everything else -- otherwise paying for the plan
//     would buy a 7-minute walk of a 200-asset budget.
//   * Coinbase Exchange: ~10 req/s public. 250 ms is far under it.
//   * Bitfinex public: the venue documents ~30 req/min on the candles route,
//     the SAME budget as CoinGecko's demo tier -- so it gets the same 2100 ms
//     (28/min), not 250 ms, which is 240/min: eight times the limit. The alias
//     map being hand-sized makes the gap cheap, not the rate legal.
//
// Mutable and exported so the test suite can zero the spacing: the fake axios
// makes the calls free, and a real 2.1 s gap between them would add minutes to
// the suite for no coverage. A provider added later registers its own key.
const PROVIDER_SPACING_MS = {
  coingecko: 2100,
  coingeckoPro: 250,
  coinbase: 250,
  bitfinex: 2100,
};

function spacingFor(key) {
  if (key === 'coingecko') {
    return coinGeckoIsPro() ? PROVIDER_SPACING_MS.coingeckoPro : PROVIDER_SPACING_MS.coingecko;
  }
  return PROVIDER_SPACING_MS[key] ?? PROVIDER_SPACING_MS.coinbase;
}

function registerSpacing(key, ms) {
  if (!(key in PROVIDER_SPACING_MS)) PROVIDER_SPACING_MS[key] = ms;
}

const queues = new Map();

function throttled(key, fn) {
  const run = (queues.get(key) || Promise.resolve()).then(() => {
    providerCalls.record(`price:${key}`);
    return fn();
  });
  queues.set(key, run
    .catch(() => {})
    .then(() => new Promise((resolve) => setTimeout(resolve, spacingFor(key)))));
  return run;
}

module.exports = { PROVIDER_SPACING_MS, spacingFor, registerSpacing, throttled };
