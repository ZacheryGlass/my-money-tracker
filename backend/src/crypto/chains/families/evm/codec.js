'use strict';

// Address and transaction-id handling for the EVM family. EVM addresses and
// hashes are case-insensitive hex, so the canonical stored form is lowercase
// with the 0x prefix. Other families (base58, bech32) are case-SENSITIVE and
// must ship their own codec rather than reuse this lowercasing.

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const TX_ID_RE = /^0x[0-9a-f]{64}$/i;

function isAddress(value) {
  return typeof value === 'string' && ADDRESS_RE.test(value.trim());
}

// Canonical form, or null when the value is not an address.
function normalizeAddress(value) {
  return isAddress(value) ? value.trim().toLowerCase() : null;
}

function isTxId(value) {
  return typeof value === 'string' && TX_ID_RE.test(value.trim());
}

function normalizeTxId(value) {
  return isTxId(value) ? value.trim().toLowerCase() : null;
}

module.exports = {
  family: 'evm', isAddress, normalizeAddress, isTxId, normalizeTxId, ADDRESS_RE, TX_ID_RE,
};
