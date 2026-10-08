'use strict';

module.exports = {
  order: 90,
  id: 10,
  caip2: 'eip155:10',
  family: 'evm',
  name: 'OP Mainnet',
  shortName: 'Optimism',
  nativeAsset: 'ETH',
  coingeckoPlatform: 'optimistic-ethereum',
  enabledByDefault: true,
  accountApi: {
    provider: 'Blockscout',
    baseUrl: 'https://explorer.optimism.io/api',
    v2BaseUrl: 'https://explorer.optimism.io/api/v2/',
    requiresApiKey: false,
  },
  // Account-history adapter per feed (crypto/chains/providers); a feed not
  // listed uses the Etherscan-compatible accountApi. Changing one is a provider
  // swap: only that feed's provenance changes, so only it replays. The V2
  // internal route exhausted all three legacy-unsupported production histories
  // on 2026-09-20 with complete indexing and valid empty tails.
  routes: { normal: 'blockscout-v2', internal: 'blockscout-v2' },
  rpc: {
    consensus: { env: 'OPTIMISM_RPC_URL', default: 'https://mainnet.optimism.io' },
    trace: { env: 'OPTIMISM_TRACE_RPC_URL', default: null },
  },
  // Bump when stored feed rows must be rebuilt under new normalization.
  // Existing chain rows below this version reset all feed cursors once;
  // newly-created rows start current and do not pay a redundant backfill.
  ingestVersion: 1,
  // OP deposit transactions are unsigned L2 transactions whose independent
  // mint funds execution. Blockscout's legacy txlist omits type=0x7e,
  // sourceHash and mint, so fetchNormalTxs enriches zero-gas candidates from
  // JSON-RPC before `opStackDepositEffects` accounts for both balance effects.
  // Declaring it also marks the chain as an OP Stack L2 for the audit
  // normalizer (type 126 is a protocol system transaction here).
  opStackDeposits: {
    creditSource: '0x4200000000000000000000000000000000000010',
  },
  // Standard-bridge ETH deposits emit this event after crediting `to`
  // (topic2); amount is data word 0. The same predeploy is used by OP and
  // OP Stack's standard bridge also covers third-party frontends that settle
  // through the canonical StandardBridge.
  stateSyncDeposits: {
    contract: '0x4200000000000000000000000000000000000010',
    topic0: '0x31b2166ff604fc5672ea5df08a78081d2bc6d746cadce880747f3643d819e83d',
    userTopicIndex: 2,
  },
  // The canonical bridge that settles deposits INTO this chain. The OP Stack
  // decoder names a destination deposit with this protocol/family.
  bridge: {
    settlementChain: 1,
    protocols: { 'op-stack': 'l2' },
    opStackDestination: { protocol: 'optimism', familyVersion: 'bedrock' },
  },
  explorer: { baseUrl: 'https://explorer.optimism.io', txPath: '/tx/{hash}', addressPath: '/address/{address}' },
  exchangeAliases: ['optimism', 'op mainnet'],
  audit: {},
};
