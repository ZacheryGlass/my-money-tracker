'use strict';

// EVM ABI and hex helpers, stated once for the bridge decoders
// (crypto/interpretation/bridges/kit.js), the history audit's effect decoder
// and any provider adapter. Every helper validates its input and answers null
// rather than throwing on a malformed value: decoders run over provider data.

const { keccak_256 } = require('@noble/hashes/sha3.js');
const { bytesToHex } = require('@noble/hashes/utils.js');

const HASH_RE = /^0x[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

const lower = (value) => String(value || '').toLowerCase();

function eventTopic(signature) {
  return `0x${bytesToHex(keccak_256(new TextEncoder().encode(signature)))}`;
}

function functionSelector(signature) {
  return `0x${bytesToHex(keccak_256(new TextEncoder().encode(signature))).slice(0, 8)}`;
}

function bytes32(value) {
  const normalized = lower(value);
  return HASH_RE.test(normalized) ? normalized : null;
}

function nonZeroBytes32(value) {
  const normalized = bytes32(value);
  return normalized && !/^0x0{64}$/.test(normalized) ? normalized : null;
}

function logIndex(log) {
  const raw = log?.logIndex;
  const parsed = typeof raw === 'string' && /^0x[0-9a-f]+$/i.test(raw)
    ? Number.parseInt(raw, 16)
    : Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

// The 32-byte word at `index` of ABI data, as 0x hex.
function dataWord(data, index) {
  const normalized = lower(data);
  if (!/^0x(?:[0-9a-f]{64})*$/.test(normalized)) return null;
  const start = 2 + index * 64;
  return normalized.length >= start + 64 ? `0x${normalized.slice(start, start + 64)}` : null;
}

function dataWordCount(data) {
  const normalized = lower(data);
  if (!/^0x(?:[0-9a-f]{64})*$/.test(normalized)) return null;
  return (normalized.length - 2) / 64;
}

// Every 32-byte word of ABI data, as bare hex strings.
function words(data) {
  const text = lower(data);
  if (!/^0x(?:[0-9a-f]{64})*$/.test(text)) return null;
  return text.slice(2).match(/.{64}/g) || [];
}

function uintWord(value) {
  const normalized = bytes32(value);
  if (!normalized) return null;
  try { return BigInt(normalized); } catch { return null; }
}

// A bare 64-hex word as an integer.
function wordInteger(value) {
  if (!/^[0-9a-f]{64}$/.test(String(value || ''))) return null;
  try { return BigInt(`0x${value}`); } catch { return null; }
}

// A JSON-RPC quantity (0x hex) or decimal string as an integer.
function quantity(value) {
  const text = String(value ?? '');
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(text)) return null;
  try { return BigInt(text); } catch { return null; }
}

function receiptStatus(receipt) {
  const raw = receipt?.status;
  try {
    const parsed = typeof raw === 'number' ? BigInt(raw) : BigInt(String(raw));
    return parsed === 0n || parsed === 1n ? parsed : null;
  } catch {
    return null;
  }
}

// A strictly ABI-encoded address word (12 zero bytes, then 20).
function addressWord(value) {
  const normalized = bytes32(value);
  if (!normalized || !/^0x0{24}[0-9a-f]{40}$/.test(normalized)) return null;
  return `0x${normalized.slice(-40)}`;
}

function normalizedAddress(value) {
  const text = lower(value);
  return ADDRESS_RE.test(text) ? text : null;
}

// The address in an indexed event topic (its last 20 bytes).
function topicAddress(value) {
  const text = lower(value);
  if (!HASH_RE.test(text)) return null;
  return normalizedAddress(`0x${text.slice(-40)}`);
}

module.exports = {
  HASH_RE, ADDRESS_RE, lower,
  eventTopic, functionSelector,
  bytes32, nonZeroBytes32, logIndex,
  dataWord, dataWordCount, words, uintWord, wordInteger, quantity,
  receiptStatus, addressWord, normalizedAddress, topicAddress,
};
