'use strict';

// The declared waterfall: which providers price which kind of asset, in order.
// Adding a price provider is one file under providers/ plus its id here.
//
// A route is asked in order and the first provider with closes wins. When all
// of them fail, each provider's retryNarrowed() gets a last chance (CoinGecko
// re-asks the year its free plan serves). A one-provider route records that
// provider's own verdict; a longer one records the combined verdict (see
// pricing/index.js).
const ROUTES = Object.freeze({
  // A declared alias (config/tokenPriceAliases.js) outranks the token route
  // outright: it exists only for a (chain, contract) CoinGecko can never serve,
  // so asking there first would spend a guaranteed refusal per asset per run.
  alias: Object.freeze(['bitfinex']),
  // CoinGecko first (one call covers any window on a paid key), Coinbase
  // Exchange when the plan refuses the dates -- which on a free key is every
  // date older than a year, i.e. exactly the history the series exists for.
  native: Object.freeze(['coingecko', 'coinbase-exchange']),
  // Tokens have only CoinGecko's contract endpoint.
  erc20: Object.freeze(['coingecko']),
});

function routeFor(request) {
  return request.alias ? 'alias' : request.parsed.kind;
}

module.exports = { ROUTES, routeFor };
