'use strict';

// TOKEN PRICE ALIASES -- declared routes for tokens whose (chain, contract)
// identity CoinGecko's contract endpoint cannot price AT ALL, keyed by the
// exact asset_price_history asset key (utils/assetPriceKey.js). Registry-style
// data like chains.NATIVE_ASSETS: HistoricalPriceService consumes it, and a
// new entry is data, not code.
//
// An aliased asset SKIPS the CoinGecko contract endpoint entirely and takes a
// keyless Bitfinex daily-candle series instead, stored under the SAME asset
// key. This is an escape hatch, not a fallback ladder: only an asset the
// normal path can NEVER serve belongs here, because an alias silently
// outranks whatever CoinGecko might start serving later.
//
// Every entry is the outcome of live probes, not documentation. The one entry
// so far, probed 2026-07-28:
//
//   erc20:1:0x86fa04... -- the 2017-18 EOS ERC-20 crowdsale token.
//     * CoinGecko contract endpoint: {"error":"coin not found"}. The coin id
//       'eos' exists but is keyed to the native chain, not this contract --
//       and a demo key 401s (error_code 10012) beyond 365 days anyway, which
//       is every date this token traded on.
//     * Coinbase Exchange: EOS-USD listed 2019; no candles for 2017-18.
//     * Binance klines: api.binance.com refuses this region outright
//       ("Service unavailable from a restricted location"), and the public
//       market-data host (data-api.binance.vision) serves EOSUSDT only from
//       2018-05-28 -- AFTER the window the ledger needs ends.
//     * CryptoCompare min-api: now answers 401 "API key required" keyless.
//     * Bitfinex tEOSUSD: keyless, a real USD quote, daily candles from
//       2017-07-01 (first candle probed live at MTS 1498867200000). Chosen.

const { parseAssetKey } = require('../utils/assetPriceKey');

const TOKEN_PRICE_ALIASES = {
  // The EOS ERC-20 crowdsale token. A public, well-known contract.
  'erc20:1:0x86fa049857e0209aa7d9e616f7eb3b3b78ecfdb0': {
    // Bitfinex v2 trading-pair symbol, exactly as the candles endpoint spells
    // it (the leading 't' is part of the symbol).
    bitfinexSymbol: 'tEOSUSD',
    // The venue's first daily candle, probed live -- the fetch window clamps
    // to it, and every ledger date before it stays range_limited: reported
    // missing, never fabricated.
    historyStart: '2017-07-01',
  },
};

// The exact spelling the candles endpoint takes: the leading 't' is part of
// the symbol, the pair is upper-case, and a ':' separates long-form pairs
// (tBTC:CNHT). Anything else builds a URL for a pair the venue never listed.
const BITFINEX_SYMBOL_RE = /^t[A-Z0-9:]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// VALIDATED AT REQUIRE TIME. Every entry is hand-typed data, and each field
// has a silent failure mode that only shows up nights later as a coverage
// oddity rather than at the edit that caused it:
//   * a checksummed (or otherwise non-lowercase) KEY never matches -- the
//     work list emits lowercase asset keys, so the alias is simply skipped and
//     the token quietly takes the CoinGecko path the alias exists to escape.
//     Thrown, not normalized: the source file stays canonical.
//   * a missing/garbled historyStart yields a permanent range_limited with
//     detail "series starts undefined".
//   * a typo'd bitfinexSymbol GETs .../trade:1D:undefined/hist.
// A throw here fails the boot and the whole test suite instead.
function validateAliases(aliases) {
  for (const [assetKey, entry] of Object.entries(aliases)) {
    const parsed = parseAssetKey(assetKey);
    if (!parsed || parsed.kind !== 'erc20' || assetKey !== assetKey.toLowerCase()) {
      throw new Error(
        `tokenPriceAliases: key "${assetKey}" must be a lowercase erc20:<chain_id>:<0xaddr> asset key`
        + ' (a checksummed address would silently never match the lowercase work list)'
      );
    }
    if (!entry || typeof entry.bitfinexSymbol !== 'string'
        || !BITFINEX_SYMBOL_RE.test(entry.bitfinexSymbol)) {
      throw new Error(
        `tokenPriceAliases: entry for "${assetKey}" needs a bitfinexSymbol matching`
        + ` ${BITFINEX_SYMBOL_RE} (got ${JSON.stringify(entry && entry.bitfinexSymbol)})`
      );
    }
    if (typeof entry.historyStart !== 'string' || !ISO_DATE_RE.test(entry.historyStart)
        || !Number.isFinite(Date.parse(`${entry.historyStart}T00:00:00Z`))) {
      throw new Error(
        `tokenPriceAliases: entry for "${assetKey}" needs an ISO YYYY-MM-DD historyStart`
        + ` (got ${JSON.stringify(entry && entry.historyStart)})`
      );
    }
  }
  return aliases;
}

validateAliases(TOKEN_PRICE_ALIASES);

function aliasForAssetKey(assetKey) {
  return TOKEN_PRICE_ALIASES[String(assetKey || '')] || null;
}

module.exports = { TOKEN_PRICE_ALIASES, aliasForAssetKey, validateAliases };
