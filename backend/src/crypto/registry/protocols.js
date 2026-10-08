'use strict';

// Protocol (dapp) modules: every directory in crypto/interpretation/protocols/
// with an index.js is one protocol -- { id, name, order, pack?, labelPattern,
// interpret(row, ctx) }. Adding a dapp explanation is adding a directory (plus
// its curated label pack, if it has one). Explanations never change category,
// review, spam or ownership, and never read method_* (selectors are
// attacker-chosen).
//
// CRYPTO_EXTRA_PROTOCOLS_DIR adds a second directory, for the extensibility
// acceptance test.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'interpretation', 'protocols');

function loadDir(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'index.js')))
    .map((entry) => require(path.join(dir, entry.name, 'index.js')));
}

const PROTOCOLS = Object.freeze([
  ...loadDir(ROOT),
  ...(process.env.CRYPTO_EXTRA_PROTOCOLS_DIR ? loadDir(path.resolve(process.env.CRYPTO_EXTRA_PROTOCOLS_DIR)) : []),
].sort((a, b) => a.order - b.order));

for (const protocol of PROTOCOLS) {
  if (!protocol.id || !protocol.name || typeof protocol.interpret !== 'function' || !Number.isFinite(protocol.order)) {
    throw new Error(`protocol ${protocol.id || '(unnamed)'} needs id, name, order and interpret()`);
  }
}

// The curated builtin label sources (one pack per protocol that ships one).
const CURATED_PROTOCOL_SOURCES = Object.freeze(PROTOCOLS
  .map((protocol) => protocol.pack?.source).filter(Boolean));

// Packs whose addresses are custody venues (registry-declared `custody: true`).
const CUSTODY_PROTOCOL_SOURCES = Object.freeze(PROTOCOLS
  .filter((protocol) => protocol.custody && protocol.pack?.source).map((protocol) => protocol.pack.source));

module.exports = { PROTOCOLS, CURATED_PROTOCOL_SOURCES, CUSTODY_PROTOCOL_SOURCES };
