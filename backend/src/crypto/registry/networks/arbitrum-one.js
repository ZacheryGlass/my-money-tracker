'use strict';

module.exports = {
  order: 20,
  id: 42161,
  caip2: 'eip155:42161',
  family: 'evm',
  name: 'Arbitrum One',
  shortName: 'Arbitrum',
  nativeAsset: 'ETH',
  coingeckoPlatform: 'arbitrum-one',
  enabledByDefault: true,
  rpc: {
    consensus: { env: 'ARBITRUM_RPC_URL', default: 'https://arb1.arbitrum.io/rpc' },
    trace: { env: 'ARBITRUM_TRACE_RPC_URL', default: null },
  },
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
  explorer: { baseUrl: 'https://arbiscan.io', txPath: '/tx/{hash}', addressPath: '/address/{address}' },
  exchangeAliases: ['arbitrum', 'arbitrum one'],
  audit: {},
};
