'use strict';

module.exports = {
  order: 50,
  id: 324,
  caip2: 'eip155:324',
  family: 'evm',
  name: 'ZKsync Era',
  shortName: 'zkSync Era',
  nativeAsset: 'ETH',
  coingeckoPlatform: 'zksync',
  enabledByDefault: true,
  accountApi: {
    // Keep Blockscout for token/NFT feeds: Matter Labs' official explorer
    // does not publish the same complete token1155tx contract. Native
    // account history is routed separately through the official explorer.
    provider: 'Blockscout',
    baseUrl: 'https://zksync.blockscout.com/api',
    requiresApiKey: false,
    nativeHistoryApi: {
      // Its indexed-block endpoint matched the public RPC head, an inactive
      // wallet canary exhausted both native feeds from genesis, and a recent
      // internal-value positive control matched debug_traceTransaction on
      // 2026-09-19. Its documented page maximum is 100 rows.
      provider: 'ZKsync Explorer',
      baseUrl: 'https://block-explorer-api.mainnet.zksync.io/api',
      requiresApiKey: false,
      pageSize: 100,
      blockPageSize: 100,
      normalFeeField: 'fee',
      verifyRpcIndexedHead: true,
      // This public host throttles sustained multi-wallet history walks at
      // the generic Etherscan pace. Keep a provider-specific floor while
      // still allowing a stricter operator override.
      requestSpacingMs: 2000,
    },
  },
  rpc: {
    consensus: { env: 'ZKSYNC_ERA_RPC_URL', default: 'https://mainnet.era.zksync.io' },
    trace: { env: 'ZKSYNC_ERA_TRACE_RPC_URL', default: null },
  },
  // Canonical bridge: the L2 side of 'zksync', settling on Ethereum.
  bridge: { settlementChain: 1, protocols: { zksync: 'l2' } },
  explorer: { baseUrl: 'https://zksync.blockscout.com', txPath: '/tx/{hash}', addressPath: '/address/{address}' },
  exchangeAliases: ['zksync era', 'zksync'],
  audit: {
    errorDetail: 'Moralis does not enumerate zkSync Era; the official ZKsync Explorer provides finite native/internal history and Blockscout provides finite token/NFT history, while consensus RPC verifies mined transactions and effects.',
  },
};
