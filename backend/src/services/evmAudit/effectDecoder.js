'use strict';

const { keccak_256 } = require('@noble/hashes/sha3.js');
const { bytesToHex } = require('@noble/hashes/utils.js');

function eventTopic(signature) {
  return `0x${bytesToHex(keccak_256(new TextEncoder().encode(signature)))}`;
}

const TOPICS = {
  transfer: eventTopic('Transfer(address,address,uint256)'),
  transferSingle: eventTopic('TransferSingle(address,address,address,uint256,uint256)'),
  transferBatch: eventTopic('TransferBatch(address,address,address,uint256[],uint256[])'),
};

function normalizedAddress(value) {
  const text = String(value || '').toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(text) ? text : null;
}

function topicAddress(value) {
  const text = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(text)) return null;
  return normalizedAddress(`0x${text.slice(-40)}`);
}

function words(data) {
  const text = String(data || '').toLowerCase();
  if (!/^0x(?:[0-9a-f]{64})*$/.test(text)) return null;
  return text.slice(2).match(/.{64}/g) || [];
}

function wordInteger(value) {
  if (!/^[0-9a-f]{64}$/.test(String(value || ''))) return null;
  try { return BigInt(`0x${value}`); } catch { return null; }
}

function direction(wallet, from, to) {
  if (from === wallet && to === wallet) return 'self';
  if (from === wallet) return 'out';
  if (to === wallet) return 'in';
  return null;
}

function quantity(value) {
  const text = String(value ?? '');
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(text)) return null;
  try { return BigInt(text); } catch { return null; }
}

function baseEffect(context, data) {
  return {
    subjectId: context.subjectId,
    chainId: context.chainId,
    txHash: String(data.txHash).toLowerCase(),
    effectKey: data.effectKey,
    effectType: data.effectType,
    direction: data.direction,
    logIndex: data.logIndex ?? null,
    traceAddress: data.traceAddress ?? null,
    fromAddress: data.fromAddress ?? null,
    toAddress: data.toAddress ?? null,
    valueUnits: String(data.valueUnits),
    tokenContract: data.tokenContract ?? null,
    tokenStandard: data.tokenStandard ?? null,
    tokenId: data.tokenId ?? null,
    tokenDecimals: data.tokenDecimals ?? null,
    resolutionStatus: data.resolutionStatus || 'verified',
    selectedObservationId: data.selectedObservationId ?? null,
    conflictDetail: data.conflictDetail ?? null,
    evidenceObservationIds: data.evidenceObservationIds || [],
  };
}

function decodeBatch(dataWords, offsetWord) {
  const offset = wordInteger(offsetWord);
  if (offset == null || offset % 32n !== 0n || offset > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const start = Number(offset / 32n);
  const length = wordInteger(dataWords[start]);
  if (length == null || length > 10_000n) return null;
  const count = Number(length);
  if (start + 1 + count > dataWords.length) return null;
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const value = wordInteger(dataWords[start + 1 + index]);
    if (value == null) return null;
    values.push(value);
  }
  return values;
}

