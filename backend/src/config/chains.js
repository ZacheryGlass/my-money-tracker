'use strict';

// The chains an Ethereum wallet address is synced across. Etherscan API V2
// serves all of them from one host and one key, selected per request by the
// `chainid` param, so multi-chain sync costs no extra credentials -- only
// requests, which all share the single global throttle in ./etherscan.js.
//
// EVERY ENTRY BELOW WAS PROBED LIVE, not taken from documentation:
// GET https://api.etherscan.io/v2/chainlist (64 chains served), then each of
// txlist / txlistinternal / tokentx / tokennfttx / token1155tx / balance run
// once per chain against that chain's canonical WETH contract AND a
// broadly-active EOA, so an empty feed could not be mistaken for a missing one.
// What that turned up, and why this table looks the way it does:
//
//   * zkSync Era (324) -- named in #58 -- IS NOT SERVED AT ALL. Every action
//     answers "Missing or unsupported chainid parameter", and no zkSync/zkEVM
//     entry appears anywhere in the chainlist. It is absent below rather than
//     disabled: a disabled entry says "you may turn this on", and this one can
//     never work. Linea (59144) takes its place -- also an ETH-native Ethereum
//     L2, and it passed every feed.
//   * Arbitrum One and Linea have FULL feed parity with mainnet, txlistinternal
//     included. That matters more than it looks: internal traces are how ETH
//     arriving from a contract is seen at all, so a chain without them silently
//     drifts away from its own derived balance.
//   * OP Mainnet (10) and Base (8453) ARE in the chainlist but are gated behind
//     a paid Etherscan plan -- every action, `balance` included, answers "Free
//     API access is not supported for this chain." That is a per-key
//     entitlement, not a missing feed, so they ship present-but-disabled: the
//     day the key is upgraded they are one env var away. Enabling them on a
//     free key is not silently broken either -- the sync records
//     CHAIN_UNAVAILABLE on that chain's eth_wallet_chains row, freezes its
//     cursors, and leaves every other chain alone.
//   * Polygon PoS (137) is served on the FREE key -- balance, txlist and
//     txlistinternal all answered on a live probe, so it ships enabled. It is
//     also the first chain here that is NOT ETH-native (see NATIVE_ASSETS).
//
// !! `shortName` IS DATA, NOT A LABEL. It is baked into holding names by
// ethHoldingName/holdingSuffix, and holdings are matched by NAME (one account
// now carries several ticker='ETH' rows, so the old ticker matcher cannot tell
// them apart). Editing a shortName therefore re-keys that chain's holdings: the
// next sync inserts fresh rows beside the old ones, the originals are stranded
// with their cost basis, and NULL-ticker token snapshots -- keyed on
// (date, account, name) -- fork into two series at the rename. Rename a chain's
// display text via `name`, which nothing matches on. Mainnet's empty suffix is
// load-bearing for the same reason: pre-#58 names must stay byte-identical.
//
// `nativeAsset` IS DATA TOO, for the same reason and one more: it is the
// asset_price_history key for every native/internal/gas leg on the chain, and
// it is the holding's ticker. Changing an existing chain's would strand both.
//
// Explorer links live on the client (frontend/src/utils/chains.js): they are
// presentation derived from a chain id the API already sends.
const REGISTRY = [
  {
    id: 1,
    name: 'Ethereum',
    // Suffix used in holding names. Mainnet has none: its holdings must keep
    // the exact names they already have (see ethHoldingName).
    shortName: 'Ethereum',
    nativeAsset: 'ETH',
    // CoinGecko asset-platform slug, confirmed live against
    // /api/v3/asset_platforms by chain_identifier. A token contract looked up
    // on the wrong platform returns nothing, which reads as "unpriced" rather
    // than as an error -- so these are verified, not guessed.
    coingeckoPlatform: 'ethereum',
    enabledByDefault: true,
  },
  {
    id: 42161,
    name: 'Arbitrum One',
    shortName: 'Arbitrum',
    nativeAsset: 'ETH',
    coingeckoPlatform: 'arbitrum-one',
    enabledByDefault: true,
  },
  {
    id: 59144,
    name: 'Linea',
    shortName: 'Linea',
    nativeAsset: 'ETH',
    coingeckoPlatform: 'linea',
    enabledByDefault: true,
  },
  {
    id: 137,
    name: 'Polygon',
    shortName: 'Polygon',
    // NOT ETH. Every price, holding ticker and reconciliation key on this chain
    // follows this symbol -- see NATIVE_ASSETS for how it is priced.
    nativeAsset: 'POL',
    coingeckoPlatform: 'polygon-pos',
    enabledByDefault: true,
  },
  {
    id: 10,
    name: 'OP Mainnet',
    shortName: 'Optimism',
    nativeAsset: 'ETH',
    coingeckoPlatform: 'optimistic-ethereum',
    enabledByDefault: false,
    disabledReason: 'Etherscan serves this chain only on a paid API plan',
  },
  {
    id: 8453,
    name: 'Base',
    shortName: 'Base',
    nativeAsset: 'ETH',
    coingeckoPlatform: 'base',
    enabledByDefault: false,
    disabledReason: 'Etherscan serves this chain only on a paid API plan',
  },
];

