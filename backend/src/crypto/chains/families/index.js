'use strict';

// Codecs per network family. A network file names its family; every address
// or transaction id is validated and canonicalized through that family's
// codec, never by an ad-hoc lowercase.

const evm = require('./evm/codec');

const CODECS = new Map([[evm.family, evm]]);

function codecFor(family) {
  return CODECS.get(family) || null;
}

module.exports = { codecFor, CODECS };
