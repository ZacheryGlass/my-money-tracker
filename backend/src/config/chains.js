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
//   * zkSync Era (324) is not served by Etherscan V2, but its public Blockscout
//     instance passed the same balance/txlist/txlistinternal/token/NFT probes
//     and its public JSON-RPC endpoint supplies authoritative live balances.
//   * zkSync Lite has no EIP-155 id because it predates the EVM-compatible Era
//     chain. It uses reserved app id 32401 and a dedicated read-only importer
//     for Matter Labs' v0.2 archive. Keeping it in this registry gives the
//     unified ledger, holdings, filters and notes an explicit chain identity.
//   * Arbitrum One and Linea have FULL feed parity with mainnet, txlistinternal
//     included. That matters more than it looks: internal traces are how ETH
//     arriving from a contract is seen at all, so a chain without them silently
//     drifts away from its own derived balance.
//   * OP Mainnet (10) and Base (8453) remain paid-plan-only through Etherscan,
//     so both use their public Blockscout instances instead. OP still uses the
//     Etherscan-compatible facade. Base's anonymous legacy facade began
//     returning a standing 429 in August 2026 while its documented v2 REST API
//     remained healthy, so Base has an explicit v2 adapter. A per-chain
//     ETHBridgeFinalized log feed records canonical native bridge credits
//     independently.
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
    // Classic-era (pre-Nitro) L1->L2 ETH deposits, which Etherscan's txlist
    // serves BACKWARDS. The chain's pre-Nitro history was migrated into Nitro,
    // and the migrated retryable-ticket deposit comes back as an OUTBOUND row:
    // from = the wallet, to = the ArbRetryableTx precompile, methodId =
    // createRetryableTicket, gasUsed = 0 and gasPrice = 0 -- when what actually
    // happened is the wallet was CREDITED the deposit. Ingested as-is that row
    // books a phantom native debit, so the derived balance drifts by exactly
    // twice the deposit (the credit missed plus the debit invented).
    //
    // Declared here and NOWHERE ELSE, exactly like Polygon's stateSyncDeposits:
    // a per-chain fact the txlist ingest reads off the chain object, never a
    // chain-id branch in the sync. normalizeFeeds reshapes a matching row --
    // and ONLY one whose calldata destination (createRetryableTicket's first
    // word) is the wallet itself -- into one inbound native credit from the
    // precompile. Nitro-era deposits (type 0x64 system txs) already ingest
    // correctly and never match this shape.
    //
    // All three constants are public and verified against first-party source:
    //   * arbRetryableTx -- "Precompile address: 0x...006E" on
    //     https://docs.arbitrum.io/build-decentralized-apps/precompiles/reference
    //   * lastClassicBlock -- ARB1_NITRO_GENESIS_L2_BLOCK = 22207817 in
    //     OffchainLabs/arbitrum-sdk packages/sdk/src/lib/dataEntities/constants.ts
    //   * depositMethodId -- createRetryableTicket(address,uint256,uint256,
    //     address,address,uint256,uint256,bytes), selector 0x679b6ded
    classicRetryableDeposits: {
      arbRetryableTx: '0x000000000000000000000000000000000000006e',
      lastClassicBlock: 22207817,
      depositMethodId: '0x679b6ded',
    },
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
    id: 324,
    name: 'ZKsync Era',
    shortName: 'zkSync Era',
    nativeAsset: 'ETH',
    coingeckoPlatform: 'zksync',
    enabledByDefault: true,
    accountApi: {
      provider: 'Blockscout',
      baseUrl: 'https://zksync.blockscout.com/api',
      requiresApiKey: false,
    },
    rpcUrl: 'https://mainnet.era.zksync.io',
  },
  {
    // App-internal identity. zkSync Lite was not EVM and had no EIP-155 id;
    // 324 is reserved for Era, so Lite must never reuse it.
    id: 32401,
    name: 'zkSync Lite (legacy)',
    shortName: 'zkSync Lite',
    nativeAsset: 'ETH',
    // Lite's fungible token ids resolve to their canonical Ethereum contracts.
    coingeckoPlatform: 'ethereum',
    enabledByDefault: true,
    historyProvider: 'zksync-lite',
    requiresApiKey: false,
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
    // A SIXTH per-(wallet, chain) feed, declared here and NOWHERE ELSE (#76).
    // Polygon credits bridged-in native POL through the Bor STATE SYNC, which
    // is a system transaction present in NONE of the five Etherscan account
    // feeds -- so txlist/txlistinternal never see it and the derived balance
    // drifts below what the chain reports. The credit IS on-chain as a `Deposit`
    // event on the MRC20 precompile, fetched via module=logs action=getLogs.
    //
    // Consumed exactly like `nativeAsset`: a per-chain fact the sync reads off
    // the chain object, never a chain-id branch in the sync code. A chain that
    // does not declare `stateSyncDeposits` simply never runs the feed.
    //   * contract -- the MRC20 precompile 0x...1010 (Polygon's own Matic/POL
    //     token contract, verified byte-for-byte against maticnetwork/static).
    //     Deposits log FROM here, so it is the from_address of every ingested
    //     row and the counterparty a `bridge` label classifies on (rung 3).
    //   * topic0 -- keccak256 of Deposit(address,address,uint256,uint256,uint256).
    //     The user is topic2 and the amount is the first 32 bytes of data. The
    //     same transaction also emits LogTransfer (a DIFFERENT topic0); filtering
    //     on this one alone is what keeps the credit from being counted twice.
    stateSyncDeposits: {
      contract: '0x0000000000000000000000000000000000001010',
      topic0: '0x4e2ca0515ed1aef1395f66b5303bb5d6f1bf9d61a353fa53f73f8ac9973fa9f6',
    },
  },
  {
    id: 100,
    name: 'Gnosis Chain',
    shortName: 'Gnosis',
    // Gnosis' fee token is xDAI, minted 1:1 when DAI/USDS crosses the canonical
    // bridge. Keep the identity distinct from ERC-20 DAI: it is a native
    // balance with its own CoinGecko series and reconciliation key.
    nativeAsset: 'XDAI',
    coingeckoPlatform: 'xdai',
    enabledByDefault: true,
    // Gnosis' own documentation names this Blockscout instance as an execution
    // explorer. Its legacy account API was live-probed against balance,
    // txlist, txlistinternal, tokentx, tokennfttx and token1155tx on
    // 2026-07-29. Blockscout explicitly reports incompletely indexed internal
    // ranges; those are recorded as a visible feed gap rather than ingested as
    // complete history.
    accountApi: {
      provider: 'Blockscout',
      baseUrl: 'https://gnosis.blockscout.com/api',
      requiresApiKey: false,
    },
    // Blockscout's indexed account balance may be stale while it refreshes in
    // the background. Reconciliation needs the chain head, so native and token
    // balance reads use Gnosis' public JSON-RPC endpoint instead.
    rpcUrl: 'https://rpc.gnosischain.com',
    // Gnosis mints bridged xDAI through consensus. No account feed contains the
    // credit; the Block Reward contract's AddedReceiver log is the on-chain
    // record. This reuses the sixth native-credit feed/cursor introduced for
    // Polygon. The legacy config name is retained because it is persisted as
    // last_block_statesync, but `userTopicIndex` makes the log shape generic.
    stateSyncDeposits: {
      contract: '0x481c034c6d9441db23ea48de68bcae812c5d39ba',
      topic0: '0x3c798bbcf33115b42c728b8504cff11dd58736e9fa789f1cda2738db7d696b2a',
      userTopicIndex: 1,
    },
  },
  {
    id: 10,
    name: 'OP Mainnet',
    shortName: 'Optimism',
    nativeAsset: 'ETH',
    coingeckoPlatform: 'optimistic-ethereum',
    enabledByDefault: true,
    accountApi: {
      provider: 'Blockscout',
      baseUrl: 'https://explorer.optimism.io/api',
      requiresApiKey: false,
    },
    rpcUrl: 'https://mainnet.optimism.io',
    // Bump when stored feed rows must be rebuilt under new normalization.
    // Existing chain rows below this version reset all feed cursors once;
    // newly-created rows start current and do not pay a redundant backfill.
    ingestVersion: 1,
    // OP deposit transactions are unsigned L2 transactions whose independent
    // mint funds execution. Blockscout's legacy txlist omits type=0x7e,
    // sourceHash and mint, so fetchNormalTxs enriches zero-gas candidates from
    // JSON-RPC before `opStackDepositEffects` accounts for both balance effects.
    opStackDeposits: {
      creditSource: '0x4200000000000000000000000000000000000010',
    },
    // Standard-bridge ETH deposits emit this event after crediting `to`
    // (topic2); amount is data word 0. The same predeploy is used by OP and
    // Base. It also covers third-party frontends that settle through the
    // canonical StandardBridge.
    stateSyncDeposits: {
      contract: '0x4200000000000000000000000000000000000010',
      topic0: '0x31b2166ff604fc5672ea5df08a78081d2bc6d746cadce880747f3643d819e83d',
      userTopicIndex: 2,
    },
  },
  {
    id: 8453,
    name: 'Base',
    shortName: 'Base',
    nativeAsset: 'ETH',
    coingeckoPlatform: 'base',
    enabledByDefault: true,
    accountApi: {
      provider: 'Blockscout',
      baseUrl: 'https://base.blockscout.com/api',
      apiStyle: 'blockscout-v2',
      v2BaseUrl: 'https://base.blockscout.com/api/v2',
      requiresApiKey: false,
    },
    rpcUrl: 'https://mainnet.base.org',
    ingestVersion: 1,
    opStackDeposits: {
      creditSource: '0x4200000000000000000000000000000000000010',
    },
    stateSyncDeposits: {
      contract: '0x4200000000000000000000000000000000000010',
      topic0: '0x31b2166ff604fc5672ea5df08a78081d2bc6d746cadce880747f3643d819e83d',
      userTopicIndex: 2,
      // Base's public JSON-RPC is explicitly rate-limited and not intended for
      // production history walks. Blockscout v2 serves the StandardBridge's
      // event-signature stream efficiently, so one shared walk distributes
      // credits to every tracked receiver. Receiver-topic queries time out on
      // this instance, while its legacy logs facade is behind a standing
      // anonymous 429; neither is a safe production fallback.
      rpcScan: {
        provider: 'blockscout-v2',
      },
    },
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
  XDAI: {
    coingeckoId: 'xdai',
    // xDAI is minted and redeemed 1:1 against DAI/USDS by the canonical
    // bridge. Coinbase has no XDAI market; DAI-USD is the declared fallback,
    // never an accidental symbol match.
    coinbaseProduct: 'DAI-USD',
    // First DAI-USD daily candle observed on Coinbase Exchange.
    historyStart: '2020-04-30',
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

// The default Etherscan transport needs the user's key; a chain-declared
// account API can explicitly be keyless. Orchestration gates use this rather
// than assuming every enabled chain needs Etherscan credentials.
function accountApiRequiresKey(chainId) {
  const chain = getChain(chainId);
  if (chain?.requiresApiKey === false) return false;
  const accountApi = chain?.accountApi;
  return accountApi ? accountApi.requiresApiKey !== false : true;
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
  NATIVE_ASSETS,
  enabledChains,
  enabledChainIds,
  enabledChainsRequireApiKey,
  accountApiRequiresKey,
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
