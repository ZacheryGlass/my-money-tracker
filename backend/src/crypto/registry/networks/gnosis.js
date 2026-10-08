'use strict';

module.exports = {
  order: 80,
  id: 100,
  caip2: 'eip155:100',
  family: 'evm',
  name: 'Gnosis Chain',
  shortName: 'Gnosis',
  // Gnosis' fee token is xDAI, minted 1:1 when DAI/USDS crosses the canonical
  // bridge. Keep the identity distinct from ERC-20 DAI: it is a native
  // balance with its own CoinGecko series and reconciliation key.
  nativeAsset: 'XDAI',
  nativeAssetPricing: {
    coingeckoId: 'xdai',
    // xDAI is minted and redeemed 1:1 against DAI/USDS by the canonical
    // bridge. Coinbase has no XDAI market; DAI-USD is the declared fallback,
    // never an accidental symbol match.
    coinbaseProduct: 'DAI-USD',
    // First DAI-USD daily candle observed on Coinbase Exchange.
    historyStart: '2020-04-30',
  },
  coingeckoPlatform: 'xdai',
  enabledByDefault: true,
  // Gnosis' own documentation names this Blockscout instance as an execution
  // explorer. The legacy API remains healthy for the ordinary account feeds,
  // but its txlistinternal route reports old ranges as incompletely indexed.
  // Blockscout V2 passed two independent history canaries on 2026-09-19: an
  // inactive address returned an exhausted empty history, while an active
  // address returned every independently recovered trace plus a previously
  // unseen trace. The adapter still requires V2's global block and internal
  // indexing ratios to be 100% before it accepts any page as complete.
  accountApi: {
    provider: 'Blockscout',
    baseUrl: 'https://gnosisscan.io/api',
    v2BaseUrl: 'https://gnosisscan.io/api/v2/',
    requiresApiKey: false,
  },
  // Blockscout's indexed account balance may be stale while it refreshes in
  // the background. Reconciliation needs the chain head, so native and token
  // balance reads use Gnosis' public JSON-RPC endpoint instead.
  // Account-history adapter per feed (crypto/chains/providers); a feed not
  // listed uses the Etherscan-compatible accountApi. Changing one is a provider
  // swap: only that feed's provenance changes, so only it replays.
  routes: { normal: 'blockscout-v2', internal: 'blockscout-v2' },
  rpc: {
    consensus: { env: 'GNOSIS_RPC_URL', default: 'https://rpc.gnosischain.com' },
    trace: { env: 'GNOSIS_TRACE_RPC_URL', default: null },
  },
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
  explorer: { baseUrl: 'https://gnosis.blockscout.com', txPath: '/tx/{hash}', addressPath: '/address/{address}' },
  exchangeAliases: ['gnosis', 'xdai', 'gnosis chain'],
  // Moralis enumerates Gnosis activity for the optional discovery audit; its
  // chain spellings are matched literally.
  audit: { moralis: 'gnosis', moralisActiveIds: ['0x64', '100', 'gnosis'] },
};
