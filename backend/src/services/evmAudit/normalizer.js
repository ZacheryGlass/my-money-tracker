'use strict';

const crypto = require('node:crypto');

const TX_HASH_RE = /^0x[0-9a-f]{64}$/;
const BLOCK_HASH_RE = /^0x[0-9a-f]{64}$/;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(
    typeof value === 'string' ? value : stableJson(value)
  ).digest('hex');
}

function safeInteger(value) {
  if (value == null || value === '') return null;
  const text = String(value);
  if (!/^(?:\d+|0x[0-9a-f]+)$/i.test(text)) return null;
  try {
    const parsed = BigInt(text);
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null;
  } catch {
    return null;
  }
}

function address(value) {
  const text = String(value || '').toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(text) ? text : null;
}

function txHash(value) {
  const text = String(value || '').toLowerCase();
  return TX_HASH_RE.test(text) ? text : null;
}

function blockHash(value) {
  const text = String(value || '').toLowerCase();
  return BLOCK_HASH_RE.test(text) ? text : null;
}

function baseObservation(context, {
  evidenceKind, providerObjectKey, payload, tx = null, blockNumber = null,
  block = null, transactionIndex = null, logIndex = null, traceAddress = null,
}) {
  return {
    subjectId: context.subjectId,
    chainId: context.chainId,
    provider: context.provider,
    evidenceKind,
    providerObjectKey,
    txHash: txHash(tx),
    blockNumber: safeInteger(blockNumber),
    blockHash: blockHash(block),
    transactionIndex: safeInteger(transactionIndex),
    logIndex: safeInteger(logIndex),
    traceAddress,
    payload,
    payloadSha256: sha256(payload),
    jobId: context.jobId,
  };
}

function activeChainObservations(context, response) {
  return (response.active_chains || []).map((row) => baseObservation(context, {
    evidenceKind: 'active_chain',
    providerObjectKey: `active-chain:${String(row.chain_id || row.chain || '').toLowerCase()}`,
    payload: row,
    tx: row.last_transaction?.transaction_hash || row.first_transaction?.transaction_hash,
    blockNumber: row.last_transaction?.block_number || row.first_transaction?.block_number,
  }));
}

function historyObservations(context, item) {
  const hash = txHash(item.hash);
  if (!hash) throw new Error('Moralis wallet history returned an invalid transaction hash');
  const common = {
    tx: hash,
    blockNumber: item.block_number,
    block: item.block_hash,
    transactionIndex: item.transaction_index,
  };
  const out = [baseObservation(context, {
    ...common,
    evidenceKind: 'transaction',
    providerObjectKey: `transaction:${hash}`,
    payload: item,
  })];

  // Receipt fields and logs are retained separately so consensus evidence can
  // later replace individual fields without rewriting the raw transaction.
  out.push(baseObservation(context, {
    ...common,
    evidenceKind: 'receipt',
    providerObjectKey: `receipt:${hash}`,
    payload: {
      hash,
      receipt_status: item.receipt_status,
      receipt_gas_used: item.receipt_gas_used,
      receipt_cumulative_gas_used: item.receipt_cumulative_gas_used,
      receipt_contract_address: item.receipt_contract_address,
      logs: item.logs || [],
    },
  }));

  for (const log of (item.logs || [])) {
    const coordinate = safeInteger(log.log_index);
    out.push(baseObservation(context, {
      ...common,
      evidenceKind: 'log',
      providerObjectKey: coordinate == null
        ? `log:${hash}:provider:${sha256(log)}`
        : `log:${hash}:${coordinate}`,
      payload: log,
      logIndex: coordinate,
      blockNumber: log.block_number ?? item.block_number,
      block: log.block_hash ?? item.block_hash,
      transactionIndex: log.transaction_index ?? item.transaction_index,
    }));
  }

  for (const transfer of (item.native_transfers || [])) {
    out.push(baseObservation(context, {
      ...common,
      evidenceKind: 'native_transfer',
      providerObjectKey: `native:${hash}:${sha256({
        from: transfer.from_address, to: transfer.to_address,
        value: transfer.value, internal: transfer.internal_transaction,
      })}`,
      payload: transfer,
    }));
  }

  for (const trace of (item.internal_transactions || [])) {
    const traceAddress = trace.trace_address ?? trace.traceAddress ?? null;
    out.push(baseObservation(context, {
      ...common,
      evidenceKind: 'internal_trace',
      // A missing trace coordinate is intentionally provider-scoped. Never
      // merge two internal calls merely because amount/counterparties match.
      providerObjectKey: traceAddress == null
        ? `internal:${hash}:provider:${sha256(trace)}`
        : `internal:${hash}:${stableJson(traceAddress)}`,
      payload: trace,
      traceAddress,
      blockNumber: trace.block_number ?? item.block_number,
      block: trace.block_hash ?? item.block_hash,
    }));
  }

  for (const transfer of (item.erc20_transfers || [])) {
    const logIndex = safeInteger(transfer.log_index);
    out.push(baseObservation(context, {
      ...common,
      evidenceKind: 'erc20_transfer',
      providerObjectKey: logIndex == null
        ? `erc20:${hash}:provider:${sha256(transfer)}`
        : `erc20:${hash}:${logIndex}`,
      payload: transfer,
      logIndex,
    }));
  }

  for (const transfer of (item.nft_transfers || [])) {
    const logIndex = safeInteger(transfer.log_index);
    const standard = String(transfer.contract_type || transfer.token_standard || '').toUpperCase();
    const evidenceKind = standard === 'ERC1155' ? 'erc1155_transfer' : 'erc721_transfer';
    out.push(baseObservation(context, {
      ...common,
      evidenceKind,
      providerObjectKey: logIndex == null
        ? `${evidenceKind}:${hash}:provider:${sha256(transfer)}`
        : `${evidenceKind}:${hash}:${logIndex}`,
      payload: transfer,
      logIndex,
    }));
  }
  return out;
}

