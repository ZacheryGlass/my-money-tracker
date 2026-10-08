'use strict';

// The chains an Ethereum wallet address is synced across. Most use Etherscan
// API V2 from one host and one key, selected per request by the `chainid`
// param. A chain may instead declare `accountApi`: the same five account-feed
// contract is then served by that per-chain explorer, either through its
// Etherscan-compatible API or a declared adapter. Every provider still shares
// its provider-host queue in ./etherscan.js; adding chains must not multiply
// the request rate against the same explorer.
//
// EVERY ENTRY BELOW WAS PROBED LIVE, not taken from documentation:
// GET https://api.etherscan.io/v2/chainlist (64 chains served), then each of
// txlist / txlistinternal / tokentx / tokennfttx / token1155tx / balance run
// once per chain against that chain's canonical WETH contract AND a
// broadly-active EOA, so an empty feed could not be mistaken for a missing one.
// What that turned up, and why this table looks the way it does:
//
//   * zkSync Era (324) is not served by Etherscan V2. Its official explorer
//     supplies native normal/internal history and the indexed head, Blockscout
//     supplies token/NFT feeds, and public JSON-RPC supplies live balances.
//   * zkSync Lite has no EIP-155 id because it predates the EVM-compatible Era
//     chain. It uses reserved app id 32401 and a dedicated read-only importer
//     for Matter Labs' v0.2 archive. Keeping it in this registry gives the
//     unified ledger, holdings, filters and notes an explicit chain identity.
//   * Arbitrum One and Linea have FULL feed parity with mainnet, txlistinternal
//     included. That matters more than it looks: internal traces are how ETH
//     arriving from a contract is seen at all, so a chain without them silently
//     drifts away from its own derived balance.
//   * OP Mainnet (10) remains on its public Blockscout instance.
//     A per-transaction receipt decoder records native bridge credits, so
//     no chain-wide anonymous bridge-log walk is part of the critical path.
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
// Explorer links are data in each network file and reach the client through
// GET /api/crypto/meta; frontend/src/utils/chains.js renders them.
function configuredRpcUrl(name, fallback) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

// The registry is the network files in crypto/registry/networks/ (one file per
// network); this module is the facade every caller reads through. Each entry
// keeps the shape callers have always seen -- the network file minus its
// registry-only fields, with RPC endpoints resolved from the environment.
const networks = require('../crypto/registry/networks');

function registryEntry(network) {
  const { order, rpc, nativeAssetPricing, ...entry } = network;
  void order; void nativeAssetPricing;
  const copy = JSON.parse(JSON.stringify(entry));
  if (rpc) {
    copy.consensusRpcUrl = configuredRpcUrl(rpc.consensus.env, rpc.consensus.default);
    copy.traceRpcUrl = configuredRpcUrl(rpc.trace.env, rpc.trace.default);
  }
  return copy;
}

const REGISTRY = networks.active.map(registryEntry);

// How each native asset is PRICED, keyed by the symbol chains carry in
// `nativeAsset` (declared once per symbol in the network files). Keyed by
// symbol rather than by chain because the asset is the thing being priced:
// ETH is one asset whether it moved on mainnet, Arbitrum or Linea, and pricing
// it per chain would fetch the same series four times and store four copies
// of it under four keys.
//
// The symbol IS the asset_price_history key (see utils/assetPriceKey.js), which
// is what makes adding a chain free of any data migration: every stored 'ETH'
// row stays correct, and a new symbol simply has no rows yet.
const NATIVE_ASSETS = networks.nativeAssets;

// Mainnet. The default for every chain-aware call, so that a caller which has
// no chain to pass keeps behaving exactly as it did before #58.
const DEFAULT_CHAIN_ID = 1;

// Chains this app once supported and has retired (082 removed Base). A retired
// id must never be re-attached to new data: imports store the provider's
// network text but no normalized chain id for it.
const RETIRED_CHAIN_IDS = Object.freeze(networks.retired.map((network) => network.id));
function isRetiredChain(chainId) {
  return RETIRED_CHAIN_IDS.includes(Number(chainId));
}

const BY_ID = new Map(REGISTRY.map((chain) => [chain.id, chain]));

// Every native symbol in the registry. The price-key parser needs this to tell
// a native key from anything else, and it must come from the registry rather
// than a second list, or a chain could be added whose native asset no reader
// recognises.
const NATIVE_SYMBOLS = new Set(REGISTRY.map((chain) => chain.nativeAsset));

// `ETH_CHAINS=1` restores strict mainnet-only sync; `ETH_CHAINS=1,42161,10`
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

const ACCOUNT_FEED_ACTION = Object.freeze({
  normal: 'txlist',
  internal: 'txlistinternal',
  token: 'tokentx',
  nft: 'tokennfttx',
  nft1155: 'token1155tx',
});
const NATIVE_HISTORY_ACTIONS = new Set(['txlist', 'txlistinternal', 'getblockreward']);
const ACCOUNT_HISTORY_ROUTE_ACTIONS = Object.freeze([
  'txlist', 'txlistinternal', 'getblockreward',
  'tokentx', 'tokennfttx', 'token1155tx',
]);
const ACCOUNT_HISTORY_CAPABILITY_ACTION = Object.freeze({
  normal: 'txlist',
  internal: 'txlistinternal',
  erc20: 'tokentx',
  erc721: 'tokennfttx',
  erc1155: 'token1155tx',
});

