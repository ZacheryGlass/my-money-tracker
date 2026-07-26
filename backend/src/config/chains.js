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
//
// Native asset is ETH on all of them, which is what lets one shared price_cache
// 'ETH' row value every chain's balance.
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

// Mainnet. The default for every chain-aware call, so that a caller which has
// no chain to pass keeps behaving exactly as it did before #58.
const DEFAULT_CHAIN_ID = 1;

const BY_ID = new Map(REGISTRY.map((chain) => [chain.id, chain]));

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

// The ETH holding's name on a given chain. Mainnet returns 'Ethereum'
// verbatim -- the name every existing wallet's ETH holding already has, and
// holdings are matched by name, so changing it would strand the old row and
// insert a duplicate beside it for every user on earth.
function ethHoldingName(chainId) {
  if (Number(chainId) === DEFAULT_CHAIN_ID) return 'Ethereum';
  return `ETH (${getChain(chainId)?.shortName || `Chain ${chainId}`})`;
}

// Chain context appended to a token holding's name. Empty on mainnet for the
// same reason ethHoldingName is: those names must not move.
function holdingSuffix(chainId) {
  if (Number(chainId) === DEFAULT_CHAIN_ID) return '';
  return ` (${getChain(chainId)?.shortName || `Chain ${chainId}`})`;
}

module.exports = {
  DEFAULT_CHAIN_ID,
  enabledChains,
  enabledChainIds,
  allChains,
  getChain,
  isEnabled,
  chainLabel,
  ethHoldingName,
  holdingSuffix,
};