// Coinbase CDP returns one Ethereum transaction object with its receipt,
// logs, token transfers and flattened traces nested under `content.ethereum`.
// Keep every nested coordinate as its own observation so a later RPC check can
// replace a single receipt field without losing the provider's raw evidence.
function cdpHistoryObservations(context, item) {
  const ethereum = item?.content?.ethereum || item?.ethereum || item?.content || {};
  const hash = txHash(item?.hash || ethereum.hash);
  if (!hash) throw new Error('Coinbase CDP address history returned an invalid transaction hash');
  const blockNumber = item.blockHeight ?? ethereum.blockNumber;
  const block = item.blockHash || ethereum.blockHash;
  const transactionIndex = ethereum.index ?? ethereum.transactionIndex
    ?? ethereum.receipt?.transactionIndex ?? ethereum.receipt?.transaction_index;
  const common = { tx: hash, blockNumber, block, transactionIndex };
  const out = [baseObservation(context, {
    ...common,
    evidenceKind: 'transaction',
    providerObjectKey: `transaction:${hash}`,
    payload: item,
  })];
  const receipt = ethereum.receipt || {};
  out.push(baseObservation(context, {
    ...common,
    evidenceKind: 'receipt',
    providerObjectKey: `receipt:${hash}`,
    payload: { ...receipt, transactionHash: receipt.transactionHash || hash },
  }));
  for (const log of (receipt.logs || [])) {
    const logIndex = safeInteger(log.logIndex ?? log.log_index);
    out.push(baseObservation(context, {
      ...common,
      evidenceKind: 'log',
      providerObjectKey: logIndex == null
        ? `log:${hash}:provider:${sha256(log)}` : `log:${hash}:${logIndex}`,
      payload: log,
      logIndex,
      blockNumber: log.blockNumber ?? log.blockHeight ?? blockNumber,
      block: log.blockHash || block,
      transactionIndex: log.transactionIndex ?? transactionIndex,
    }));
  }
  for (const trace of (ethereum.flattenedTraces || [])) {
    const traceAddress = trace.traceAddress ?? trace.trace_address ?? null;
    out.push(baseObservation(context, {
      ...common,
      evidenceKind: 'internal_trace',
      providerObjectKey: traceAddress == null
        ? `internal:${hash}:provider:${sha256(trace)}`
        : `internal:${hash}:${stableJson(traceAddress)}`,
      payload: trace,
      traceAddress,
      blockNumber: trace.blockNumber ?? blockNumber,
      block: trace.blockHash || block,
      transactionIndex: trace.transactionIndex ?? transactionIndex,
    }));
  }
  for (const transfer of (ethereum.tokenTransfers || [])) {
    const nested = transfer.erc1155 ? 'erc1155' : transfer.erc721 || transfer.tokenId != null
      ? 'erc721' : 'erc20';
    const evidenceKind = `${nested}_transfer`;
    const logIndex = safeInteger(transfer.logIndex ?? transfer.log_index);
    const tokenIdentity = nested === 'erc1155'
      ? `${transfer.tokenId ?? transfer.erc1155?.tokenId ?? ''}:${transfer.amount ?? transfer.value ?? ''}`
      : '';
    out.push(baseObservation(context, {
      ...common,
      evidenceKind,
      providerObjectKey: logIndex == null
        ? `${evidenceKind}:${hash}:provider:${sha256(transfer)}`
        : `${evidenceKind}:${hash}:${logIndex}${tokenIdentity ? `:${tokenIdentity}` : ''}`,
      payload: transfer,
      logIndex,
      blockNumber: transfer.blockNumber ?? blockNumber,
      block: transfer.blockHash || block,
      transactionIndex: transfer.transactionIndex ?? transactionIndex,
    }));
  }
  return out;
}

