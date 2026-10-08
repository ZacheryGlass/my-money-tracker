'use strict';

module.exports = {
  order: 30,
  id: 42170,
  caip2: 'eip155:42170',
  family: 'evm',
  name: 'Arbitrum Nova',
  shortName: 'Arbitrum Nova',
  nativeAsset: 'ETH',
  coingeckoPlatform: 'arbitrum-nova',
  enabledByDefault: true,
  // Live-probed 2026-09-05 with non-user positive controls: balance,
  // txlist, txlistinternal, tokentx, tokennfttx and token1155tx all returned
  // the documented Etherscan-compatible shapes. This keyless index is what
  // turns the exact Hop destination into a complete account-history walk.
  accountApi: {
    provider: 'Blockscout',
    baseUrl: 'https://arbitrum-nova.blockscout.com/api',
    v2BaseUrl: 'https://arbitrum-nova.blockscout.com/api/v2/',
    requiresApiKey: false,
  },
  // Account-history adapter per feed (crypto/chains/providers); a feed not
  // listed uses the Etherscan-compatible accountApi. Changing one is a provider
  // swap: only that feed's provenance changes, so only it replays.
  routes: { normal: 'blockscout-v2' },
  rpc: {
    consensus: { env: 'ARBITRUM_NOVA_RPC_URL', default: 'https://arbitrum-nova-rpc.publicnode.com' },
    trace: { env: 'ARBITRUM_NOVA_TRACE_RPC_URL', default: null },
  },
  explorer: { baseUrl: 'https://arbitrum-nova.blockscout.com', txPath: '/tx/{hash}', addressPath: '/address/{address}' },
  exchangeAliases: ['arbitrum nova'],
  audit: {},
};