function effectsFromRpc(context, transaction, receipt, observationIds = new Map()) {
  const wallet = context.address.toLowerCase();
  const hash = String(transaction.hash).toLowerCase();
  const from = normalizedAddress(transaction.from);
  const to = normalizedAddress(transaction.to);
  const out = [];
  const txObservation = observationIds.get(`transaction:${hash}`) || null;
  const receiptObservation = observationIds.get(`receipt:${hash}`) || null;
  const receiptSucceeded = receipt.status == null || BigInt(receipt.status) !== 0n;
  const transactionType = transaction.type == null ? null : BigInt(transaction.type);
  const value = BigInt(transaction.value || '0x0');
  const nativeDirection = direction(wallet, from, to);
  const minted = transaction.mint == null ? 0n : BigInt(transaction.mint);
  if (transactionType === 126n && from === wallet && minted > 0n) {
    out.push(baseEffect(context, {
      txHash: hash, effectKey: `protocol-mint:${hash}`, effectType: 'native_credit',
      direction: 'in', fromAddress: context.chain?.opStackDeposits?.creditSource || null,
      toAddress: wallet, valueUnits: minted,
      selectedObservationId: txObservation,
      evidenceObservationIds: [txObservation, receiptObservation].filter(Boolean),
    }));
  }
  if (receiptSucceeded && value > 0n && nativeDirection && !(transactionType === 126n && nativeDirection === 'self')) {
    out.push(baseEffect(context, {
      txHash: hash, effectKey: `native:${hash}`, effectType: 'native',
      direction: nativeDirection, fromAddress: from, toAddress: to,
      valueUnits: value, selectedObservationId: txObservation,
      evidenceObservationIds: [txObservation].filter(Boolean),
    }));
  }

  if (from === wallet && transactionType !== 126n) {
    const gasUsed = BigInt(receipt.gasUsed || '0x0');
    const price = BigInt(receipt.effectiveGasPrice || transaction.gasPrice || '0x0');
    out.push(baseEffect(context, {
      txHash: hash, effectKey: `gas:${hash}`, effectType: 'gas', direction: 'out',
      fromAddress: wallet, toAddress: to, valueUnits: gasUsed * price,
      selectedObservationId: receiptObservation,
      evidenceObservationIds: [txObservation, receiptObservation].filter(Boolean),
    }));
  }

  for (const log of receiptSucceeded ? (receipt.logs || []) : []) {
    const logIndex = Number(BigInt(log.logIndex));
    const logObservation = observationIds.get(`log:${hash}:${logIndex}`) || null;
    const logTopics = (log.topics || []).map((topic) => String(topic).toLowerCase());
    const topic0 = logTopics[0];
    const contract = normalizedAddress(log.address);
    const dataWords = words(log.data);

    const chain = context.chain;
    const nativeCredit = chain?.auditNativeCredits || chain?.stateSyncDeposits;
    if (nativeCredit
        && contract === nativeCredit.contract.toLowerCase()
        && topic0 === nativeCredit.topic0.toLowerCase()) {
      const receiverIndex = Number(nativeCredit.userTopicIndex ?? 2);
      const receiver = topicAddress(logTopics[receiverIndex]);
      const amount = dataWords && wordInteger(dataWords[0]);
      if (receiver === wallet && amount != null) {
        out.push(baseEffect(context, {
          txHash: hash, effectKey: `native-credit:${hash}:${logIndex}`,
          effectType: 'native_credit', direction: 'in', logIndex,
          fromAddress: contract, toAddress: wallet, valueUnits: amount,
          selectedObservationId: logObservation,
          evidenceObservationIds: [receiptObservation, logObservation].filter(Boolean),
        }));
      }
      continue;
    }

    if (topic0 === TOPICS.transfer && contract) {
      const transferFrom = topicAddress(logTopics[1]);
      const transferTo = topicAddress(logTopics[2]);
      const transferDirection = direction(wallet, transferFrom, transferTo);
      if (!transferDirection) continue;
      if (logTopics.length >= 4) {
        const tokenId = wordInteger(logTopics[3].slice(2));
        if (tokenId == null) continue;
        out.push(baseEffect(context, {
          txHash: hash, effectKey: `erc721:${hash}:${logIndex}`,
          effectType: 'erc721', direction: transferDirection, logIndex,
          fromAddress: transferFrom, toAddress: transferTo, valueUnits: 1,
          tokenContract: contract, tokenStandard: 'erc721', tokenId: tokenId.toString(),
          tokenDecimals: 0, selectedObservationId: logObservation,
          evidenceObservationIds: [receiptObservation, logObservation].filter(Boolean),
        }));
      } else {
        const amount = dataWords && wordInteger(dataWords[0]);
        if (amount == null) continue;
        out.push(baseEffect(context, {
          txHash: hash, effectKey: `erc20:${hash}:${logIndex}`,
          effectType: 'erc20', direction: transferDirection, logIndex,
          fromAddress: transferFrom, toAddress: transferTo, valueUnits: amount,
          tokenContract: contract, tokenStandard: 'erc20',
          selectedObservationId: logObservation,
          evidenceObservationIds: [receiptObservation, logObservation].filter(Boolean),
        }));
      }
      continue;
    }

    if (topic0 === TOPICS.transferSingle && contract && dataWords?.length >= 2) {
      const transferFrom = topicAddress(logTopics[2]);
      const transferTo = topicAddress(logTopics[3]);
      const transferDirection = direction(wallet, transferFrom, transferTo);
      const tokenId = wordInteger(dataWords[0]);
      const amount = wordInteger(dataWords[1]);
      if (!transferDirection || tokenId == null || amount == null) continue;
      out.push(baseEffect(context, {
        txHash: hash, effectKey: `erc1155:${hash}:${logIndex}:${tokenId}`,
        effectType: 'erc1155', direction: transferDirection, logIndex,
        fromAddress: transferFrom, toAddress: transferTo, valueUnits: amount,
        tokenContract: contract, tokenStandard: 'erc1155', tokenId: tokenId.toString(),
        tokenDecimals: 0, selectedObservationId: logObservation,
        evidenceObservationIds: [receiptObservation, logObservation].filter(Boolean),
      }));
      continue;
    }

    if (topic0 === TOPICS.transferBatch && contract && dataWords?.length >= 2) {
      const transferFrom = topicAddress(logTopics[2]);
      const transferTo = topicAddress(logTopics[3]);
      const transferDirection = direction(wallet, transferFrom, transferTo);
      const ids = decodeBatch(dataWords, dataWords[0]);
      const amounts = decodeBatch(dataWords, dataWords[1]);
      if (!transferDirection || !ids || !amounts || ids.length !== amounts.length) continue;
      for (let index = 0; index < ids.length; index += 1) {
        out.push(baseEffect(context, {
          txHash: hash, effectKey: `erc1155:${hash}:${logIndex}:${ids[index]}`,
          effectType: 'erc1155', direction: transferDirection, logIndex,
          fromAddress: transferFrom, toAddress: transferTo, valueUnits: amounts[index],
          tokenContract: contract, tokenStandard: 'erc1155', tokenId: ids[index].toString(),
          tokenDecimals: 0, selectedObservationId: logObservation,
          evidenceObservationIds: [receiptObservation, logObservation].filter(Boolean),
        }));
      }
    }
  }
  return out;
}