function cdpBalanceObservations(context, balances) {
  if (!Array.isArray(balances)) {
    const error = new Error('Coinbase CDP balances response is not an array');
    error.code = 'CDP_INVALID_RESPONSE';
    throw error;
  }
  return balances.map((balance) => {
    const asset = balance?.asset;
    const invalid = (message) => {
      const error = new Error(`Coinbase CDP returned an invalid balance: ${message}`);
      error.code = 'CDP_INVALID_RESPONSE';
      return error;
    };
    if (!asset || typeof asset !== 'object' || !String(asset.id || '').trim()
        || !String(asset.type || '').trim()) {
      throw invalid('asset identity');
    }
    const rawValue = balance.valueStr ?? balance.value;
    let value;
    try {
      if (rawValue == null || rawValue === '') throw new Error('missing value');
      value = BigInt(rawValue);
      if (value < 0n) throw new Error('negative value');
      if (balance.value != null && BigInt(balance.value) !== value) {
        throw new Error('value and valueStr disagree');
      }
    } catch {
      throw invalid('amount');
    }
    const decimals = Number(balance.decimals);
    if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
      throw invalid('decimals');
    }
    const assetType = String(asset.type).toLowerCase();
    if (assetType === 'erc20' && !/^0x[0-9a-f]{40}$/i.test(String(asset.groupId || ''))) {
      throw invalid('ERC-20 contract identity');
    }
    const assetId = String(asset.id);
    const kind = assetType === 'native'
      ? 'native_balance' : 'token_balance';
    return baseObservation(context, {
      evidenceKind: kind,
      providerObjectKey: `balance:${assetId}`,
      payload: balance,
    });
  });
}

function rpcTransactionObservations(context, transaction, receipt) {
  const hash = txHash(transaction?.hash || receipt?.transactionHash);
  if (!hash) throw new Error('Consensus RPC returned an invalid transaction hash');
  const common = {
    tx: hash,
    blockNumber: transaction.blockNumber == null ? null : BigInt(transaction.blockNumber).toString(),
    block: transaction.blockHash,
    transactionIndex: transaction.transactionIndex == null
      ? null : BigInt(transaction.transactionIndex).toString(),
  };
  const out = [baseObservation(context, {
    ...common,
    evidenceKind: 'transaction',
    providerObjectKey: `transaction:${hash}`,
    payload: transaction,
  }), baseObservation(context, {
    ...common,
    evidenceKind: 'receipt',
    providerObjectKey: `receipt:${hash}`,
    payload: receipt,
  })];
  for (const log of (receipt.logs || [])) {
    const logIndex = log.logIndex == null ? null : Number(BigInt(log.logIndex));
    out.push(baseObservation(context, {
      ...common,
      evidenceKind: 'log',
      providerObjectKey: logIndex == null
        ? `log:${hash}:provider:${sha256(log)}` : `log:${hash}:${logIndex}`,
      payload: log,
      logIndex,
      blockNumber: log.blockNumber == null ? common.blockNumber : BigInt(log.blockNumber).toString(),
      block: log.blockHash || common.block,
      transactionIndex: log.transactionIndex == null
        ? common.transactionIndex : BigInt(log.transactionIndex).toString(),
    }));
  }
  return out;
}

