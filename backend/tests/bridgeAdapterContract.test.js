'use strict';

// The contract every bridge adapter and protocol module meets, checked over
// all of them so a new one inherits the checks:
//   - decoders are pure and never read method_id/method_name (selectors are
//     attacker-chosen display hints);
//   - malformed logs and receipts decode to nothing rather than throwing;
//   - a decoder stays inside its envelope's chain scope.
//   - protocol explanations never read method_* either, and never touch
//     category, review or spam.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const { ADAPTERS } = require('../src/crypto/interpretation/bridges');
const { PROTOCOLS } = require('../src/crypto/registry/protocols');
const { interpretProtocolActivity } = require('../src/services/ethActivity/protocolInterpretation');

const hash = (c) => `0x${c.repeat(64)}`;
const address = (c) => `0x${c.repeat(40)}`;

// An envelope whose method_* fields throw on access.
function poisoned(base) {
  const envelope = { ...base };
  for (const key of ['method_id', 'method_name']) {
    Object.defineProperty(envelope, key, { get() { throw new Error(`decoder read ${key}`); }, enumerable: true });
  }
  return envelope;
}

const baseEnvelope = (overrides = {}) => ({
  wallet_id: 1, chain_id: 1, tx_hash: hash('1'), block_number: 100, block_time: '2024-01-01T00:00:00Z',
  category: 'bridge_out', counterparty_address: address('2'), legs: [],
  transaction: { hash: hash('1'), from: address('3'), to: address('2'), input: '0x', value: '0x0', blockNumber: '0x64' },
  receipt: { transactionHash: hash('1'), blockHash: hash('4'), blockNumber: '0x64', status: '0x1', logs: [] },
  provider_boundary: { finality: { status: 'finalized', method: 'test' } },
  endpoints: [], known_endpoints: [], hop_routes: [],
  ...overrides,
});

test('no bridge decoder reads method_* and none throws on an ordinary envelope', () => {
  for (const adapter of ADAPTERS) {
    assert.doesNotThrow(() => adapter.decode(poisoned(baseEnvelope())), adapter.protocol);
  }
});

test('malformed receipts and logs decode to evidence-free output, never an exception', () => {
  const malformed = [
    { logs: null },
    { logs: [{ address: 'not-an-address', topics: ['0x12'], data: 'zz' }] },
    { logs: [{ address: address('2'), topics: [], data: '0x' }] },
    { logs: [{ address: address('2'), topics: [hash('5')], data: `0x${'f'.repeat(13)}` }] },
    null,
  ];
  for (const adapter of ADAPTERS) {
    for (const receipt of malformed) {
      const envelope = baseEnvelope({ receipt: receipt ? { ...baseEnvelope().receipt, ...receipt } : null });
      let events;
      assert.doesNotThrow(() => { events = adapter.decode(envelope); }, `${adapter.protocol} ${JSON.stringify(receipt)}`);
      assert.ok(Array.isArray(events), adapter.protocol);
    }
  }
});

test('emitted events stay on the envelope chain and wallet', () => {
  for (const adapter of ADAPTERS) {
    for (const chainId of [1, 10, 100, 137, 324, 42161, 59144]) {
      const events = adapter.decode(baseEnvelope({ chain_id: chainId }));
      for (const event of events) {
        assert.equal(event.chain_id, chainId, adapter.protocol);
        assert.equal(event.wallet_id, 1, adapter.protocol);
      }
    }
  }
});

test('protocol explanations never read method_* and leave verdict fields alone', () => {
  for (const protocol of PROTOCOLS) {
    const label = { source: protocol.pack?.source || 'eth-labels', name: protocol.name, confidence: 'high' };
    for (const category of ['exchange_deposit', 'nft_purchase', 'nft_sale', 'nft_mint', 'swap', 'receive']) {
      const row = poisoned({
        category, needs_review: true, spam: false,
        legs: [{ direction: 'out', token_standard: null }, { direction: 'in', token_standard: 'erc1155' }, { direction: 'in', token_standard: 'erc20' }],
      });
      const before = { category: row.category, needs_review: row.needs_review, spam: row.spam };
      assert.doesNotThrow(() => interpretProtocolActivity(row, label), protocol.id);
      assert.deepEqual({ category: row.category, needs_review: row.needs_review, spam: row.spam }, before, protocol.id);
    }
  }
});
