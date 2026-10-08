'use strict';

// Bridge adapters for bridge-match-v1: every *.js file here other than kit.js
// is one protocol's pure decoder, { protocol, order, decode(envelope),
// validatePair? }. Adding a bridge protocol is adding a file (plus its
// endpoint/route pack rows). Adapters run in `order`.
//
// CRYPTO_EXTRA_BRIDGES_DIR adds a second directory, for the extensibility
// acceptance test.

const fs = require('fs');
const path = require('path');
const kit = require('./kit');

function loadDir(dir) {
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith('.js') && file !== 'index.js' && file !== 'kit.js')
    .map((file) => require(path.join(dir, file)));
}

const MODULES = [
  ...loadDir(__dirname),
  ...(process.env.CRYPTO_EXTRA_BRIDGES_DIR ? loadDir(path.resolve(process.env.CRYPTO_EXTRA_BRIDGES_DIR)) : []),
].sort((a, b) => a.order - b.order);

const seen = new Set();
for (const adapter of MODULES) {
  if (!adapter.protocol || typeof adapter.decode !== 'function' || !Number.isFinite(adapter.order)) {
    throw new Error(`bridge adapter ${adapter.protocol || '(unnamed)'} needs protocol, order and decode()`);
  }
  if (seen.has(adapter.protocol)) throw new Error(`duplicate bridge adapter ${adapter.protocol}`);
  seen.add(adapter.protocol);
}

// The registry shape callers have always used: [{ protocol, decode }].
const ADAPTERS = Object.freeze(MODULES.map((adapter) => Object.freeze({
  protocol: adapter.protocol,
  decode: adapter.decode,
  ...(adapter.validatePair ? { validatePair: adapter.validatePair } : {}),
})));

function adapterFor(protocol) {
  return ADAPTERS.find((adapter) => adapter.protocol === protocol) || null;
}

function decodeEnvelope(envelope) {
  if (!envelope || !kit.HASH_RE.test(kit.lower(envelope.tx_hash))) return [];
  return ADAPTERS.flatMap((adapter) => adapter.decode(envelope));
}

const hop = require('./hop');
const opStack = require('./op-stack');

module.exports = {
  ADAPTERS,
  adapterFor,
  HOP_SELECTORS: hop.HOP_SELECTORS,
  RULE_VERSION: kit.RULE_VERSION,
  TOPICS: kit.TOPICS,
  addressWord: kit.addressWord,
  bytes32: kit.bytes32,
  dataWord: kit.dataWord,
  decodeEnvelope,
  decodeHop: hop.decodeHop,
  decodeHopCall: hop.decodeHopCall,
  eventTopic: kit.eventTopic,
  hopTransferId: hop.hopTransferId,
  hopTransferIdCurrent: hop.hopTransferIdCurrent,
  logIndex: kit.logIndex,
  opSourceHash: opStack.opSourceHash,
  parseErc20TransferLog: kit.parseErc20TransferLog,
  receiptStatus: kit.receiptStatus,
  validateHopPair: hop.validateHopPair,
  uintWord: kit.uintWord,
};
