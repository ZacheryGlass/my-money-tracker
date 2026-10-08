'use strict';

// Historical price providers: every file under providers/ is one provider,
// asked in the order pricing/order.js declares.
//
// Provider contract:
//   id                  persisted as asset_price_history.source and
//                       asset_price_coverage.provider
//   label               names the provider in a combined coverage detail
//   limiter             its queue key in pricing/limiter.js (spacingMs
//                       registers a new key)
//   supports(request)   whether it can be asked about this asset at all
//   fetchDaily(request, window)
//                       { points, status?, partial?, detail? } on success,
//                       { status, provider, detail } on failure, where status
//                       is a coverage verdict (or 'rate_limited', which writes
//                       no coverage row). Never throws for a provider answer.
//   retryNarrowed?(request, window, failedOutcome)
//                       { points, servedFrom } or null; asked only after the
//                       whole route failed
//   resetRun?()         clears per-run state (a rate-limit pause)
//
// request: { parsed (utils/assetPriceKey), native (registry native asset
// entry or null), alias (tokenPriceAliases entry or null) }.
//
// CRYPTO_EXTRA_PRICE_PROVIDERS_DIR adds a second directory, for the
// extensibility acceptance test; a provider there declares `routes` to append
// itself to.

const fs = require('fs');
const path = require('path');
const { ROUTES, routeFor } = require('./order');
const { registerSpacing } = require('./limiter');

function loadDir(dir) {
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => require(path.join(dir, name)));
}

const PROVIDERS = new Map();
for (const provider of [
  ...loadDir(path.join(__dirname, 'providers')),
  ...(process.env.CRYPTO_EXTRA_PRICE_PROVIDERS_DIR
    ? loadDir(path.resolve(process.env.CRYPTO_EXTRA_PRICE_PROVIDERS_DIR)) : []),
]) {
  if (!provider.id || !provider.label || typeof provider.supports !== 'function'
      || typeof provider.fetchDaily !== 'function') {
    throw new Error('a price provider needs an id, a label, supports() and fetchDaily()');
  }
  if (PROVIDERS.has(provider.id)) throw new Error(`duplicate price provider ${provider.id}`);
  if (provider.spacingMs != null) registerSpacing(provider.limiter || provider.id, provider.spacingMs);
  PROVIDERS.set(provider.id, provider);
}

const RESOLVED = {};
for (const [route, ids] of Object.entries(ROUTES)) {
  RESOLVED[route] = ids.map((id) => {
    if (!PROVIDERS.has(id)) throw new Error(`price route ${route} names unknown provider ${id}`);
    return PROVIDERS.get(id);
  });
}
for (const provider of PROVIDERS.values()) {
  for (const route of provider.routes || []) {
    if (!RESOLVED[route]) throw new Error(`price provider ${provider.id} names unknown route ${route}`);
    if (!RESOLVED[route].includes(provider)) RESOLVED[route].push(provider);
  }
}

// "CoinGecko plan serves only the last 365 days; Coinbase: no candles" -- the
// first reason bare, every later one named.
function describe(attempts) {
  return attempts.map(({ provider, outcome }, index) => {
    const reason = outcome.detail || provider.emptyReason || `${provider.label} returned nothing`;
    return index === 0 ? reason : `${provider.label}: ${reason}`;
  }).join('; ');
}

// Several providers all failed. A plan cap anywhere means older rows are
// honestly unpriced; a rate limit with nobody else answering means nothing was
// learned at all; every provider answering cleanly with no closes is an EMPTY
// series, a coverage verdict that must not be re-probed nightly; the rest is
// transient.
function combinedStatus(attempts) {
  const statuses = attempts.map(({ outcome }) => outcome.status);
  if (statuses.includes('range_limited')) return 'range_limited';
  if (statuses.includes('rate_limited') && !statuses.includes('empty')) return 'rate_limited';
  if (statuses.every((status) => status === 'empty')) return 'empty';
  return 'error';
}

async function fetchDaily(request, window) {
  const providers = (RESOLVED[routeFor(request)] || []).filter((provider) => provider.supports(request));
  if (!providers.length) {
    return { status: 'unlisted', provider: null, detail: 'No price provider serves this asset' };
  }

  const attempts = [];
  for (const provider of providers) {
    const outcome = await provider.fetchDaily(request, window);
    if (outcome.points && outcome.points.length) {
      const won = { ...outcome, provider: outcome.provider || provider.id };
      return attempts.length
        ? { ...won, detail: `${attempts[0].provider.label} fell through: ${describe(attempts)}` }
        : won;
    }
    attempts.push({ provider, outcome });
  }

  for (const { provider, outcome } of attempts) {
    if (typeof provider.retryNarrowed !== 'function') continue;
    const retry = await provider.retryNarrowed(request, window, outcome);
    if (retry) {
      return {
        ...retry,
        provider: provider.id,
        status: 'range_limited',
        detail: `${describe(attempts)}; served from ${retry.servedFrom}`,
      };
    }
  }

  if (attempts.length === 1) return attempts[0].outcome;
  return { status: combinedStatus(attempts), provider: null, detail: describe(attempts) };
}

function resetRun() {
  for (const provider of PROVIDERS.values()) provider.resetRun?.();
}

function provider(id) {
  return PROVIDERS.get(id) || null;
}

module.exports = { PROVIDERS, fetchDaily, resetRun, provider };
