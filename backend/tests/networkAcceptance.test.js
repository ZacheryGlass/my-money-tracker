'use strict';

// Extensibility acceptance: an EVM L2 is ONE network file. A synthetic network
// dropped into an extra registry directory (no core file edited) must reach
// sync configuration, provider provenance, holding names, the EVM audit's
// routing, exchange network spellings and the client meta.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-network-'));
fs.writeFileSync(path.join(dir, 'synthnet.js'), `'use strict';
module.exports = {
  order: 95,
  id: 999001,
  caip2: 'eip155:999001',
  family: 'evm',
  name: 'SynthNet Mainnet',
  shortName: 'SynthNet',
  nativeAsset: 'ETH',
  coingeckoPlatform: 'synthnet',
  enabledByDefault: true,
  accountApi: { provider: 'Blockscout', baseUrl: 'https://explorer.synthnet.example/api', requiresApiKey: false },
  rpc: {
    consensus: { env: 'SYNTHNET_RPC_URL', default: 'https://rpc.synthnet.example' },
    trace: { env: 'SYNTHNET_TRACE_RPC_URL', default: null },
  },
  explorer: { baseUrl: 'https://explorer.synthnet.example', txPath: '/tx/{hash}', addressPath: '/address/{address}' },
  exchangeAliases: ['synthnet', 'synthnet mainnet'],
  audit: {},
};
`);
process.env.CRYPTO_EXTRA_NETWORKS_DIR = dir;
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
delete process.env.ETH_CHAINS;

const chains = require('../src/config/chains');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a new network file is enabled and routed by the chains facade', () => {
  const chain = chains.getChain(999001);
  assert.equal(chain.name, 'SynthNet Mainnet');
  assert.equal(chain.consensusRpcUrl, 'https://rpc.synthnet.example');
  assert.ok(chains.enabledChainIds().includes(999001));
  assert.equal(chains.accountApiRequiresKey(999001), false);
  assert.equal(chains.accountHistoryProviderName(999001, 'normal'), 'Blockscout (https://explorer.synthnet.example/api)');
  assert.equal(chains.ethHoldingName(999001), 'ETH (SynthNet)');
  assert.equal(chains.nativeSymbol(999001), 'ETH');
  assert.equal(chains.enabledChains().at(-1).id, 999001, 'order places it after OP Mainnet');
});

test('the EVM audit routes it through its explorer without an audit edit', () => {
  const audit = require('../src/services/EvmAuditService')._AUDIT_CHAINS.get(999001);
  assert.deepEqual(audit, { auditProvider: 'blockscout' });
});

test('exchange records naming it get its chain id', () => {
  const { finalizeRecord } = require('../src/services/exchangeImport/shared');
  const record = finalizeRecord({
    record_type: 'withdrawal', occurred_at: '2026-01-01T00:00:00Z', base_asset: 'ETH', base_amount: '-1',
    external_id: 'synth-1', network: 'SynthNet Mainnet', raw: {},
  });
  assert.equal(record.chain_id, 999001);
});

test('the client meta carries its explorer, so links need no frontend edit', () => {
  const meta = require('../src/crypto/meta').buildCryptoMeta();
  const network = meta.networks.find((entry) => entry.id === 999001);
  assert.deepEqual(network.explorer, {
    baseUrl: 'https://explorer.synthnet.example', txPath: '/tx/{hash}', addressPath: '/address/{address}',
  });
  assert.equal(network.nativeAsset, 'ETH');
});
