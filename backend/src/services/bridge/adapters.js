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

function functionSelector(signature) {
  return `0x${bytesToHex(keccak_256(new TextEncoder().encode(signature))).slice(0, 8)}`;
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

function dataWordCount(data) {
  const normalized = lower(data);
  if (!/^0x(?:[0-9a-f]{64})*$/.test(normalized)) return null;
  return (normalized.length - 2) / 64;
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

function transactionInput(transaction) {
  const input = transaction?.input ?? transaction?.data ?? transaction?.calldata;
  return typeof input === 'string' ? lower(input) : null;
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
  hopTransferSent: eventTopic('TransferSent(uint256,uint256,address,uint256,bytes32,uint256,uint256,uint8,uint256,uint256,address)'),
  hopTransferSentToL2: eventTopic('TransferSentToL2(uint256,address,uint256,uint256,uint256,address,uint256)'),
  hopTransferFromL1Completed: eventTopic('TransferFromL1Completed(address,uint256,uint8,uint256,uint256,address,uint256)'),
  hopWithdrawalBonded: eventTopic('WithdrawalBonded(bytes32,uint256,address)'),
  hopWithdrawalBondedLegacy: eventTopic('WithdrawalBonded(bytes32,uint256)'),
  hopWithdrew: eventTopic('Withdrew(bytes32,address,uint256,bytes32)'),
  hopWithdrawalBondSettled: eventTopic('WithdrawalBondSettled(address,bytes32,bytes32)'),
});

const HOP_SELECTORS = Object.freeze({
  send: functionSelector('send(uint256,address,uint256,uint256,(uint8,uint256,uint256),address)'),
  sendLegacy: functionSelector('send(uint256,address,uint256,uint256,uint256,uint256)'),
  swapAndSend: functionSelector('swapAndSend(uint256,address,uint256,uint256,(uint8,uint256,uint256),(uint8,uint256,uint256),address)'),
  swapAndSendLegacy: functionSelector('swapAndSend(uint256,address,uint256,uint256,uint256,uint256,uint256,uint256)'),
  sendToL2: functionSelector('sendToL2(uint256,address,uint256,uint256,uint256,address,uint256)'),
  bondWithdrawal: functionSelector('bondWithdrawal(address,uint256,bytes32,uint256)'),
  // The pinned Hop node ABI uses the deployed v1 six-word selector. The
  // current source tree also exposes a tuple-shaped variant, so retain that
  // selector as a decode-only compatibility path without using either call as
  // destination receipt proof.
  bondWithdrawalAndDistribute: functionSelector('bondWithdrawalAndDistribute(address,uint256,bytes32,uint256,uint256,uint256)'),
  bondWithdrawalAndDistributeTuple: functionSelector('bondWithdrawalAndDistribute(address,uint256,bytes32,uint256,(uint8,uint256,uint256))'),
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

function hopBlockNumber(envelope) {
  const raw = envelope.receipt?.blockNumber ?? envelope.block_number;
  if (typeof raw === 'string' && /^0x[0-9a-f]+$/i.test(raw)) {
    const parsed = Number.parseInt(raw, 16);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function routeAddressList(route, field) {
  return jsonArray(route?.[field]).map(lower).filter((value) => ADDRESS_RE.test(value));
}

function observedHopAssets(envelope, direction) {
  if (!Array.isArray(envelope.legs)) return { known: false, addresses: [] };
  const addresses = envelope.legs
    .filter((leg) => leg.direction === direction)
    .map((leg) => lower(leg.contract || leg.token_contract))
    .filter((value) => ADDRESS_RE.test(value));
  return { known: true, addresses: [...new Set(addresses)] };
}

function routeBlockApplies(route, envelope, side) {
  const block = hopBlockNumber(envelope);
  const from = Number(route?.[`${side}_valid_from_block`]);
  const to = Number(route?.[`${side}_valid_to_block`]);
  if ((route?.[`${side}_valid_from_block`] != null || route?.[`${side}_valid_to_block`] != null)
      && (!Number.isSafeInteger(block) || block < 0)) return false;
  if (route?.[`${side}_valid_from_block`] != null && block < from) return false;
  if (route?.[`${side}_valid_to_block`] != null && block > to) return false;
  return true;
}

function routeEndpointApplies(route, envelope, side, log) {
  const logAddress = lower(log?.address);
  const transactionAddress = lower(envelope.transaction?.to || envelope.receipt?.to);
  if (side === 'source') {
    return logAddress === lower(route.source_bridge_address)
      || transactionAddress === lower(route.source_bridge_address)
      || transactionAddress === lower(route.source_wrapper_address);
  }
  return logAddress === lower(route.destination_bridge_address)
    || transactionAddress === lower(route.destination_bridge_address)
    || transactionAddress === lower(route.destination_wrapper_address);
}

function routeTokenIndexApplies(route, field, tokenIndex) {
  if (tokenIndex == null) return true;
  const indexes = jsonArray(route?.[field]).map(Number);
  return !indexes.length || indexes.includes(Number(tokenIndex));
}

function hopRouteCandidates(envelope, {
  side, destinationChainId = null, tokenIndex = null, sourceTokenIndex = null,
  log = null,
}) {
  const chainId = Number(envelope.chain_id);
  const assets = observedHopAssets(envelope, side === 'source' ? 'out' : 'in');
  return (envelope.hop_routes || []).filter((route) => {
    if (route.enabled === false || route.family_version !== 'v1') return false;
    if (side === 'source') {
      if (Number(route.source_chain_id) !== chainId
          || Number(route.destination_chain_id) !== Number(destinationChainId)) return false;
      if (!routeBlockApplies(route, envelope, 'source')) return false;
      if (!routeEndpointApplies(route, envelope, 'source', log)) return false;
      if (!routeTokenIndexApplies(route, 'destination_token_indices', tokenIndex)
          || !routeTokenIndexApplies(route, 'source_token_indices', sourceTokenIndex)) return false;
      const allowed = routeAddressList(route, 'source_asset_addresses');
      if (assets.known && (!assets.addresses.length
          || !assets.addresses.every((address) => allowed.includes(address)))) return false;
    } else {
      if (Number(route.destination_chain_id) !== chainId) return false;
      if (!routeBlockApplies(route, envelope, 'destination')) return false;
      if (!routeEndpointApplies(route, envelope, 'destination', log)) return false;
      const allowed = routeAddressList(route, 'destination_asset_addresses');
      if (assets.known && (!assets.addresses.length
          || !assets.addresses.every((address) => allowed.includes(address)))) return false;
    }
    return true;
  });
}

function hopRouteSummary(route) {
  return {
    route_key: route.route_key,
    deployment_key: route.deployment_key,
    asset_key: route.asset_key,
    source_chain_id: Number(route.source_chain_id),
    destination_chain_id: Number(route.destination_chain_id),
    source_bridge_address: lower(route.source_bridge_address),
    source_wrapper_address: lower(route.source_wrapper_address),
    destination_bridge_address: lower(route.destination_bridge_address),
    destination_wrapper_address: lower(route.destination_wrapper_address) || null,
    source_asset_addresses: routeAddressList(route, 'source_asset_addresses'),
    destination_asset_addresses: routeAddressList(route, 'destination_asset_addresses'),
    source_token_indices: jsonArray(route.source_token_indices).map(Number),
    destination_token_indices: jsonArray(route.destination_token_indices).map(Number),
    abi_variant: route.abi_variant || null,
    finality_policy: route.finality_policy || null,
  };
}

function hopEndpointMentioned(envelope, log) {
  const addresses = new Set([
    lower(log?.address), lower(envelope.transaction?.to), lower(envelope.receipt?.to),
  ]);
  return (envelope.endpoints || []).some((endpoint) => endpoint.protocol === 'hop'
      && addresses.has(lower(endpoint.address)))
    || (envelope.hop_routes || []).some((route) => [
      route.source_bridge_address, route.source_wrapper_address,
      route.destination_bridge_address, route.destination_wrapper_address,
    ].map(lower).some((address) => addresses.has(address)));
}

function abiUintWord(value) {
  try {
    const number = BigInt(value);
    if (number < 0n || number >= (1n << 256n)) return null;
    return number.toString(16).padStart(64, '0');
  } catch {
    return null;
  }
}

function abiAddressWord(value) {
  const address = lower(value);
  return ADDRESS_RE.test(address) ? `${'0'.repeat(24)}${address.slice(2)}` : null;
}

function abiBytes32Word(value) {
  const hash = bytes32(value);
  return hash ? hash.slice(2) : null;
}

function hopTransferId(chainId, recipient, amount, transferNonce, bonderFee, amountOutMin, deadline) {
  const words = [
    abiUintWord(chainId), abiAddressWord(recipient), abiUintWord(amount),
    abiBytes32Word(transferNonce), abiUintWord(bonderFee),
    abiUintWord(amountOutMin), abiUintWord(deadline),
  ];
  if (words.some((word) => word == null)) return null;
  return `0x${bytesToHex(keccak_256(hexToBytes(words.join(''))))}`;
}

function callWords(input) {
  if (typeof input !== 'string' || !/^0x[0-9a-f]*$/.test(input) || input.length < 10) return null;
  const body = `0x${input.slice(10)}`;
  return { selector: input.slice(0, 10), body, count: dataWordCount(body) };
}

function decodeHopCall(input) {
  const call = callWords(input);
  if (!call) return input == null ? { kind: 'missing' } : { kind: 'malformed' };
  const word = (index) => uintWord(dataWord(call.body, index));
  const address = (index) => addressWord(dataWord(call.body, index));
  const hash = (index) => bytes32(dataWord(call.body, index));
  const malformed = (expected) => call.count !== expected;
  if (call.selector === HOP_SELECTORS.send) {
    if (malformed(8)) return { kind: 'malformed', selector: call.selector };
    return {
      kind: 'send', selector: call.selector,
      destination_chain_id: word(0)?.toString() || null,
      recipient: address(1), amount: word(2)?.toString() || null,
      bonder_fee: word(3)?.toString() || null,
      token_index: word(4)?.toString() || null,
      amount_out_min: word(5)?.toString() || null,
      deadline: word(6)?.toString() || null,
      bonder: address(7),
    };
  }
  if (call.selector === HOP_SELECTORS.sendLegacy) {
    if (malformed(6)) return { kind: 'malformed', selector: call.selector };
    return {
      kind: 'send_legacy', selector: call.selector,
      destination_chain_id: word(0)?.toString() || null,
      recipient: address(1), amount: word(2)?.toString() || null,
      bonder_fee: word(3)?.toString() || null,
      amount_out_min: word(4)?.toString() || null,
      deadline: word(5)?.toString() || null,
    };
  }
  if (call.selector === HOP_SELECTORS.swapAndSend) {
    if (malformed(11)) return { kind: 'malformed', selector: call.selector };
    return {
      kind: 'swap_and_send', selector: call.selector,
      destination_chain_id: word(0)?.toString() || null,
      recipient: address(1), amount: word(2)?.toString() || null,
      bonder_fee: word(3)?.toString() || null,
      source_token_index: word(4)?.toString() || null,
      source_amount_out_min: word(5)?.toString() || null,
      source_deadline: word(6)?.toString() || null,
      destination_token_index: word(7)?.toString() || null,
      destination_amount_out_min: word(8)?.toString() || null,
      destination_deadline: word(9)?.toString() || null,
      bonder: address(10),
    };
  }
  if (call.selector === HOP_SELECTORS.swapAndSendLegacy) {
    if (malformed(8)) return { kind: 'malformed', selector: call.selector };
    return {
      kind: 'swap_and_send_legacy', selector: call.selector,
      destination_chain_id: word(0)?.toString() || null,
      recipient: address(1), amount: word(2)?.toString() || null,
      bonder_fee: word(3)?.toString() || null,
      source_amount_out_min: word(4)?.toString() || null,
      source_deadline: word(5)?.toString() || null,
      destination_amount_out_min: word(6)?.toString() || null,
      destination_deadline: word(7)?.toString() || null,
    };
  }
  if (call.selector === HOP_SELECTORS.sendToL2) {
    if (malformed(7)) return { kind: 'malformed', selector: call.selector };
    return {
      kind: 'send_to_l2', selector: call.selector,
      destination_chain_id: word(0)?.toString() || null,
      recipient: address(1), amount: word(2)?.toString() || null,
      amount_out_min: word(3)?.toString() || null,
      deadline: word(4)?.toString() || null,
      relayer: address(5), relayer_fee: word(6)?.toString() || null,
    };
  }
  if (call.selector === HOP_SELECTORS.bondWithdrawalAndDistribute) {
    if (malformed(6)) return { kind: 'bond_withdrawal_and_distribute', selector: call.selector };
    return {
      kind: 'bond_withdrawal_and_distribute', selector: call.selector,
      recipient: address(0), amount: word(1)?.toString() || null,
      transfer_nonce: hash(2), bonder_fee: word(3)?.toString() || null,
      amount_out_min: word(4)?.toString() || null, deadline: word(5)?.toString() || null,
    };
  }
  if (call.selector === HOP_SELECTORS.bondWithdrawalAndDistributeTuple) {
    if (malformed(7)) return { kind: 'bond_withdrawal_and_distribute', selector: call.selector };
    return {
      kind: 'bond_withdrawal_and_distribute', selector: call.selector,
      recipient: address(0), amount: word(1)?.toString() || null,
      transfer_nonce: hash(2), bonder_fee: word(3)?.toString() || null,
      token_index: word(4)?.toString() || null,
      amount_out_min: word(5)?.toString() || null, deadline: word(6)?.toString() || null,
    };
  }
  if (call.selector === HOP_SELECTORS.bondWithdrawal) {
    if (malformed(4)) return { kind: 'bond_withdrawal', selector: call.selector };
    return {
      kind: 'bond_withdrawal', selector: call.selector,
      recipient: address(0), amount: word(1)?.toString() || null, transfer_nonce: hash(2),
    };
  }
  return { kind: 'unknown', selector: call.selector };
}

function hopCallMatchesSource(call, fields) {
  if (!call || call.kind === 'missing') return true;
  if (call.kind === 'malformed' || call.kind === 'unknown' || call.kind === 'send_to_l2') return false;
  if (call.destination_chain_id !== fields.destination_chain_id
      || call.recipient !== fields.recipient
      || call.bonder_fee !== fields.bonder_fee) return false;
  if (call.kind === 'send') {
    return call.amount === fields.amount
      && call.token_index === fields.token_index
      && call.amount_out_min === fields.amount_out_min
      && call.deadline === fields.deadline
      && call.bonder === fields.bonder;
  }
  if (call.kind === 'send_legacy') {
    return call.amount === fields.amount
      && call.amount_out_min === fields.amount_out_min
      && call.deadline === fields.deadline;
  }
  if (call.kind === 'swap_and_send_legacy') {
    return call.amount === fields.amount
      && call.destination_amount_out_min === fields.amount_out_min
      && call.destination_deadline === fields.deadline;
  }
  return call.destination_token_index === fields.token_index
    && call.destination_amount_out_min === fields.amount_out_min
    && call.destination_deadline === fields.deadline
    && call.bonder === fields.bonder;
}

function hopCoverage(envelope) {
  if (!Array.isArray(envelope.feed_coverage)) return null;
  const tokenCoverage = envelope.feed_coverage.find((entry) => entry.feed === 'token');
  const block = hopBlockNumber(envelope);
  if (!tokenCoverage) {
    return { status: 'incomplete', reason: 'destination_token_feed_coverage_missing', feed: 'token' };
  }
  if (tokenCoverage.status !== 'complete') {
    return {
      status: 'incomplete', reason: `destination_token_feed_${tokenCoverage.status || 'unknown'}`,
      feed: 'token', coverage_status: tokenCoverage.status || null,
    };
  }
  const coveredThrough = Number(tokenCoverage.covered_through_block);
  if (!Number.isSafeInteger(block) || !Number.isSafeInteger(coveredThrough)
      || coveredThrough < block) {
    return {
      status: 'incomplete', reason: 'destination_token_feed_coverage_behind_receipt',
      feed: 'token', covered_through_block: Number.isSafeInteger(coveredThrough)
        ? coveredThrough : null,
    };
  }
  return { status: 'complete', feed: 'token', covered_through_block: coveredThrough };
}

function hopStatus(envelope) {
  return receiptStatus(envelope.receipt) === 0n ? 'failed' : 'pending';
}

function hopDiagnostic(envelope, log, reason, details = {}) {
  const role = envelope.category === 'bridge_out' ? 'initiation' : 'destination_execution';
  const key = `hop:unsupported:${Number(envelope.wallet_id)}:${Number(envelope.chain_id)}:${lower(envelope.tx_hash)}:${logIndex(log) ?? 'tx'}`;
  return evidence(envelope, log, {
    protocol: 'hop', family_version: 'v1', role,
    direction: envelope.category === 'bridge_out' ? 'out' : 'in',
    correlation_key: key, status: 'unsupported',
    details: { reason, hop: { reason, ...details } },
  });
}

function decodeHop(envelope) {
  const events = [];
  for (const log of envelope.receipt?.logs || []) {
    const topic0 = lower(log.topics?.[0]);
    if (![TOPICS.hopTransferSent, TOPICS.hopTransferSentToL2,
      TOPICS.hopTransferFromL1Completed, TOPICS.hopWithdrawalBonded,
      TOPICS.hopWithdrawalBondedLegacy, TOPICS.hopWithdrew]
      .includes(topic0)) continue;
    if (!hopEndpointMentioned(envelope, log)) continue;

    if (topic0 === TOPICS.hopTransferSent) {
      if (envelope.category !== 'bridge_out') continue;
      if (log.topics?.length !== 4 || dataWordCount(log.data) !== 8) {
        events.push(hopDiagnostic(envelope, log, 'malformed_transfer_sent_log'));
        continue;
      }
      const destinationChainId = uintWord(log.topics[1]);
      const recipient = addressWord(log.topics[3]);
      const amount = uintWord(dataWord(log.data, 0));
      const transferNonce = bytes32(dataWord(log.data, 1));
      const bonderFee = uintWord(dataWord(log.data, 2));
      const tokenIndex = uintWord(dataWord(log.data, 4));
      const amountOutMin = uintWord(dataWord(log.data, 5));
      const deadline = uintWord(dataWord(log.data, 6));
      const bonder = addressWord(dataWord(log.data, 7));
      if (destinationChainId == null || !recipient || amount == null || !transferNonce
          || bonderFee == null || tokenIndex == null || tokenIndex > 255n
          || amountOutMin == null || deadline == null || !bonder) {
        events.push(hopDiagnostic(envelope, log, 'malformed_transfer_sent_fields'));
        continue;
      }
      const transferId = hopTransferId(
        destinationChainId, recipient, amount, transferNonce, bonderFee, amountOutMin, deadline
      );
      const input = transactionInput(envelope.transaction);
      const call = decodeHopCall(input);
      const routes = hopRouteCandidates(envelope, {
        side: 'source', destinationChainId: destinationChainId.toString(),
        tokenIndex: tokenIndex.toString(), sourceTokenIndex: call.source_token_index, log,
      });
      const routeSummaries = routes.map(hopRouteSummary);
      const callKnown = call.kind !== 'missing';
      const target = lower(envelope.transaction?.to || envelope.receipt?.to);
      const sourceTargets = new Set(routes.flatMap((route) => [
        lower(route.source_bridge_address), lower(route.source_wrapper_address),
      ]));
      if (!transferId || !routes.length
          || (callKnown && (!sourceTargets.has(target) || !hopCallMatchesSource(call, {
            destination_chain_id: destinationChainId.toString(), recipient,
            amount: amount.toString(), bonder_fee: bonderFee.toString(),
            token_index: tokenIndex.toString(), amount_out_min: amountOutMin.toString(),
            deadline: deadline.toString(), bonder,
          })))) {
        const reason = !routes.length ? 'unsupported_route'
          : call.kind === 'malformed' ? 'malformed_source_calldata'
            : call.kind === 'unknown' ? 'unsupported_source_calldata_selector'
              : !sourceTargets.has(target) ? 'source_endpoint_mismatch' : 'source_calldata_mismatch';
        events.push(hopDiagnostic(envelope, log, reason, {
          transfer_id: transferId, destination_chain_id: destinationChainId.toString(),
          route_candidates: routeSummaries, call,
        }));
        continue;
      }
      const assetIds = [...new Set(routeSummaries.map((route) => route.asset_key))];
      events.push(evidence(envelope, log, {
        protocol: 'hop', family_version: 'v1', role: 'initiation', direction: 'out',
        correlation_key: `hop:v1:${transferId}`, asset_id: assetIds.length === 1 ? `hop:${assetIds[0]}` : null,
        amount: amount.toString(), fee_amount: bonderFee.toString(), status: hopStatus(envelope),
        details: {
          identity_fields: {
            transfer_id: transferId,
            source_chain_id: String(envelope.chain_id),
            destination_chain_id: destinationChainId.toString(),
            direction: 'out',
          },
          hop: {
            transfer_id: transferId,
            transfer_nonce: transferNonce,
            destination_chain_id: destinationChainId.toString(),
            recipient,
            gross_amount: amount.toString(),
            bonder_fee: bonderFee.toString(),
            token_index: tokenIndex.toString(),
            amount_out_min: amountOutMin.toString(),
            deadline: deadline.toString(),
            bonder,
            route_candidates: routeSummaries,
            source_calldata: call,
            source_asset_observation: observedHopAssets(envelope, 'out'),
          },
        },
      }));
    } else if (topic0 === TOPICS.hopTransferSentToL2
        || topic0 === TOPICS.hopTransferFromL1Completed) {
      events.push(hopDiagnostic(envelope, log, 'unsupported_l1_l2_transfer_id_absent'));
    } else if (topic0 === TOPICS.hopWithdrawalBonded
        || topic0 === TOPICS.hopWithdrawalBondedLegacy) {
      events.push(hopDiagnostic(envelope, log, 'withdrawal_bonded_is_not_user_arrival', {
        transfer_id: bytes32(log.topics?.[1]),
      }));
    } else {
      if (envelope.category !== 'bridge_in') continue;
      const transferId = bytes32(log.topics?.[1]);
      const isWithdrew = topic0 === TOPICS.hopWithdrew;
      const expectedTopics = isWithdrew ? 3 : 2;
      const expectedWords = 2;
      if (!transferId || log.topics?.length !== expectedTopics
          || dataWordCount(log.data) !== expectedWords) {
        events.push(hopDiagnostic(envelope, log, 'malformed_destination_log'));
        continue;
      }
      const amount = uintWord(dataWord(log.data, 0));
      const transferNonce = isWithdrew ? bytes32(dataWord(log.data, 1)) : null;
      const recipient = isWithdrew ? addressWord(log.topics?.[2]) : null;
      const walletAddress = lower(envelope.wallet_address);
      const routes = hopRouteCandidates(envelope, { side: 'destination', log });
      const routeSummaries = routes.map(hopRouteSummary);
      if (amount == null || (isWithdrew && (!transferNonce || !recipient)) || !routes.length) {
        events.push(hopDiagnostic(envelope, log, !routes.length ? 'unsupported_destination_route' : 'malformed_destination_fields', {
          transfer_id: transferId, route_candidates: routeSummaries,
        }));
        continue;
      }
      if (isWithdrew && walletAddress && recipient !== walletAddress) {
        events.push(hopDiagnostic(envelope, log, 'destination_recipient_not_owned', {
          transfer_id: transferId, recipient, wallet_address: walletAddress,
        }));
        continue;
      }
      if (isWithdrew && !walletAddress) {
        events.push(hopDiagnostic(envelope, log, 'destination_wallet_address_missing', {
          transfer_id: transferId, recipient,
        }));
        continue;
      }
      const assetObservation = observedHopAssets(envelope, 'in');
      if (assetObservation.known && !assetObservation.addresses.length) {
        events.push(hopDiagnostic(envelope, log, 'destination_asset_not_observed', {
          transfer_id: transferId, route_candidates: routeSummaries,
        }));
        continue;
      }
      const assetIds = [...new Set(routeSummaries.map((route) => route.asset_key))];
      const coverage = hopCoverage(envelope);
      events.push(evidence(envelope, log, {
        protocol: 'hop', family_version: 'v1', role: 'destination_execution', direction: 'in',
        correlation_key: `hop:v1:${transferId}`, asset_id: assetIds.length === 1 ? `hop:${assetIds[0]}` : null,
        amount: amount.toString(), status: hopStatus(envelope),
        details: {
          identity_fields: {
            transfer_id: transferId,
            destination_chain_id: String(envelope.chain_id),
            direction: 'in',
          },
          hop: {
            transfer_id: transferId,
            destination_event_amount: amount.toString(),
            transfer_nonce: transferNonce,
            recipient,
            wallet_address: walletAddress || null,
            route_candidates: routeSummaries,
            destination_asset_observation: assetObservation,
            destination_coverage: coverage,
            destination_calldata: decodeHopCall(transactionInput(envelope.transaction)),
          },
        },
      }));
    }
  }
  return events;
}

function hopRouteIdentity(route) {
  return `${route?.deployment_key || ''}:${route?.route_key || ''}`;
}

function hopObservedAssetsMatch(observation, allowed) {
  if (!observation || observation.known !== true) return true;
  if (!Array.isArray(observation.addresses) || observation.addresses.length === 0) return false;
  return observation.addresses.every((address) => allowed.includes(lower(address)));
}

function hopBigInt(value) {
  try {
    if (value == null || !/^\d+$/.test(String(value))) return null;
    return BigInt(value);
  } catch {
    return null;
  }
}

function validateHopPair(sourceEvent, destinationEvent) {
  const reject = (reason, details = {}) => ({ ok: false, reason, ...details });
  const source = sourceEvent?.evidence?.hop;
  const destination = destinationEvent?.evidence?.hop;
  if (!source || !destination) return reject('missing_hop_identity');
  if (source.transfer_id !== destination.transfer_id) return reject('incompatible_transfer_id');
  if (source.transfer_nonce && destination.transfer_nonce
      && lower(source.transfer_nonce) !== lower(destination.transfer_nonce)) {
    return reject('incompatible_transfer_nonce');
  }

  const sourceRoutes = Array.isArray(source.route_candidates) ? source.route_candidates : [];
  const destinationRoutes = Array.isArray(destination.route_candidates)
    ? destination.route_candidates : [];
  const destinationByIdentity = new Map(
    destinationRoutes.map((route) => [hopRouteIdentity(route), route])
  );
  const matches = sourceRoutes
    .map((route) => ({ source: route, destination: destinationByIdentity.get(hopRouteIdentity(route)) }))
    .filter((pair) => pair.destination);
  if (matches.length === 0) return reject('unsupported_or_incompatible_route');
  if (matches.length !== 1) return reject('ambiguous_route');
  const route = matches[0].source;

  if (Number(sourceEvent.chain_id) !== Number(route.source_chain_id)
      || Number(destinationEvent.chain_id) !== Number(route.destination_chain_id)) {
    return reject('route_chain_mismatch');
  }
  const recipient = lower(source.recipient);
  const destinationRecipient = lower(destination.recipient);
  const walletAddress = lower(destination.wallet_address);
  if (!ADDRESS_RE.test(recipient) || recipient !== destinationRecipient
      || recipient !== walletAddress) {
    return reject('destination_recipient_not_owned');
  }

  if (!hopObservedAssetsMatch(source.source_asset_observation, route.source_asset_addresses)
      || !hopObservedAssetsMatch(destination.destination_asset_observation,
        route.destination_asset_addresses)) {
    return reject('route_asset_mismatch');
  }

  const gross = hopBigInt(source.gross_amount);
  const fee = hopBigInt(source.bonder_fee);
  const destinationAmount = hopBigInt(destination.destination_event_amount);
  if (gross == null || fee == null || destinationAmount == null || fee > gross) {
    return reject('malformed_hop_amounts');
  }
  const net = gross - fee;
  if (destinationAmount !== net) return reject('gross_fee_net_mismatch', {
    gross_amount: gross.toString(), bonder_fee: fee.toString(),
    destination_amount: destinationAmount.toString(), expected_net_amount: net.toString(),
  });

  const coverage = destination.destination_coverage;
  const pendingReason = coverage && coverage.status !== 'complete'
    ? coverage.reason || 'destination_feed_coverage_incomplete' : null;
  return {
    ok: true,
    route,
    transfer_id: source.transfer_id,
    gross_amount: gross.toString(),
    bonder_fee: fee.toString(),
    net_amount: net.toString(),
    pending_reason: pendingReason,
  };
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
  { protocol: 'hop', decode: decodeHop },
]);

function decodeEnvelope(envelope) {
  if (!envelope || !HASH_RE.test(lower(envelope.tx_hash))) return [];
  return ADAPTERS.flatMap((adapter) => adapter.decode(envelope));
}

module.exports = {
  ADAPTERS,
  HOP_SELECTORS,
  RULE_VERSION,
  TOPICS,
  addressWord,
  bytes32,
  dataWord,
  decodeEnvelope,
  decodeHop,
  decodeHopCall,
  eventTopic,
  hopTransferId,
  logIndex,
  opSourceHash,
  receiptStatus,
  validateHopPair,
  uintWord,
};
