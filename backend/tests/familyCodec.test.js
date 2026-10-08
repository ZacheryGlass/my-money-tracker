'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
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

test('every network in the registry has a codec for its family', () => {
  for (const network of [...networks.active, ...networks.retired]) {
    assert.ok(codecFor(network.family), network.name);
  }
});

test('the registry refuses a network whose family has no codec', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-family-'));
  try {
    fs.writeFileSync(path.join(dir, 'utxo.js'),
      "module.exports = { id: 990001, family: 'utxo', name: 'Synthetic UTXO', retired: true };\n");
    const result = spawnSync(process.execPath, ['-e', "require('./src/crypto/registry/networks')"], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, CRYPTO_EXTRA_NETWORKS_DIR: dir },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /utxo\.js: family utxo has no codec/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
