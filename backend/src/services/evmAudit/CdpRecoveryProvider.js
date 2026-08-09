'use strict';

const { address, sha256, stableJson, txHash } = require('./normalizer');

const MAX_RECOVERY_CANDIDATES = 64;

function recoveryError(message, code = 'CDP_RECOVERY_FAILED', extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function hexQuantity(value, field) {
  const text = String(value ?? '');
  if (!/^0x[0-9a-f]+$/i.test(text)) {
    throw recoveryError(`Coinbase CDP recovery returned an invalid ${field}`, 'CDP_INVALID_RESPONSE');
  }
  try { return BigInt(text); } catch {
    throw recoveryError(`Coinbase CDP recovery returned an invalid ${field}`, 'CDP_INVALID_RESPONSE');
  }
}

function hexNumber(value, field) {
  const parsed = hexQuantity(value, field);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw recoveryError(`Coinbase CDP recovery returned an unsafe ${field}`, 'CDP_INVALID_RESPONSE');
  }
  return Number(parsed);
}

function normalizedHash(value, field) {
  const hash = txHash(value);
  if (!hash) throw recoveryError(`Coinbase CDP recovery returned an invalid ${field}`, 'CDP_INVALID_RESPONSE');
  return hash;
}

function normalizedBlockHash(value, field) {
  const text = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(text)) {
    throw recoveryError(`Coinbase CDP recovery returned an invalid ${field}`, 'CDP_INVALID_RESPONSE');
  }
  return text;
}

function timestamp(block) {
  const seconds = hexQuantity(block?.timestamp, 'block timestamp');
  const value = new Date(Number(seconds) * 1000);
  if (!Number.isFinite(value.getTime())) {
    throw recoveryError('Coinbase CDP recovery returned an invalid block timestamp', 'CDP_INVALID_RESPONSE');
  }
  return value.toISOString();
}

function statusForReceipt(receipt) {
  const status = hexQuantity(receipt?.status, 'receipt status');
  if (status === 0n) return 'failed';
  if (status === 1n) return 'confirmed';
  throw recoveryError('Coinbase CDP recovery returned an unknown receipt status', 'CDP_INVALID_RESPONSE');
}

function traceAddressFor(path) {
  return path.map((value) => Number(value));
}

// CDP documents callTracer for debug_traceBlockByNumber. Convert its nested
// call tree to the flattened trace shape already accepted by the CDP history
// normalizer. The root call is retained: it proves the signed transaction's
// top-level execution even when it has zero value or no internal movement.
function flattenCallTracer(node, path = [], context = {}) {
  if (!node || typeof node !== 'object') {
    throw recoveryError('Coinbase CDP recovery returned a malformed call trace', 'CDP_INVALID_RESPONSE');
  }
  const from = address(node.from);
  const to = address(node.to);
  if (!from || !to) {
    throw recoveryError('Coinbase CDP recovery returned a trace without valid endpoints', 'CDP_INVALID_RESPONSE');
  }
  const value = String(node.value ?? '0x0');
  hexQuantity(value, 'trace value');
  const trace = {
    from,
    to,
    value,
    gas: node.gas ?? null,
    gasUsed: node.gasUsed ?? null,
    input: node.input ?? '0x',
    output: node.output ?? '0x',
    type: node.type ?? null,
    callType: node.callType ?? null,
    error: node.error ?? null,
    traceAddress: traceAddressFor(path),
    traceId: `call_${path.join('_') || '0'}`,
    transactionHash: context.transactionHash,
    blockNumber: context.blockNumber,
    blockHash: context.blockHash,
    transactionIndex: context.transactionIndex,
  };
  const children = Array.isArray(node.calls) ? node.calls : [];
  return [trace, ...children.flatMap((child, index) => flattenCallTracer(
    child, [...path, index], context
  ))];
}

function blockTransactionIndex(block, hash) {
  const transactions = Array.isArray(block?.transactions) ? block.transactions : [];
  const index = transactions.findIndex((transaction) => String(
    typeof transaction === 'string' ? transaction : transaction?.hash
  ).toLowerCase() === hash);
  if (index >= 0) return index;
  throw recoveryError(
    `Coinbase CDP recovery could not locate ${hash} in its canonical block`,
    'CDP_RECOVERY_IDENTITY_MISMATCH'
  );
}