// Canonical route selection for every Etherscan-shaped account request. Keep
// transport callers, audit provenance, and completion checks on this function
// so a split provider cannot drift into three subtly different route tables.
function accountApiForAction(chainId, action = null) {
  const accountApi = getChain(chainId)?.accountApi;
  if (!accountApi) return null;
  if (accountApi.nativeHistoryApi && NATIVE_HISTORY_ACTIONS.has(action)) {
    return { ...accountApi, ...accountApi.nativeHistoryApi };
  }
  return accountApi;
}

function accountApiForFeed(chainId, feed = null) {
  return accountApiForAction(chainId, ACCOUNT_FEED_ACTION[feed] || null);
}

function accountApiEndpointForAction(chainId, action = null) {
  const accountApi = accountApiForAction(chainId, action);
  if (!accountApi) return null;
  const usesV2 = (action === 'txlist' && accountApi.v2NormalTransactions)
    || (action === 'txlistinternal' && accountApi.v2InternalTransactions);
  return usesV2 ? accountApi.v2BaseUrl : accountApi.baseUrl;
}

function accountApiEndpointForFeed(chainId, feed = null) {
  return accountApiEndpointForAction(chainId, ACCOUNT_FEED_ACTION[feed] || null);
}

function accountApiProviderForAction(chainId, action = null) {
  const chain = getChain(chainId);
  if (chain?.historyProvider) return String(chain.historyProvider).toLowerCase();
  return String(accountApiForAction(chainId, action)?.provider || 'Etherscan').toLowerCase();
}

// Canonical account-history route manifest consumed by sync, audit, and the
// completion reporter. Split-provider chains such as zkSync must have one
// source of truth for both transport and persisted provenance.
function accountApiRoutes(chainId) {
  const chain = getChain(chainId);
  if (chain?.historyProvider) {
    return [{ provider: String(chain.historyProvider).toLowerCase(), baseUrl: null }];
  }
  const routes = ACCOUNT_HISTORY_ROUTE_ACTIONS.map((action) => ({
    provider: accountApiProviderForAction(chainId, action),
    baseUrl: accountApiEndpointForAction(chainId, action),
  }));
  return [...new Map(routes.map((route) => [
    `${route.provider}:${route.baseUrl || ''}`, route,
  ])).values()];
}

function accountApiProviders(chainId) {
  return new Set(accountApiRoutes(chainId).map((route) => route.provider));
}

function accountApiHistoryProvider(chainId) {
  const providers = [...accountApiProviders(chainId)];
  return providers.length > 1 ? 'explorer-composite' : providers[0];
}

function accountApiProviderManifest(chainId) {
  const historyProvider = accountApiHistoryProvider(chainId);
  return {
    active_chain: historyProvider,
    wallet_history: historyProvider,
    coverage_boundary: historyProvider,
    native_indexed_head: accountApiProviderForAction(chainId, 'getblockreward'),
    token_indexed_head: accountApiProviderForAction(chainId, 'tokentx'),
    ...Object.fromEntries(Object.entries(ACCOUNT_HISTORY_CAPABILITY_ACTION).map(
      ([capability, action]) => [capability, accountApiProviderForAction(chainId, action)]
    )),
  };
}

// The default Etherscan transport needs the user's key; a chain-declared
// account API can explicitly be keyless. Orchestration gates use this rather
// than assuming every enabled chain needs Etherscan credentials.
function accountApiRequiresKey(chainId) {
  const chain = getChain(chainId);
  if (chain?.requiresApiKey === false) return false;
  if (!chain?.accountApi) return true;
  return ['txlist', 'tokentx'].some(
    (action) => accountApiForAction(chainId, action)?.requiresApiKey !== false
  );
}

// Exact provenance string persisted in eth_feed_coverage. Keep sync writers
// and completion readers on one formatter so a provider route change cannot
// leave old evidence looking current.
function accountHistoryProviderName(chainId, feed = null) {
  const chain = getChain(chainId);
  if (!chain) return null;
  if (chain.historyProvider === 'zksync-lite') {
    return 'Matter Labs zkSync Lite archive';
  }
  const accountApi = accountApiForFeed(chainId, feed);
  if (accountApi) {
    const accountUrl = accountApiEndpointForFeed(chainId, feed);
    return `${accountApi.provider || 'chain explorer'} (${accountUrl})`;
  }
  return 'Etherscan V2';
}

function enabledChainsRequireApiKey() {
  return enabledChains().some((chain) => accountApiRequiresKey(chain.id));
}

// The whole registry with each entry's current enablement. No runtime caller:
// this is the introspection entry point the registry tests assert against --
// claims about provider routing and default enablement need to see entries that
// enabledChains() by definition can hide.
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
  RETIRED_CHAIN_IDS,
  isRetiredChain,
  NATIVE_ASSETS,
  enabledChains,
  enabledChainIds,
  enabledChainsRequireApiKey,
  accountApiForAction,
  accountApiHistoryProvider,
  accountApiProviderForAction,
  accountApiProviderManifest,
  accountApiProviders,
  accountApiRoutes,
  accountApiRequiresKey,
  accountHistoryProviderName,
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