function internalObservationFields(observation, wallet) {
  const payload = observation.payload_json || {};
  if (payload.is_error === true || payload.is_error === '1'
      || payload.isError === true || payload.isError === '1'
      || payload.success === false || payload.error != null) return null;
  const from = normalizedAddress(payload.from_address ?? payload.from);
  const to = normalizedAddress(payload.to_address ?? payload.to);
  const value = quantity(payload.value_wei ?? payload.value);
  const effectDirection = direction(wallet, from, to);
  if (!from || !to || value == null || value <= 0n || !effectDirection) return null;
  return { from, to, value, effectDirection };
}

// Receipts cannot prove internal calls. Promote trace-provider evidence without
// pretending it is consensus evidence. When an independent trace provider and
// the existing ledger contain one unambiguous identical effect, retain both
// evidence links and mark that effect verified; otherwise it remains provisional
// and therefore blocks a gap-free audit. Moralis is the indexed source for
// Gnosis; Blockscout is only a finite fallback for chains without it.
function effectsFromInternalObservations(context, observations) {
  const wallet = context.address.toLowerCase();
  const byTransaction = new Map();
  for (const observation of observations) {
    if (!observation.tx_hash) continue;
    const rows = byTransaction.get(observation.tx_hash) || [];
    rows.push(observation);
    byTransaction.set(observation.tx_hash, rows);
  }

  const effects = [];
  for (const [hash, rows] of byTransaction) {
    const internalRows = rows.filter((row) => row.evidence_kind !== 'native_credit'
      && row.payload_json?.native_credit !== true);
    const indexedProviders = ['moralis'];
    const explorer = internalRows.filter((row) => ['blockscout', 'etherscan'].includes(row.provider));
    const explorerProvider = ['blockscout', 'etherscan']
      .find((provider) => explorer.some((row) => row.provider === provider));
    const selectedProvider = indexedProviders.find((provider) =>
      internalRows.some((row) => row.provider === provider)
    ) || explorerProvider || 'existing-ledger';
    const selected = internalRows.filter((row) => row.provider === selectedProvider);
    const legacyBySignature = new Map();
    for (const row of rows.filter((candidate) => candidate.provider === 'existing-ledger')) {
      const fields = internalObservationFields(row, wallet);
      if (!fields) continue;
      const signature = `${fields.from}:${fields.to}:${fields.value}`;
      const matches = legacyBySignature.get(signature) || [];
      matches.push(row);
      legacyBySignature.set(signature, matches);
    }

    const selectedCounts = new Map();
    for (const row of selected) {
      const fields = internalObservationFields(row, wallet);
      if (!fields) continue;
      const signature = `${fields.from}:${fields.to}:${fields.value}`;
      selectedCounts.set(signature, (selectedCounts.get(signature) || 0) + 1);
    }
    for (const row of selected) {
      const fields = internalObservationFields(row, wallet);
      if (!fields) continue;
      const signature = `${fields.from}:${fields.to}:${fields.value}`;
      const legacyMatches = ['moralis', 'blockscout', 'etherscan'].includes(row.provider)
        ? (legacyBySignature.get(signature) || []) : [];
      const independentlyVerified = row.trace_address != null
        && legacyMatches.length === 1
        && legacyMatches[0].trace_address != null
        && JSON.stringify(legacyMatches[0].trace_address) === JSON.stringify(row.trace_address)
        && selectedCounts.get(signature) === 1;
      const traceIdentity = row.trace_address == null
        ? `${row.provider}:${row.provider_object_key}`
        : `trace:${JSON.stringify(row.trace_address)}`;
      effects.push(baseEffect(context, {
        txHash: hash,
        effectKey: `internal:${hash}:${traceIdentity}`,
        effectType: 'internal',
        direction: fields.effectDirection,
        traceAddress: row.trace_address,
        fromAddress: fields.from,
        toAddress: fields.to,
        valueUnits: fields.value,
        resolutionStatus: independentlyVerified ? 'verified' : 'provisional',
        selectedObservationId: row.id,
        evidenceObservationIds: [row.id, ...(independentlyVerified ? legacyMatches.map((match) => match.id) : [])],
      }));
    }
  }
  for (const row of observations.filter((candidate) => candidate.evidence_kind === 'native_credit'
    || candidate.payload_json?.native_credit === true)) {
    if (!row.tx_hash) continue;
    const fields = internalObservationFields(row, wallet);
    if (!fields) continue;
    const logIndex = row.log_index ?? row.payload_json?.logIndex ?? null;
    const coordinate = logIndex == null ? `native-credit:${row.tx_hash}:unproven`
      : `native-credit:${row.tx_hash}:${Number(logIndex)}`;
    effects.push(baseEffect(context, {
      txHash: row.tx_hash, effectKey: coordinate, effectType: 'native_credit',
      direction: fields.effectDirection, logIndex,
      fromAddress: fields.from, toAddress: fields.to, valueUnits: fields.value,
      resolutionStatus: 'provisional', selectedObservationId: row.id,
      evidenceObservationIds: [row.id],
    }));
  }
  return effects;
}

module.exports = { TOPICS, effectsFromInternalObservations, effectsFromRpc, eventTopic };