function validateCoordinates(transaction, receipt, block, hash, transactionIndex) {
  const tx = normalizedHash(transaction?.hash, 'transaction hash');
  const receiptHash = normalizedHash(receipt?.transactionHash, 'receipt transaction hash');
  if (tx !== hash || receiptHash !== hash) {
    throw recoveryError('Coinbase CDP recovery returned conflicting transaction identities', 'CDP_RECOVERY_IDENTITY_MISMATCH');
  }
  const blockNumber = hexNumber(transaction?.blockNumber, 'transaction block number');
  if (blockNumber !== hexNumber(receipt?.blockNumber, 'receipt block number')
      || blockNumber !== hexNumber(block?.number, 'block number')) {
    throw recoveryError('Coinbase CDP recovery returned conflicting block numbers', 'CDP_RECOVERY_IDENTITY_MISMATCH');
  }
  const blockHash = normalizedBlockHash(transaction?.blockHash, 'transaction block hash');
  if (blockHash !== normalizedBlockHash(receipt?.blockHash, 'receipt block hash')
      || blockHash !== normalizedBlockHash(block?.hash, 'block hash')) {
    throw recoveryError('Coinbase CDP recovery returned conflicting block hashes', 'CDP_RECOVERY_IDENTITY_MISMATCH');
  }
  const txIndex = transaction.transactionIndex == null
    ? transactionIndex : hexNumber(transaction.transactionIndex, 'transaction index');
  if (txIndex !== transactionIndex) {
    throw recoveryError('Coinbase CDP recovery returned a conflicting transaction index', 'CDP_RECOVERY_IDENTITY_MISMATCH');
  }
  if (receipt.transactionIndex != null
      && hexNumber(receipt.transactionIndex, 'receipt transaction index') !== transactionIndex) {
    throw recoveryError('Coinbase CDP recovery returned a conflicting receipt transaction index', 'CDP_RECOVERY_IDENTITY_MISMATCH');
  }
  return { blockNumber, blockHash, transactionIndex: txIndex };
}

function syntheticHistoryItem(transaction, receipt, block, traces, coordinates) {
  const hash = normalizedHash(transaction.hash, 'transaction hash');
  const from = address(transaction.from);
  if (!from) throw recoveryError('Coinbase CDP recovery returned a transaction without a sender', 'CDP_INVALID_RESPONSE');
  const ethereum = {
    hash,
    from,
    to: address(transaction.to),
    value: transaction.value ?? '0x0',
    gas: transaction.gas ?? '0x0',
    gasPrice: transaction.gasPrice ?? '0x0',
    nonce: transaction.nonce ?? '0x0',
    input: transaction.input ?? '0x',
    type: transaction.type ?? null,
    blockNumber: `0x${coordinates.blockNumber.toString(16)}`,
    blockHash: coordinates.blockHash,
    index: `0x${coordinates.transactionIndex.toString(16)}`,
    blockTimestamp: timestamp(block),
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    receipt: {
      ...receipt,
      transactionHash: hash,
      blockNumber: `0x${coordinates.blockNumber.toString(16)}`,
      blockHash: coordinates.blockHash,
      transactionIndex: `0x${coordinates.transactionIndex.toString(16)}`,
      logs: receipt.logs,
    },
    // Core RPC does not provide CDP's decoded tokenTransfers collection. The
    // receipt logs remain canonical evidence and are decoded later by the
    // consensus-RPC effect pass; an empty collection here is explicit rather
    // than an omitted/unknown field.
    tokenTransfers: [],
    flattenedTraces: traces,
  };
  return {
    name: `core-recovery/${hash}`,
    hash,
    blockHash: coordinates.blockHash,
    blockHeight: coordinates.blockNumber,
    status: statusForReceipt(receipt),
    content: { ethereum },
  };
}

function traceCacheKey(blockNumber, blockHash, tracer = 'callTracer') {
  return `${hexQuantity(blockNumber, 'trace block number').toString()}:${normalizedBlockHash(blockHash, 'trace block hash')}:${tracer}`;
}

