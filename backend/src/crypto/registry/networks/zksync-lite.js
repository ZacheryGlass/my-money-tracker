'use strict';

// zkSync Lite was not EVM and had no EIP-155 id. App-internal identity 32401;
// 324 is reserved for Era, so Lite must never reuse it. Its history comes from
// Matter Labs' read-only v0.2 archive (ZkSyncLiteService), not an account API.
module.exports = {
  order: 60,
  id: 32401,
  caip2: null,
  family: 'zksync-lite',
  name: 'zkSync Lite (legacy)',
  shortName: 'zkSync Lite',
  nativeAsset: 'ETH',
  // Lite's fungible token ids resolve to their canonical Ethereum contracts.
  coingeckoPlatform: 'ethereum',
  enabledByDefault: true,
  historyProvider: 'zksync-lite',
  requiresApiKey: false,
  // Canonical bridge: the L2 side of 'zksync-lite', settling on Ethereum.
  bridge: { settlementChain: 1, protocols: { 'zksync-lite': 'l2' } },
  explorer: {
    baseUrl: 'https://zkscan.io',
    txPath: '/explorer/transactions/{hash}',
    addressPath: '/explorer/accounts/{address}',
  },
  exchangeAliases: [],
  audit: {
    unsupported: true,
    errorCode: 'NON_EVM_CHAIN',
    errorDetail: 'zkSync Lite is a legacy non-EVM history source and is outside the EVM audit contract.',
  },
};