function legacyTransferObservations(context, rows) {
  const kinds = {
    native: 'native_transfer', internal: 'internal_trace', token: 'erc20_transfer',
    nft: 'erc721_transfer', nft1155: 'erc1155_transfer', gas: 'gas',
  };
  return rows.map((row) => baseObservation(context, {
    evidenceKind: kinds[row.transfer_type] || 'native_transfer',
    providerObjectKey: `legacy:${row.transfer_type}:${String(row.tx_hash).toLowerCase()}:${row.ordinal}`,
    payload: row,
    tx: row.tx_hash,
    blockNumber: row.block_number,
  }));
}

function explorerFeedObservations(context, feed, rows) {
  return rows.map((row) => {
    const hash = txHash(row.hash || row.transactionHash);
    if (!hash) throw new Error(`Explorer ${feed} feed returned an invalid transaction hash`);
    const nativeCredit = row.nativeCredit === true;
    const evidenceKind = nativeCredit
      ? 'native_credit' : feed === 'internal' ? 'internal_trace' : 'account_feed';
    const traceAddress = feed === 'internal'
      ? (row.traceAddress ?? row.trace_address
        ?? (/^\d+(?:_\d+)*$/.test(String(row.traceId || ''))
          ? String(row.traceId).split('_').map(Number) : null))
      : null;
    const logIndex = nativeCredit || feed !== 'internal' ? safeInteger(row.logIndex) : null;
    const tokenId = row.tokenID ?? row.token_id ?? '';
    const coordinate = nativeCredit
      ? (logIndex == null ? `provider:${sha256(row)}` : String(logIndex))
      : feed === 'internal'
      ? (traceAddress == null ? `provider:${sha256(row)}` : stableJson(traceAddress))
      : (logIndex == null ? `provider:${sha256(row)}` : `${logIndex}:${tokenId}`);
    const payload = nativeCredit ? {
      ...row,
      native_credit: true,
      log_index: row.logIndex,
      block_hash: row.blockHash,
      transaction_index: row.transactionIndex,
      address: row.address,
      topics: row.topics,
      data: row.data,
    } : row;
    return baseObservation(context, {
      evidenceKind,
      providerObjectKey: `account:${feed}:${hash}:${coordinate}`,
      payload,
      tx: hash,
      blockNumber: row.blockNumber,
      block: row.blockHash,
      transactionIndex: row.transactionIndex,
      logIndex,
      traceAddress,
    });
  });
}

function transactionFromRpc(context, transaction, receipt, selectedObservationId) {
  const wallet = context.address.toLowerCase();
  const sender = address(transaction.from);
  if (!sender) throw new Error('Consensus RPC returned a transaction without a valid sender');
  const type = transaction.type == null ? null : BigInt(transaction.type).toString();
  const protocolSystem = (context.chainId === 10 || context.chainId === 8453) && type === '126';
  return {
    subjectId: context.subjectId,
    chainId: context.chainId,
    txHash: txHash(transaction.hash),
    blockNumber: Number(BigInt(transaction.blockNumber)),
    blockHash: blockHash(transaction.blockHash),
    transactionIndex: transaction.transactionIndex == null
      ? null : Number(BigInt(transaction.transactionIndex)),
    fromAddress: sender,
    toAddress: address(transaction.to),
    nonce: BigInt(transaction.nonce).toString(),
    valueWei: BigInt(transaction.value).toString(),
    input: transaction.input || null,
    transactionType: type,
    receiptStatus: receipt.status == null ? null : Number(BigInt(receipt.status)),
    gasLimit: transaction.gas == null ? null : BigInt(transaction.gas).toString(),
    gasPrice: transaction.gasPrice == null ? null : BigInt(transaction.gasPrice).toString(),
    effectiveGasPrice: receipt.effectiveGasPrice == null
      ? null : BigInt(receipt.effectiveGasPrice).toString(),
    gasUsed: receipt.gasUsed == null ? null : BigInt(receipt.gasUsed).toString(),
    signedness: protocolSystem ? 'protocol_system' : (sender === wallet ? 'user_signed' : 'external_signed'),
    finalityStatus: 'finalized',
    resolutionStatus: 'verified',
    selectedObservationId,
    conflictDetail: null,
  };
}

module.exports = {
  activeChainObservations,
  address,
  blockHash,
  canonicalize,
  cdpBalanceObservations,
  cdpHistoryObservations,
  explorerFeedObservations,
  historyObservations,
  legacyTransferObservations,
  rpcTransactionObservations,
  sha256,
  stableJson,
  transactionFromRpc,
  txHash,
};
