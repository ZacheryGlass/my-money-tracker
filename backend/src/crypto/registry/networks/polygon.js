'use strict';

module.exports = {
  order: 70,
  id: 137,
  caip2: 'eip155:137',
  family: 'evm',
  name: 'Polygon',
  shortName: 'Polygon',
  // NOT ETH. Every price, holding ticker and reconciliation key on this chain
  // follows this symbol.
  nativeAsset: 'POL',
  nativeAssetPricing: {
    coingeckoId: 'polygon-ecosystem-token',
    coinbaseProduct: 'POL-USD',
    // Coinbase's first POL-USD daily candle. MATIC-USD history before the 2024
    // rename is a DIFFERENT product and is deliberately not stitched on: the
    // two are the same money, but a stitched series would be indistinguishable
    // from a real one while resting on an assumption nothing here verifies.
    historyStart: '2024-09-04',
  },
  coingeckoPlatform: 'polygon-pos',
  enabledByDefault: true,
  rpc: {
    consensus: { env: 'POLYGON_RPC_URL', default: 'https://polygon.drpc.org' },
    trace: { env: 'POLYGON_TRACE_RPC_URL', default: null },
  },
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
  explorer: { baseUrl: 'https://polygonscan.com', txPath: '/tx/{hash}', addressPath: '/address/{address}' },
  exchangeAliases: ['polygon', 'polygon pos', 'matic'],
  audit: {},
};
