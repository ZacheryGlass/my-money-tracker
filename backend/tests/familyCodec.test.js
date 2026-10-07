'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { codecFor } = require('../src/crypto/chains/families');
const networks = require('../src/crypto/registry/networks');

test('the EVM codec canonicalizes to lowercase 0x hex and rejects anything else', () => {
  const evm = codecFor('evm');
  assert.equal(evm.normalizeAddress(' 0xAbCdEf0123456789abcdef0123456789ABCDEF01 '), '0xabcdef0123456789abcdef0123456789abcdef01');
  assert.equal(evm.normalizeAddress('abcdef0123456789abcdef0123456789abcdef01'), null);
  assert.equal(evm.normalizeAddress('0x123'), null);
  assert.equal(evm.normalizeTxId(`0x${'A'.repeat(64)}`), `0x${'a'.repeat(64)}`);
  assert.equal(evm.normalizeTxId(`0x${'a'.repeat(63)}`), null);
});

test('every EVM network in the registry has a codec; other families declare themselves', () => {
  for (const network of [...networks.active, ...networks.retired]) {
    if (network.family === 'evm') assert.ok(codecFor('evm'), network.name);
    else assert.equal(typeof network.family, 'string', network.name);
  }
});
