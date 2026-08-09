'use strict';

const { txHash, address, stableJson, sha256 } = require('./normalizer');

const ZERO = '0x0000000000000000000000000000000000000000';

function quantity(value, fallback = null) {
  if (value == null || value === '') return fallback;
  try {
    const result = BigInt(value);
    return result >= 0n ? result.toString() : fallback;
  } catch {
    return fallback;
  }
}

function invalidResponse(message) {
  const error = new Error(message);
  error.code = 'CDP_INVALID_RESPONSE';
  return error;
}

function requiredQuantity(value, field) {
  const parsed = quantity(value);
  if (parsed == null) throw invalidResponse(`Coinbase CDP returned an invalid ${field}`);
  return parsed;
}

function blockNumber(item, ethereum) {
  const value = item.blockHeight ?? ethereum.blockNumber;
  const parsed = quantity(value);
  if (parsed == null || BigInt(parsed) > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(parsed);
}

function timestampSeconds(ethereum) {
  const value = ethereum.blockTimestamp ?? ethereum.timestamp;
  if (value == null) return null;
  const parsed = Date.parse(String(value));
  if (Number.isFinite(parsed)) return String(Math.floor(parsed / 1000));
  return quantity(value);
}

function statusIsError(item, ethereum, nestedStatus = null) {
  const receiptStatus = ethereum.receipt?.status ?? ethereum.status;
  const classify = (value, field) => {
    if (value == null) return null;
    const text = String(value ?? '').toLowerCase();
    if (['0', '0x0', 'failed', 'reverted', 'error', 'false'].includes(text)) return true;
    if (['1', '0x1', 'confirmed', 'success', 'succeeded', 'true'].includes(text)) return false;
    throw invalidResponse(`Coinbase CDP returned an unknown ${field} status`);
  };
  const statuses = [
    classify(receiptStatus, 'receipt'),
    classify(item.status, 'transaction'),
    classify(nestedStatus, 'trace'),
  ].filter((value) => value != null);
  if (!statuses.length) throw invalidResponse('Coinbase CDP returned a mined transaction without a status');
  if (statuses.some(Boolean)) return '1';
  return '0';
}

function traceAddressOf(trace) {
  if (Array.isArray(trace.traceAddress)) return trace.traceAddress.map((value) => Number(value));
  if (Array.isArray(trace.trace_address)) return trace.trace_address.map((value) => Number(value));
  const traceId = String(trace.traceId || '');
  const suffix = traceId.includes('_') ? traceId.slice(traceId.lastIndexOf('_') + 1) : '';
  if (/^\d+(?:_\d+)*$/.test(suffix)) return suffix.split('_').map(Number);
  return null;
}

function opStackType(value) {
  if (value == null) return null;
  try {
    return BigInt(value) === 126n ? '0x7e' : String(value).toLowerCase();
  } catch {
    return String(value).toLowerCase();
  }
}

function nativeCreditRows(item, ethereum, wallet, config) {
  if (!config) return [];
  const contract = address(config.contract);
  const topic0 = String(config.topic0 || '').toLowerCase();
  if (!contract || !/^0x[0-9a-f]{64}$/.test(topic0)
      || statusIsError(item, ethereum) === '1') return [];
  const rows = [];
  for (const log of (ethereum.receipt?.logs || [])) {
    const topics = Array.isArray(log.topics)
      ? log.topics.map((topic) => String(topic).toLowerCase()) : [];
    if (address(log.address) !== contract || topics[0] !== topic0) continue;
    const receiverIndex = Number(config.userTopicIndex ?? 2);
    const receiverTopic = topics[receiverIndex] || '';
    const receiver = /^0x[0-9a-f]{64}$/.test(receiverTopic)
      ? address(`0x${receiverTopic.slice(-40)}`) : null;
    const data = String(log.data || '').toLowerCase();
    const amountWord = /^0x[0-9a-f]{64}/.test(data) ? data.slice(2, 66) : null;
    const amount = amountWord && /^[0-9a-f]{64}$/.test(amountWord)
      ? quantity(`0x${amountWord}`) : null;
    if (receiver == null || amount == null) {
      throw invalidResponse('Coinbase CDP returned a malformed configured native-credit log');
    }
    if (receiver !== wallet) continue;
    rows.push(transferBase(item, ethereum, {
      from: contract,
      to: wallet,
      value: amount,
      logIndex: log.logIndex ?? log.log_index ?? null,
      isError: '0',
      nativeCredit: true,
    }));
  }
  return rows;
}

function transferBase(item, ethereum, fields) {
  const hash = txHash(item.hash || ethereum.hash);
  const block = blockNumber(item, ethereum);
  const timeStamp = timestampSeconds(ethereum);
  if (!hash || block == null || timeStamp == null) {
    const error = new Error('Coinbase CDP returned an incomplete mined transaction coordinate');
    error.code = 'CDP_INVALID_RESPONSE';
    throw error;
  }
  const logIndex = fields.logIndex == null ? null : quantity(fields.logIndex);
  return {
    hash,
    blockNumber: String(block),
    blockHash: item.blockHash || ethereum.blockHash || null,
    timeStamp,
    isError: statusIsError(item, ethereum, fields.status),
    ...fields,
    transactionIndex: quantity(
      ethereum.index ?? ethereum.transactionIndex
        ?? ethereum.receipt?.transactionIndex ?? ethereum.receipt?.transaction_index
    ),
    ...(fields.logIndex == null ? {} : { logIndex }),
  };
}

function transactionRows(item, walletAddress, { nativeCredit = null } = {}) {
  const ethereum = item.content?.ethereum || item.ethereum || item.content || {};
  const hash = txHash(item.hash || ethereum.hash);
  if (!hash) throw new Error('Coinbase CDP returned an invalid transaction hash');
  if (!ethereum.receipt || typeof ethereum.receipt !== 'object'
      || !Array.isArray(ethereum.receipt.logs)) {
    throw invalidResponse('Coinbase CDP returned no complete receipt log collection');
  }
  if (!Array.isArray(ethereum.flattenedTraces)) {
    throw invalidResponse('Coinbase CDP returned no complete flattened trace collection');
  }
  if (!Array.isArray(ethereum.tokenTransfers)) {
    throw invalidResponse('Coinbase CDP returned no complete token transfer collection');
  }
  const failed = statusIsError(item, ethereum);
  const gasUsed = requiredQuantity(
    ethereum.receipt?.gasUsed ?? ethereum.gasUsed, 'receipt gas used'
  );
  const effectiveGasPrice = requiredQuantity(
    ethereum.receipt?.effectiveGasPrice ?? ethereum.effectiveGasPrice ?? ethereum.gasPrice,
    'receipt effective gas price'
  );
  const gasPrice = quantity(ethereum.gasPrice, effectiveGasPrice);
  const feeWei = (BigInt(gasUsed) * BigInt(effectiveGasPrice)).toString();
  const input = ethereum.input || '0x';
  const sender = address(ethereum.from);
  if (!sender) {
    const error = new Error('Coinbase CDP returned a mined transaction without a valid sender');
    error.code = 'CDP_INVALID_RESPONSE';
    throw error;
  }
  const value = requiredQuantity(ethereum.value, 'transaction value');
  const gas = requiredQuantity(ethereum.gas, 'transaction gas');
  const common = {
    from: sender,
    to: address(ethereum.to) || null,
    value,
    gas,
    gasUsed,
    gasPrice,
    feeWei,
    isError: failed,
    input,
    methodId: /^0x[0-9a-f]{8}/i.test(input) ? input.slice(0, 10).toLowerCase() : null,
    functionName: null,
    opStackType: opStackType(ethereum.type),
    opStackSourceHash: ethereum.sourceHash || null,
    opStackMintWei: quantity(ethereum.mint),
  };
  const wallet = walletAddress.toLowerCase();
  const recipient = address(ethereum.to);
  const normal = sender === wallet || recipient === wallet
    ? [transferBase(item, ethereum, common)] : [];
  const internal = [];
  if (ethereum.flattenedTraces != null && !Array.isArray(ethereum.flattenedTraces)) {
    throw invalidResponse('Coinbase CDP returned a non-array flattened trace collection');
  }
  // A parent-state debug_traceCall is useful raw evidence, but it is not an
  // exact reconstruction of a mined transaction when earlier transactions in
  // the same block changed state. Keep it in the retained CDP item/audit
  // evidence, but never project it into the ordinary internal-transfer feed.
  const internalTraces = (ethereum.flattenedTraces || []).filter((trace) => (
    ethereum.traceProvenance !== 'parent-state-replay'
      && trace?.traceProvenance !== 'parent-state-replay'
  ));
  for (const trace of internalTraces) {
    const traceFrom = address(trace.from);
    const traceTo = address(trace.to);
    if (!traceFrom || !traceTo || (traceFrom !== wallet && traceTo !== wallet)) continue;
    internal.push(transferBase(item, ethereum, {
      from: traceFrom,
      to: traceTo,
      value: requiredQuantity(trace.value, 'internal trace value'),
      isError: statusIsError(item, ethereum, trace.status ?? (trace.error ? '1' : null)),
      traceAddress: traceAddressOf(trace),
      traceId: trace.traceId || null,
    }));
  }

  const token = [];
  const nft = [];
  const nft1155 = [];
  if (ethereum.tokenTransfers != null && !Array.isArray(ethereum.tokenTransfers)) {
    throw invalidResponse('Coinbase CDP returned a non-array token transfer collection');
  }
  for (const transfer of (ethereum.tokenTransfers || [])) {
    const from = address(transfer.fromAddress || transfer.from_address || transfer.from);
    const to = address(transfer.toAddress || transfer.to_address || transfer.to);
    const contract = address(transfer.tokenAddress || transfer.token_address || transfer.address);
    if (!from || !to || !contract || (from !== wallet && to !== wallet)) continue;
    const base = transferBase(item, ethereum, {
      from, to, contractAddress: contract,
      logIndex: transfer.logIndex ?? transfer.log_index ?? null,
      tokenSymbol: transfer.tokenSymbol || transfer.token_symbol || null,
      tokenDecimal: transfer.decimals ?? transfer.tokenDecimal ?? transfer.token_decimals ?? null,
      tokenID: transfer.tokenId ?? transfer.tokenID ?? null,
      tokenValue: transfer.value ?? transfer.amount ?? null,
      isError: failed,
    });
    const erc20 = transfer.erc20;
    const erc721 = transfer.erc721;
    const erc1155 = transfer.erc1155;
    if (erc1155) {
      const ids = Array.isArray(erc1155.tokenIds)
        ? erc1155.tokenIds : [erc1155.tokenId ?? base.tokenID];
      const values = Array.isArray(erc1155.values)
        ? erc1155.values : [erc1155.value ?? base.tokenValue];
      if (!ids.length || ids.length !== values.length) {
        throw invalidResponse('Coinbase CDP returned mismatched ERC-1155 ids and values');
      }
      ids.forEach((id, index) => {
        nft1155.push({
          ...base,
          tokenID: requiredQuantity(id, 'ERC-1155 token id'),
          tokenValue: requiredQuantity(values[index], 'ERC-1155 token value'),
        });
      });
    } else if (erc721 || base.tokenID != null) {
      nft.push({
        ...base,
        tokenID: requiredQuantity(erc721?.tokenId ?? base.tokenID, 'ERC-721 token id'),
        tokenValue: '1',
      });
    } else if (erc20 || base.tokenValue != null) {
      token.push({
        ...base,
        value: requiredQuantity(erc20?.value ?? base.tokenValue, 'ERC-20 token value'),
      });
    }
  }

  // Keep the top-level transaction even when it is a zero-value contract call.
  // normalizeFeeds intentionally makes its canonical ledger representation the
  // gas leg; the raw CDP page and audit evidence retain the zero-value call.
  return {
    normal,
    internal,
    token,
    nft,
    nft1155,
    statesync: nativeCreditRows(item, ethereum, wallet, nativeCredit),
  };
}

function normalizePage(walletAddress, items, { nativeCredit = null } = {}) {
  const feeds = { normal: [], internal: [], token: [], nft: [], nft1155: [], statesync: [] };
  const uniqueItems = dedupeItems(items);
  let maxBlock = null;
  for (const item of uniqueItems) {
    const hash = txHash(item.hash || item.content?.ethereum?.hash || item.ethereum?.hash);
    if (!hash) throw new Error('Coinbase CDP page contained a transaction without a valid hash');
    const ethereum = item.content?.ethereum || item.ethereum || item.content || {};
    if (blockNumber(item, ethereum) == null || timestampSeconds(ethereum) == null) {
      throw invalidResponse('Coinbase CDP page contained a transaction without a safe mined coordinate');
    }
    const rows = transactionRows(item, walletAddress, { nativeCredit });
    for (const [feed, entries] of Object.entries(rows)) feeds[feed].push(...entries);
    const current = blockNumber(item, ethereum);
    if (Number.isSafeInteger(current)) maxBlock = maxBlock == null ? current : Math.max(maxBlock, current);
  }
  for (const rows of Object.values(feeds)) rows.scannedThroughBlock = maxBlock;
  return {
    feeds,
    transactions: uniqueItems.map((item) => txHash(
      item.hash || item.content?.ethereum?.hash || item.ethereum?.hash
    )),
    maxBlock,
    itemCount: items.length,
  };
}

// Keep one identity/fingerprint map across pages and restarts. A repeated
// transaction at the same coordinate is harmless; the same hash with changed
// coordinates or economics is an integrity conflict and freezes the cursor.
function itemIdentity(item) {
  const hash = txHash(item?.hash || item?.content?.ethereum?.hash || item?.ethereum?.hash);
  const ethereum = item?.content?.ethereum || item?.ethereum || item?.content || {};
  return {
    hash,
    identity: stableJson({
      hash,
      blockHash: item?.blockHash || ethereum.blockHash || null,
      blockHeight: item?.blockHeight ?? ethereum.blockNumber ?? null,
    }),
    fingerprint: stableJson(item),
  };
}

function assertNoConflicts(items, seen = new Map()) {
  if (!Array.isArray(items)) throw invalidResponse('Coinbase CDP transaction page is not an array');
  for (const item of items) {
    const current = itemIdentity(item);
    if (!current.hash) throw invalidResponse('Coinbase CDP page contained a transaction without a valid hash');
    const previous = seen.get(current.hash);
    if (previous && (previous.identity !== current.identity || previous.fingerprint !== current.fingerprint)) {
      const error = new Error(`Coinbase CDP returned conflicting data for ${current.hash}`);
      error.code = 'CDP_CONFLICTING_TRANSACTION';
      throw error;
    }
    if (!previous) seen.set(current.hash, current);
  }
}

// Recovery pages intentionally omit CDP's decoded tokenTransfers collection,
// so a later full address-history item may enrich the same transaction. The
// mined coordinate is still authoritative: a changed block hash or height is
// an integrity conflict even when economics are partial.
function assertNoCoordinateConflicts(items, seen = new Map()) {
  if (!Array.isArray(items)) throw invalidResponse('Coinbase CDP transaction page is not an array');
  for (const item of items) {
    const current = itemIdentity(item);
    if (!current.hash) throw invalidResponse('Coinbase CDP page contained a transaction without a valid hash');
    const previous = seen.get(current.hash);
    if (previous && previous.identity !== current.identity) {
      const error = new Error(`Coinbase CDP returned conflicting coordinates for ${current.hash}`);
      error.code = 'CDP_CONFLICTING_TRANSACTION';
      throw error;
    }
    if (!previous) seen.set(current.hash, current);
  }
}

function dedupeItems(items, seen = new Map()) {
  if (!Array.isArray(items)) throw invalidResponse('Coinbase CDP transaction page is not an array');
  const unique = [];
  for (const item of items) {
    const current = itemIdentity(item);
    const hash = current.hash;
    if (!hash) throw invalidResponse('Coinbase CDP page contained a transaction without a valid hash');
    const previous = seen.get(hash);
    if (previous) {
      if (previous.identity !== current.identity || previous.fingerprint !== current.fingerprint) {
        const error = new Error(`Coinbase CDP returned conflicting data for ${hash}`);
        error.code = 'CDP_CONFLICTING_TRANSACTION';
        throw error;
      }
      continue;
    }
    seen.set(hash, current);
    unique.push(item);
  }
  return unique;
}

module.exports = {
  ZERO,
  normalizePage,
  quantity,
  statusIsError,
  transactionRows,
  nativeCreditRows,
  dedupeItems,
  assertNoConflicts,
  assertNoCoordinateConflicts,
  itemIdentity,
  sha256,
};
