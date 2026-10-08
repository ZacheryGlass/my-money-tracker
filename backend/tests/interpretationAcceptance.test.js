'use strict';

// Extensibility acceptance: a dapp explanation is ONE protocol folder and a
// bridge protocol is ONE adapter file. Synthetic ones in extra directories
// must be picked up by the interpretation and bridge decoding with no core
// file edited.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-interpretation-'));
fs.mkdirSync(path.join(root, 'protocols', 'synthdex'), { recursive: true });
fs.mkdirSync(path.join(root, 'bridges'));
fs.writeFileSync(path.join(root, 'protocols', 'synthdex', 'index.js'), `'use strict';
module.exports = {
  id: 'synthdex', name: 'SynthDEX', order: 70, pack: { source: 'builtin-synthdex' }, labelPattern: /^SynthDEX\\b/,
  interpret(row, { shape, explain }) {
    if (row.category !== 'swap' || !shape.fungibleIn || !shape.fungibleOut) return null;
    return explain('pool_swap', 'A SynthDEX pool swap.', ['netted_fungible_out', 'netted_fungible_in'], []);
  },
};
`);
fs.writeFileSync(path.join(root, 'bridges', 'synthbridge.js'), `'use strict';
module.exports = {
  protocol: 'synthbridge', order: 95,
  decode(envelope) {
    if (envelope.counterparty_address !== '0x${'5'.repeat(40)}') return [];
    return [{ protocol: 'synthbridge', family_version: 'v1', role: 'initiation', direction: 'out',
      correlation_key: 'synth:' + envelope.tx_hash, status: 'pending', chain_id: Number(envelope.chain_id),
      wallet_id: Number(envelope.wallet_id), tx_hash: envelope.tx_hash, evidence: {} }];
  },
};
`);
process.env.CRYPTO_EXTRA_PROTOCOLS_DIR = path.join(root, 'protocols');
process.env.CRYPTO_EXTRA_BRIDGES_DIR = path.join(root, 'bridges');
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('a new protocol folder explains matching activity and joins the curated packs', () => {
  const { interpretProtocolActivity } = require('../src/services/ethActivity/protocolInterpretation');
  const interpreted = interpretProtocolActivity(
    { category: 'swap', legs: [{ direction: 'out', token_standard: null }, { direction: 'in', token_standard: 'erc20' }] },
    { source: 'builtin-synthdex', name: 'SynthDEX Router', confidence: 'high' }
  );
  assert.equal(interpreted.protocol, 'SynthDEX');
  assert.equal(interpreted.action, 'pool_swap');
  const { CURATED_PROTOCOL_SOURCES } = require('../src/crypto/interpretation/protocolIdentity');
  assert.ok(CURATED_PROTOCOL_SOURCES.includes('builtin-synthdex'));
});

test('a new bridge adapter file is decoded with the others', () => {
  const { ADAPTERS, decodeEnvelope } = require('../src/services/bridge/adapters');
  assert.equal(ADAPTERS.at(-1).protocol, 'synthbridge');
  const events = decodeEnvelope({
    wallet_id: 1, chain_id: 1, tx_hash: `0x${'a'.repeat(64)}`, counterparty_address: `0x${'5'.repeat(40)}`,
    receipt: { logs: [] }, transaction: {}, endpoints: [], known_endpoints: [], hop_routes: [],
  });
  assert.deepEqual(events.map((event) => event.protocol), ['synthbridge']);
});