async function recoverTransaction(client, candidate, {
  onEvidence = null, traceCache = null, loadTrace = null,
} = {}) {
  const hash = normalizedHash(candidate.hash, 'candidate transaction hash');
  const rpc = async (method, params, metadata = {}) => {
    const response = await client.rpcWithEvidence(method, params, 'transaction-recovery');
    await onEvidence?.(response, metadata);
    return response;
  };
  const transactionResponse = await rpc('eth_getTransactionByHash', [hash]);
  const receiptResponse = await rpc('eth_getTransactionReceipt', [hash]);
  const transaction = transactionResponse.body;
  const receipt = receiptResponse.body;
  if (!transaction || !receipt) {
    throw recoveryError(`Coinbase CDP recovery could not find mined transaction ${hash}`, 'CDP_RECOVERY_NOT_FOUND');
  }
  if (!Array.isArray(receipt.logs)) {
    throw recoveryError(
      `Coinbase CDP recovery returned a receipt without a complete logs collection for ${hash}`,
      'CDP_INVALID_RESPONSE'
    );
  }
  const blockNumber = transaction.blockNumber;
  const blockResponse = await rpc('eth_getBlockByNumber', [blockNumber, false]);
  const block = blockResponse.body;
  // Hash-only canonical block membership is required. An expected index is
  // not enough: using it after a provider omitted or reordered transactions
  // could bind another transaction's trace to this wallet history.
  const transactionIndex = blockTransactionIndex(block, hash);
  const coordinates = validateCoordinates(transaction, receipt, block, hash, transactionIndex);
  const traceKey = traceCacheKey(blockNumber, coordinates.blockHash);
  let traceResponse = traceCache?.get(traceKey);
  if (!traceResponse) {
    traceResponse = await loadTrace?.({
      blockNumber: coordinates.blockNumber,
      blockHash: coordinates.blockHash,
      tracer: 'callTracer',
    });
    if (traceResponse) traceCache?.set(traceKey, traceResponse);
  }
  if (!traceResponse) {
    traceResponse = await rpc(
      'debug_traceBlockByNumber', [blockNumber, { tracer: 'callTracer' }],
      { blockHash: coordinates.blockHash, tracer: 'callTracer' }
    );
    traceCache?.set(traceKey, traceResponse);
  }
  if (!Array.isArray(traceResponse.body)) {
    throw recoveryError(
      `Coinbase CDP recovery returned no call trace for ${hash}`,
      'CDP_RECOVERY_TRACE_UNAVAILABLE'
    );
  }
  const traceEntry = traceResponse.body.find((entry) => (
    normalizedHash(entry?.txHash, 'trace transaction hash') === hash
  ));
  if (!traceEntry || !traceEntry.result) {
    throw recoveryError(
      `Coinbase CDP recovery returned no exact call trace for ${hash}`,
      'CDP_RECOVERY_TRACE_UNAVAILABLE'
    );
  }
  const traces = flattenCallTracer(traceEntry.result, [], {
    transactionHash: hash,
    blockNumber: coordinates.blockNumber,
    blockHash: coordinates.blockHash,
    transactionIndex: coordinates.transactionIndex,
  });
  const item = syntheticHistoryItem(transaction, receipt, block, traces, coordinates);
  const rawResponses = [transactionResponse, receiptResponse, blockResponse, traceResponse];
  const rawText = JSON.stringify({
    jsonrpc: '2.0',
    recovery: 'coinbase-cdp-core',
    requests: rawResponses.map((response) => ({
      method: response.method,
      params: response.params,
      response_raw: response.rawText,
    })),
  });
  return {
    item,
    transaction,
    receipt,
    block,
    traces,
    evidence: rawResponses,
    response: {
      body: {
        recovery: 'coinbase-cdp-core',
        item,
        transaction,
        receipt,
        block,
        traces,
      },
      rawText,
      responseSha256: sha256(rawText),
      evidenceIdentitySha256: sha256(stableJson({
        recovery: 'coinbase-cdp-core', hash,
        blockHash: coordinates.blockHash, blockNumber: coordinates.blockNumber,
        responseSha256: sha256(rawText),
      })),
      requestId: rawResponses.map((response) => response.requestId).filter(Boolean).join(',') || null,
    },
    identity: stableJson({ hash, blockHash: coordinates.blockHash, blockNumber: coordinates.blockNumber }),
  };
}

function recoveryCursor(value, fallback = null) {
  if (value == null || value === '') return fallback;
  try {
    const parsed = JSON.parse(value);
    if (parsed?.version === 1 && parsed.phase === 'known-ledger'
        && (parsed.afterKey == null || typeof parsed.afterKey === 'string')
        && (parsed.retryKeys == null
          || (Array.isArray(parsed.retryKeys)
            && parsed.retryKeys.every((key) => typeof key === 'string')))) return parsed;
  } catch { /* an opaque address-history cursor is not a recovery cursor */ }
  return fallback;
}

function candidateKey(candidate) {
  return `${String(candidate.blockNumber ?? 0).padStart(20, '0')}:${String(candidate.hash).toLowerCase()}`;
}

module.exports = {
  candidateKey,
  flattenCallTracer,
  MAX_RECOVERY_CANDIDATES,
  recoveryCursor,
  recoverTransaction,
  recoveryError,
  syntheticHistoryItem,
  traceCacheKey,
};
