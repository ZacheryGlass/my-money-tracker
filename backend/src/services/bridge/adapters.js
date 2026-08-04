'use strict';

// Pure protocol decoders for bridge-match-v1. They receive only independently
// fetched transaction/receipt data and chain-scoped endpoint rows. No adapter
// sees another activity, an amount window, or a symbol alias, so it cannot turn
// similarity into identity by accident.

const { keccak_256 } = require('@noble/hashes/sha3.js');
const { bytesToHex, concatBytes, hexToBytes } = require('@noble/hashes/utils.js');

const RULE_VERSION = 'bridge-match-v1';
const HASH_RE = /^0x[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

const lower = (value) => String(value || '').toLowerCase();

function eventTopic(signature) {
  return `0x${bytesToHex(keccak_256(new TextEncoder().encode(signature)))}`;
}

function bytes32(value) {
  const normalized = lower(value);
  return HASH_RE.test(normalized) ? normalized : null;
}

function logIndex(log) {
  const raw = log?.logIndex;
  const parsed = typeof raw === 'string' && /^0x[0-9a-f]+$/i.test(raw)
    ? Number.parseInt(raw, 16)
    : Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function dataWord(data, index) {
  const normalized = lower(data);
  if (!/^0x(?:[0-9a-f]{64})*$/.test(normalized)) return null;
  const start = 2 + index * 64;
  return normalized.length >= start + 64 ? `0x${normalized.slice(start, start + 64)}` : null;
}

function uintWord(value) {
  const normalized = bytes32(value);
  if (!normalized) return null;
  try { return BigInt(normalized); } catch { return null; }
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

function addressWord(value) {
  const normalized = bytes32(value);
  if (!normalized || !/^0x0{24}[0-9a-f]{40}$/.test(normalized)) return null;
  return `0x${normalized.slice(-40)}`;
}

function endpointProtocols(envelope, log = null) {
  const chainId = Number(envelope.chain_id);
  const addresses = new Set([
    lower(log?.address),
    lower(envelope.transaction?.to),
    lower(envelope.receipt?.to),
  ].filter((value) => ADDRESS_RE.test(value)));
  return new Set((envelope.endpoints || [])
    .filter((endpoint) => Number(endpoint.chain_id) === chainId
      && addresses.has(lower(endpoint.address)))
    .map((endpoint) => endpoint.protocol));
}

function evidence(envelope, log, {
  protocol, family_version, role, direction, correlation_key, status = 'pending',
  asset_id = null, amount = null, fee_amount = null, details = {},
}) {
  const finality = envelope.provider_boundary?.finality || {
    status: 'unknown', method: 'missing_provider_finality_boundary',
  };
  return {
    protocol,
    family_version,
    role,
    direction,
    correlation_key,
    status,
    asset_id,
    amount,
    fee_amount,
    rule_version: RULE_VERSION,
    wallet_id: Number(envelope.wallet_id),
    chain_id: Number(envelope.chain_id),
    tx_hash: lower(envelope.tx_hash),
    receipt_id: envelope.receipt_id == null ? null : Number(envelope.receipt_id),
    log_index: log ? logIndex(log) : null,
    evidence: {
      topic0: lower(log?.topics?.[0]) || null,
      log_address: lower(log?.address) || null,
      block_hash: lower(envelope.receipt?.blockHash) || null,
      finality,
      ...details,
    },
  };
}

const TOPICS = Object.freeze({
  opTransactionDeposited: eventTopic('TransactionDeposited(address,address,uint256,bytes)'),
  opMessagePassed: eventTopic('MessagePassed(uint256,address,address,uint256,uint256,bytes,bytes32)'),
  opWithdrawalFinalized: eventTopic('WithdrawalFinalized(bytes32,bool)'),
  arbL2ToL1Tx: eventTopic('L2ToL1Tx(address,address,uint256,uint256,uint256,uint256,uint256,uint256,bytes)'),
  arbOutboxExecuted: eventTopic('OutBoxTransactionExecuted(address,address,uint256,uint256)'),
  lineaMessageSent: eventTopic('MessageSent(address,address,uint256,uint256,uint256,bytes,bytes32)'),
  lineaMessageClaimed: eventTopic('MessageClaimed(bytes32)'),
  gnosisAffirmationCompleted: eventTopic('AffirmationCompleted(address,uint256,bytes32)'),
  gnosisRelayedMessage: eventTopic('RelayedMessage(address,uint256,bytes32)'),
  zksyncDepositFinalized: eventTopic('BridgehubDepositFinalized(uint256,bytes32,bytes32)'),
  acrossV2Deposit: eventTopic('FundsDeposited(uint256,uint256,uint256,int64,uint32,uint32,address,address,address,bytes)'),
  acrossV2Fill: eventTopic('FilledRelay(uint256,uint256,uint256,uint256,uint256,uint256,int64,int64,uint32,address,address,address,address,bytes,(int64,address,bytes))'),
  acrossV3Deposit: eventTopic('V3FundsDeposited(address,address,uint256,uint256,uint256,uint32,uint32,uint32,uint32,address,address,address,bytes)'),
  acrossV3Fill: eventTopic('FilledV3Relay(address,address,uint256,uint256,uint256,uint256,uint32,uint32,uint32,address,address,address,address,bytes,(address,bytes,uint256,uint8))'),
  acrossCurrentDeposit: eventTopic('FundsDeposited(bytes32,bytes32,uint256,uint256,uint256,uint256,uint32,uint32,uint32,bytes32,bytes32,bytes32,bytes)'),
  acrossCurrentFill: eventTopic('FilledRelay(bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint32,uint32,bytes32,bytes32,bytes32,bytes32,bytes32,(bytes32,bytes32,uint256,uint8))'),
});

function opSourceHash(blockHash, index) {
  const block = bytes32(blockHash);
  if (!block || !Number.isSafeInteger(index) || index < 0) return null;
  const indexBytes = new Uint8Array(32);
  let remaining = BigInt(index);
  for (let cursor = 31; cursor >= 0; cursor--) {
    indexBytes[cursor] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  const depositId = keccak_256(concatBytes(hexToBytes(block.slice(2)), indexBytes));
  const domain = new Uint8Array(32); // user-deposit domain = bytes32(0)
  return `0x${bytesToHex(keccak_256(concatBytes(domain, depositId)))}`;
}

function decodeOpStack(envelope) {
  const events = [];
  const destinationProtocol = Number(envelope.chain_id) === 8453 ? 'base'
    : (Number(envelope.chain_id) === 10 ? 'optimism' : null);
  const sourceHash = bytes32(envelope.transaction?.sourceHash);
  const txType = lower(envelope.transaction?.type);
  const outcome = receiptStatus(envelope.receipt);
  if (destinationProtocol
      && envelope.category === 'bridge_in'
      && sourceHash && outcome != null && (txType === '0x7e' || txType === '126')) {
    events.push(evidence(envelope, null, {
      protocol: destinationProtocol, family_version: 'bedrock',
      role: 'destination_execution', direction: 'in',
      correlation_key: `op-deposit:${sourceHash}`,
      status: outcome === 0n ? 'failed' : 'protocol_verified',
      details: { source_hash: sourceHash, transaction_type: txType },
    }));
  }

  for (const log of envelope.receipt?.logs || []) {
    const topic0 = lower(log.topics?.[0]);
    const routedProtocols = [...endpointProtocols(envelope, log)]
      .filter((protocol) => protocol === 'optimism' || protocol === 'base');
    for (const protocol of routedProtocols) {
      if (topic0 === TOPICS.opTransactionDeposited) {
        if (envelope.category !== 'bridge_out') continue;
        const source = opSourceHash(envelope.receipt.blockHash, logIndex(log));
        if (source) events.push(evidence(envelope, log, {
          protocol, family_version: 'bedrock', role: 'initiation', direction: 'out',
          correlation_key: `op-deposit:${source}`, details: { source_hash: source },
        }));
      } else if (topic0 === TOPICS.opMessagePassed
          && envelope.category === 'bridge_out' && protocol === destinationProtocol) {
        const withdrawalHash = bytes32(dataWord(log.data, 3));
        if (withdrawalHash) events.push(evidence(envelope, log, {
          protocol, family_version: 'bedrock', role: 'initiation', direction: 'out',
          correlation_key: `op-withdrawal:${withdrawalHash}`,
          details: { withdrawal_hash: withdrawalHash },
        }));
      } else if (topic0 === TOPICS.opWithdrawalFinalized && envelope.category === 'bridge_in') {
        const withdrawalHash = bytes32(log.topics?.[1]);
        const success = uintWord(dataWord(log.data, 0));
        if (withdrawalHash && (success === 0n || success === 1n)) events.push(evidence(envelope, log, {
          protocol, family_version: 'bedrock', role: 'finalization', direction: 'in',
          correlation_key: `op-withdrawal:${withdrawalHash}`,
          status: success === 1n ? 'protocol_verified' : 'failed',
          details: { withdrawal_hash: withdrawalHash, success: success === 1n },
        }));
      }
    }
  }
  return events;
}

function decodeArbitrum(envelope) {
  const events = [];
  for (const log of envelope.receipt?.logs || []) {
    if (!endpointProtocols(envelope, log).has('arbitrum')) continue;
    const topic0 = lower(log.topics?.[0]);
    if (topic0 === TOPICS.arbL2ToL1Tx && Number(envelope.chain_id) === 42161
        && envelope.category === 'bridge_out') {
      const position = uintWord(log.topics?.[3]);
      if (position != null) events.push(evidence(envelope, log, {
        protocol: 'arbitrum', family_version: 'nitro', role: 'initiation', direction: 'out',
        correlation_key: `arbitrum-nitro-withdrawal:42161:${position}`,
        details: { position: position.toString() },
      }));
    } else if (topic0 === TOPICS.arbOutboxExecuted && Number(envelope.chain_id) === 1
        && envelope.category === 'bridge_in') {
      // `zero` is indexed topic 3; the protocol identity is the non-indexed
      // transactionIndex emitted as data word 0.
      const position = uintWord(dataWord(log.data, 0));
      if (position != null) events.push(evidence(envelope, log, {
        protocol: 'arbitrum', family_version: 'nitro', role: 'finalization', direction: 'in',
        correlation_key: `arbitrum-nitro-withdrawal:42161:${position}`,
        status: 'protocol_verified', details: { transaction_index: position.toString() },
      }));
    }
  }
  return events;
}

function decodeLinea(envelope) {
  const events = [];
  for (const log of envelope.receipt?.logs || []) {
    if (!endpointProtocols(envelope, log).has('linea')) continue;
    const topic0 = lower(log.topics?.[0]);
    const messageHash = topic0 === TOPICS.lineaMessageSent
      ? bytes32(log.topics?.[3])
      : (topic0 === TOPICS.lineaMessageClaimed ? bytes32(log.topics?.[1]) : null);
    if (!messageHash) continue;
    const sent = topic0 === TOPICS.lineaMessageSent;
    if ((sent && envelope.category !== 'bridge_out')
        || (!sent && envelope.category !== 'bridge_in')) continue;
    events.push(evidence(envelope, log, {
      protocol: 'linea', family_version: 'message-service-v1',
      role: sent ? 'initiation' : 'destination_execution',
      direction: sent ? 'out' : 'in',
      correlation_key: `linea-message:${messageHash}`,
      status: sent ? 'pending' : 'protocol_verified',
      details: { message_hash: messageHash },
    }));
  }
  return events;
}

function decodeGnosis(envelope) {
  const events = [];
  const legacyEndpoints = (envelope.endpoints || []).filter((endpoint) => (
    endpoint.protocol === 'gnosis' && endpoint.family_version === 'legacy-xdai'
      && Number(endpoint.chain_id) === Number(envelope.chain_id)
  ));
  const recognized = legacyEndpoints.some((endpoint) => (
    [lower(envelope.transaction?.to), ...(envelope.receipt?.logs || []).map((log) => lower(log.address))]
      .includes(lower(endpoint.address))
  ));
  for (const log of envelope.receipt?.logs || []) {
    if (!legacyEndpoints.some((endpoint) => lower(endpoint.address) === lower(log.address))) continue;
    const topic0 = lower(log.topics?.[0]);
    if (topic0 !== TOPICS.gnosisAffirmationCompleted && topic0 !== TOPICS.gnosisRelayedMessage) continue;
    if (envelope.category !== 'bridge_in') continue;
    // All three legacy fields are non-indexed: recipient, value, tx hash.
    const sourceTxHash = bytes32(dataWord(log.data, 2));
    if (!sourceTxHash) continue;
    events.push(evidence(envelope, log, {
      protocol: 'gnosis', family_version: 'legacy-xdai',
      role: 'destination_execution', direction: 'in',
      correlation_key: `gnosis-legacy:${sourceTxHash}`,
      status: 'protocol_verified', details: { source_tx_hash: sourceTxHash },
    }));
  }
  // The source transaction hash itself is the reference carried by the
  // destination event. Only a bridge_out activity can contribute this member.
  if (recognized && envelope.category === 'bridge_out') {
    events.push(evidence(envelope, null, {
      protocol: 'gnosis', family_version: 'legacy-xdai', role: 'initiation', direction: 'out',
      correlation_key: `gnosis-legacy:${lower(envelope.tx_hash)}`,
      details: { source_tx_hash: lower(envelope.tx_hash) },
    }));
  }
  return events;
}

function decodeZkSyncEra(envelope) {
  const events = [];
  for (const log of envelope.receipt?.logs || []) {
    if (!endpointProtocols(envelope, log).has('zksync')) continue;
    if (lower(log.topics?.[0]) !== TOPICS.zksyncDepositFinalized
        || envelope.category !== 'bridge_out') continue;
    const chainId = uintWord(log.topics?.[1]);
    const l2TxHash = bytes32(log.topics?.[3]);
    if (chainId == null || !l2TxHash) continue;
    events.push(evidence(envelope, log, {
      protocol: 'zksync', family_version: 'era-bridgehub', role: 'initiation', direction: 'out',
      correlation_key: `zksync-era-deposit:${chainId}:${l2TxHash}`,
      details: { destination_chain_id: chainId.toString(), l2_tx_hash: l2TxHash },
    }));
  }
  if (Number(envelope.chain_id) === 324 && envelope.category === 'bridge_in') {
    events.push(evidence(envelope, null, {
      protocol: 'zksync', family_version: 'era-bridgehub',
      role: 'destination_execution', direction: 'in',
      correlation_key: `zksync-era-deposit:324:${lower(envelope.tx_hash)}`,
      status: 'protocol_verified', details: { l2_tx_hash: lower(envelope.tx_hash) },
    }));
  }
  return events;
}

function decodeZkSyncLite(envelope) {
  const hash = lower(envelope.tx_hash);
  if (!HASH_RE.test(hash)) return [];
  if (Number(envelope.chain_id) === 32401
      && envelope.category === 'bridge_in'
      && envelope.method_name === 'zkSync Lite Deposit') {
    return [evidence(envelope, null, {
      protocol: 'zksync-lite', family_version: 'lite-v1',
      role: 'destination_execution', direction: 'in',
      correlation_key: `zksync-lite-deposit:${hash}`,
      status: 'protocol_verified',
      details: { archive_operation: 'Deposit', ethereum_tx_hash: hash },
    })];
  }
  const recognized = Number(envelope.chain_id) === 1 && envelope.category === 'bridge_out'
    && (envelope.endpoints || []).some((endpoint) => endpoint.protocol === 'zksync-lite'
      && [lower(envelope.transaction?.to), lower(envelope.receipt?.to)].includes(lower(endpoint.address)));
  return recognized ? [evidence(envelope, null, {
    protocol: 'zksync-lite', family_version: 'lite-v1',
    role: 'initiation', direction: 'out',
    correlation_key: `zksync-lite-deposit:${hash}`,
    details: { ethereum_tx_hash: hash },
  })] : [];
}

function acrossKey(version, originChain, depositId) {
  return originChain == null || depositId == null
    ? null
    : `across-${version}:${originChain}:${depositId}`;
}

function decodeAcross(envelope) {
  const events = [];
  for (const log of envelope.receipt?.logs || []) {
    if (!endpointProtocols(envelope, log).has('across')) continue;
    const topic0 = lower(log.topics?.[0]);
    let version = null;
    let role = null;
    let originChain = null;
    let depositId = null;
    let assetId = null;
    let amount = null;

    // Across V2 had multiple event layouts and partial fills. V2 endpoints are
    // still classified and suggested, but no V2 event may auto-fold until a
    // version-bounded deployment registry and partial-fill model are present.
    if (topic0 === TOPICS.acrossV3Deposit && envelope.category === 'bridge_out') {
      version = 'v3'; role = 'initiation'; originChain = BigInt(envelope.chain_id);
      depositId = uintWord(log.topics?.[2]);
      assetId = addressWord(dataWord(log.data, 0)); amount = uintWord(dataWord(log.data, 2));
    } else if (topic0 === TOPICS.acrossV3Fill && envelope.category === 'bridge_in') {
      version = 'v3'; role = 'fill'; originChain = uintWord(log.topics?.[1]);
      depositId = uintWord(log.topics?.[2]);
      assetId = addressWord(dataWord(log.data, 0)); amount = uintWord(dataWord(log.data, 3));
    } else if (topic0 === TOPICS.acrossCurrentDeposit && envelope.category === 'bridge_out') {
      version = 'v3-current'; role = 'initiation'; originChain = BigInt(envelope.chain_id);
      depositId = uintWord(log.topics?.[2]);
      assetId = bytes32(dataWord(log.data, 0)); amount = uintWord(dataWord(log.data, 2));
    } else if (topic0 === TOPICS.acrossCurrentFill && envelope.category === 'bridge_in') {
      version = 'v3-current'; role = 'fill'; originChain = uintWord(log.topics?.[1]);
      depositId = uintWord(log.topics?.[2]);
      assetId = bytes32(dataWord(log.data, 0)); amount = uintWord(dataWord(log.data, 3));
    }

    const identityFields = {
      input_token: bytes32(dataWord(log.data, 0)),
      output_token: bytes32(dataWord(log.data, 1)),
      input_amount: uintWord(dataWord(log.data, 2))?.toString() || null,
      output_amount: uintWord(dataWord(log.data, 3))?.toString() || null,
      depositor: role === 'initiation' ? bytes32(log.topics?.[3])
        : bytes32(dataWord(log.data, 8)),
      recipient: role === 'initiation' ? bytes32(dataWord(log.data, 7))
        : bytes32(dataWord(log.data, 9)),
      destination_chain_id: role === 'initiation'
        ? uintWord(log.topics?.[1])?.toString() || null
        : String(envelope.chain_id),
    };
    const key = acrossKey(version, originChain, depositId);
    // The deposit id is protocol identity only inside a compatible relay. A
    // short/unknown ABI that omits any common relay field is unsupported, not
    // a weaker automatic match.
    if (!key || Object.values(identityFields).some((value) => value == null)) continue;
    events.push(evidence(envelope, log, {
      protocol: 'across', family_version: version,
      role, direction: role === 'initiation' ? 'out' : 'in',
      correlation_key: key,
      status: role === 'fill' ? 'protocol_verified' : 'pending',
      asset_id: assetId ? `${originChain}:${assetId}` : null,
      amount: amount == null ? null : amount.toString(),
      details: {
        origin_chain_id: originChain.toString(), deposit_id: depositId.toString(),
        identity_fields: identityFields,
      },
    }));
  }
  return events;
}

function decodePolygon() {
  // Current stored destination credits do not carry an independently
  // correlatable StateSynced id, and Plasma exits require proof decoding.
  return [];
}

const ADAPTERS = Object.freeze([
  { protocol: 'op-stack', decode: decodeOpStack },
  { protocol: 'arbitrum', decode: decodeArbitrum },
  { protocol: 'polygon', decode: decodePolygon },
  { protocol: 'gnosis', decode: decodeGnosis },
  { protocol: 'zksync', decode: decodeZkSyncEra },
  { protocol: 'zksync-lite', decode: decodeZkSyncLite },
  { protocol: 'linea', decode: decodeLinea },
  { protocol: 'across', decode: decodeAcross },
]);

function decodeEnvelope(envelope) {
  if (!envelope || !HASH_RE.test(lower(envelope.tx_hash))) return [];
  return ADAPTERS.flatMap((adapter) => adapter.decode(envelope));
}

module.exports = {
  ADAPTERS,
  RULE_VERSION,
  TOPICS,
  addressWord,
  bytes32,
  dataWord,
  decodeEnvelope,
  eventTopic,
  logIndex,
  opSourceHash,
  receiptStatus,
  uintWord,
};
