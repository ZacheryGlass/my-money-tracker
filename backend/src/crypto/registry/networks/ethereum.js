'use strict';

// Ethereum mainnet. Network files are DATA: config/chains.js is the facade
// every caller reads through. `shortName`, `nativeAsset` and `id` are
// persisted keys (holding names, price/reconciliation keys) -- never edit them
// on an existing network; rename the display text via `name`.
module.exports = {
  order: 10,
  id: 1,
  caip2: 'eip155:1',
  family: 'evm',
  name: 'Ethereum',
  // Suffix used in holding names. Mainnet has none: its holdings must keep
  // the exact names they already have (see ethHoldingName).
  shortName: 'Ethereum',
  nativeAsset: 'ETH',
  // How the native symbol is priced. Declared once per symbol across all
  // networks (ETH here, not on every L2). `historyStart` is the earliest date
  // the FALLBACK provider serves, probed live against the candles endpoint.
  nativeAssetPricing: {
    coingeckoId: 'ethereum',
    coinbaseProduct: 'ETH-USD',
    historyStart: '2016-05-18',
  },
  // CoinGecko asset-platform slug, confirmed live against
  // /api/v3/asset_platforms by chain_identifier. A token contract looked up
  // on the wrong platform returns nothing, which reads as "unpriced" rather
  // than as an error -- so these are verified, not guessed.
  coingeckoPlatform: 'ethereum',
  enabledByDefault: true,
  rpc: {
    consensus: { env: 'ETHEREUM_RPC_URL', default: 'https://ethereum-rpc.publicnode.com' },
    // Optional parity-style trace endpoint. Keep this separate from the
    // consensus endpoint: many public RPCs expose balances and receipts but
    // reject trace_filter, and silently treating that as an exhaustive source
    // would hide internal-value gaps.
    trace: { env: 'ETHEREUM_TRACE_RPC_URL', default: null },
  },
  explorer: { baseUrl: 'https://etherscan.io', txPath: '/tx/{hash}', addressPath: '/address/{address}' },
  // Exchange/provider spellings of this network (lowercased; punctuation and
  // parenthesized suffixes are stripped before lookup).
  exchangeAliases: ['ethereum', 'ethereum mainnet', 'mainnet', 'erc20'],
  audit: {},
};
