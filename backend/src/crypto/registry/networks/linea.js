'use strict';

module.exports = {
  order: 40,
  id: 59144,
  caip2: 'eip155:59144',
  family: 'evm',
  name: 'Linea',
  shortName: 'Linea',
  nativeAsset: 'ETH',
  coingeckoPlatform: 'linea',
  enabledByDefault: true,
  rpc: {
    consensus: { env: 'LINEA_RPC_URL', default: 'https://rpc.linea.build' },
    trace: { env: 'LINEA_TRACE_RPC_URL', default: null },
  },
  explorer: { baseUrl: 'https://lineascan.build', txPath: '/tx/{hash}', addressPath: '/address/{address}' },
  exchangeAliases: ['linea'],
  audit: {},
};
