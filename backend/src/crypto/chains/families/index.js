'use strict';

// Codecs per network family. A network file names its family, and the
// registry refuses one whose family has no codec here. New code validates and
// canonicalizes addresses and transaction ids through the family's codec; the
// EVM-only modules that predate it still lowercase directly, and moving them is
// part of the non-EVM core (#136).

const evm = require('./evm/codec');

// zkSync Lite is not EVM, but its accounts and transaction hashes are the same
// case-insensitive 0x hex, validated and lowercased exactly like the EVM feeds
// (ZkSyncLiteService).
const CODECS = new Map([
  [evm.family, evm],
  ['zksync-lite', { ...evm, family: 'zksync-lite' }],
]);

function codecFor(family) {
  return CODECS.get(family) || null;
}

module.exports = { codecFor, CODECS };
