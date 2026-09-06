'use strict';

const axios = require('axios');
const crypto = require('node:crypto');

const HASH_RE = /^0x[0-9a-f]{64}$/i;

function quantity(value) {
  return typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) ? BigInt(value) : null;
}

function canonicalBlockMatches(receipt, block) {
  const number = quantity(receipt?.blockNumber);
  return number != null && number === quantity(block?.number)
    && HASH_RE.test(String(receipt?.blockHash)) && HASH_RE.test(String(block?.hash))
    && receipt.blockHash.toLowerCase() === block.hash.toLowerCase();
}

// Scheduling, retries and domain error codes belong to the callers. Every
// JSON-RPC POST shares the wire format, deadline and exact response evidence.
async function request(url, method, params, { timeoutMs = 15000, validateStatus } = {}) {
  const response = await axios.post(url, { jsonrpc: '2.0', id: 1, method, params }, {
    timeout: timeoutMs,
    signal: AbortSignal.timeout(timeoutMs),
    responseType: 'text',
    transformResponse: [(data) => data],
    ...(validateStatus ? { validateStatus } : {}),
  });
  const rawText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
  let body;
  try { body = JSON.parse(rawText); } catch { body = null; }
  return {
    result: body?.result,
    rawText,
    responseJson: body,
    responseSha256: crypto.createHash('sha256').update(rawText || '').digest('hex'),
    requestId: response.headers?.['x-request-id'] || null,
    httpStatus: response.status,
    headers: response.headers,
    method,
    params,
  };
}

module.exports = { request, quantity, canonicalBlockMatches };