// How each native asset is PRICED, keyed by the symbol chains carry in
// `nativeAsset`. Keyed by symbol rather than by chain because the asset is the
// thing being priced: ETH is one asset whether it moved on mainnet, Arbitrum or
// Linea, and pricing it per chain would fetch the same series four times and
// store four copies of it under four keys.
//
// The symbol IS the asset_price_history key (see utils/assetPriceKey.js), which
// is what makes adding a chain free of any data migration: every stored 'ETH'
// row stays correct, and a new symbol simply has no rows yet.
//
// `historyStart` is the earliest date the FALLBACK provider serves, not the
// asset's launch date -- it exists so the price job does not spend a run
// requesting a decade Coinbase will never return and then permanently mark the
// asset range_limited. Both were probed live against the candles endpoint.
const NATIVE_ASSETS = {
  ETH: {
    coingeckoId: 'ethereum',
    coinbaseProduct: 'ETH-USD',
    historyStart: '2016-05-18',
  },
  POL: {
    coingeckoId: 'polygon-ecosystem-token',
    coinbaseProduct: 'POL-USD',
    // Coinbase's first POL-USD daily candle. MATIC-USD history before the 2024
    // rename is a DIFFERENT product and is deliberately not stitched on: the
    // two are the same money, but a stitched series would be indistinguishable
    // from a real one while resting on an assumption nothing here verifies.
    historyStart: '2024-09-04',
  },
};

// Mainnet. The default for every chain-aware call, so that a caller which has
// no chain to pass keeps behaving exactly as it did before #58.
const DEFAULT_CHAIN_ID = 1;

const BY_ID = new Map(REGISTRY.map((chain) => [chain.id, chain]));

// Every native symbol in the registry. The price-key parser needs this to tell
// a native key from anything else, and it must come from the registry rather
// than a second list, or a chain could be added whose native asset no reader
// recognises.
const NATIVE_SYMBOLS = new Set(REGISTRY.map((chain) => chain.nativeAsset));

// `ETH_CHAINS=1` restores strict mainnet-only sync; `ETH_CHAINS=1,42161,8453`
// picks an explicit set. Parsed on every call rather than memoized: it is a
// split of a short string, and a cached copy would go stale against a test or a
// restart-free config change for no measurable gain.
//
// Unknown ids are dropped rather than honored. An id absent from the registry
// has no name, no CoinGecko platform and no probe behind it, so admitting it
// would produce holdings labelled "(undefined)" and unvalued tokens.
function enabledChainIds() {
  const raw = process.env.ETH_CHAINS;
  if (raw == null || raw.trim() === '') {
    return REGISTRY.filter((chain) => chain.enabledByDefault).map((chain) => chain.id);
  }
  const requested = raw
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((id) => Number.isInteger(id) && BY_ID.has(id));
  // An ETH_CHAINS that resolves to nothing (typo, all-unknown ids) must not
  // silently stop syncing every wallet. Mainnet is the floor.
  return requested.length ? [...new Set(requested)] : [DEFAULT_CHAIN_ID];
}

// Registry order, not env order, so sync always walks mainnet first: chain 1 is
// the one whose failure is fatal, and finding that out first avoids spending
// the throttle on four L2s before giving up.
function enabledChains() {
  const ids = new Set(enabledChainIds());
  return REGISTRY.filter((chain) => ids.has(chain.id));
}

// The whole registry with each entry's current enablement. No runtime caller:
// this is the introspection entry point the registry tests assert against (that
// 324 is absent rather than disabled, that 10/8453 ship off, that every chain is
// ETH-native with a verified CoinGecko platform) -- claims that need to see the
// disabled entries, which enabledChains() by definition cannot show.
function allChains() {
  const ids = new Set(enabledChainIds());
  return REGISTRY.map((chain) => ({ ...chain, enabled: ids.has(chain.id) }));
}

function getChain(chainId) {
  return BY_ID.get(Number(chainId)) || null;
}

function isEnabled(chainId) {
  return enabledChainIds().includes(Number(chainId));
}

// Display name for a chain id that is not in the registry. Reachable only for
// rows stored before a chain was removed from the table, which must still
// render as something a human can read.
function chainLabel(chainId) {
  return getChain(chainId)?.name || `Chain ${chainId}`;
}

// The native asset's symbol on a chain. Defaults to ETH for an id that is not
// in the registry: those are rows stored before a chain was removed, and every
// chain this app has ever synced but does not list today was ETH-native.
function nativeSymbol(chainId) {
  return getChain(chainId)?.nativeAsset || 'ETH';
}

// How to price a native symbol. Null for a symbol with no entry, which the
// price job reads as "no provider" rather than guessing one.
function nativeAssetInfo(symbol) {
  return NATIVE_ASSETS[String(symbol || '').toUpperCase()] || null;
}

function isNativeSymbol(symbol) {
  return NATIVE_SYMBOLS.has(String(symbol || '').toUpperCase());
}

// The native holding's name on a given chain. Mainnet returns 'Ethereum'
// verbatim -- the name every existing wallet's ETH holding already has, and
// holdings are matched by name, so changing it would strand the old row and
// insert a duplicate beside it for every user on earth. Every other chain reads
// its own native symbol, which is byte-identical to the old hardcoded 'ETH' for
// every chain that existed before Polygon.
function ethHoldingName(chainId) {
  if (Number(chainId) === DEFAULT_CHAIN_ID) return 'Ethereum';
  return `${nativeSymbol(chainId)} (${getChain(chainId)?.shortName || `Chain ${chainId}`})`;
}

// Chain context appended to a token holding's name. Empty on mainnet for the
// same reason ethHoldingName is: those names must not move.
function holdingSuffix(chainId) {
  if (Number(chainId) === DEFAULT_CHAIN_ID) return '';
  return ` (${getChain(chainId)?.shortName || `Chain ${chainId}`})`;
}

module.exports = {
  DEFAULT_CHAIN_ID,
  NATIVE_ASSETS,
  enabledChains,
  enabledChainIds,
  allChains,
  getChain,
  isEnabled,
  chainLabel,
  nativeSymbol,
  nativeAssetInfo,
  isNativeSymbol,
  ethHoldingName,
  holdingSuffix,
};
