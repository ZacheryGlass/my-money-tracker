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

const GNOSIS_VARIANTS = Object.freeze({
  ERC20_SOURCE: 'erc20_transfer_source',
  LEGACY_SOURCE: 'legacy_source',
  AFFIRMATION_DESTINATION: 'affirmation_completed_destination',
  RELAYED_DESTINATION: 'relayed_message_destination',
});

function endpointMetadata(endpoint) {
  if (endpoint?.metadata && typeof endpoint.metadata === 'object'
      && !Array.isArray(endpoint.metadata)) return endpoint.metadata;
  if (typeof endpoint?.metadata !== 'string') return {};
  try {
    const parsed = JSON.parse(endpoint.metadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function endpointVariant(endpoint, variant) {
  const variants = endpointMetadata(endpoint).abi_variants;
  const config = variants && typeof variants === 'object' ? variants[variant] : null;
  return config && typeof config === 'object' && !Array.isArray(config) ? config : null;
}

function parseBlockNumber(value) {
  if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) {
    const parsed = Number.parseInt(value, 16);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function envelopeBlockNumber(envelope) {
  return parseBlockNumber(
    envelope.block_number ?? envelope.receipt?.blockNumber ?? envelope.transaction?.blockNumber
  );
}

function endpointInScope(endpoint, envelope) {
  const hasBounds = endpoint.valid_from_block != null || endpoint.valid_to_block != null;
  if (!hasBounds) return true;
  const block = envelopeBlockNumber(envelope);
  if (block == null) return false;
  return (endpoint.valid_from_block == null || block >= Number(endpoint.valid_from_block))
    && (endpoint.valid_to_block == null || block <= Number(endpoint.valid_to_block));
}

function endpointAllowsDirection(endpoint, direction) {
  return !endpoint.direction || endpoint.direction === 'both' || endpoint.direction === direction;
}

function variantChainDirectionMatches(config, envelope, direction) {
  const sourceChainId = Number(config.source_chain_id);
  const destinationChainId = Number(config.destination_chain_id);
  return Number.isSafeInteger(sourceChainId) && Number.isSafeInteger(destinationChainId)
    && sourceChainId !== destinationChainId
    && (direction === 'out' ? sourceChainId === Number(envelope.chain_id)
      : destinationChainId === Number(envelope.chain_id));
}

function gnosisEndpoint(envelope, address, variant, direction) {
  const candidates = (envelope.endpoints || []).filter((endpoint) => (
    endpoint.protocol === 'gnosis'
      && endpoint.family_version === 'legacy-xdai'
      && Number(endpoint.chain_id) === Number(envelope.chain_id)
      && lower(endpoint.address) === lower(address)
      && endpoint.role !== 'block_reward'
      && endpointInScope(endpoint, envelope)
      && endpointAllowsDirection(endpoint, direction)
  )).map((endpoint) => {
    const configured = endpointVariant(endpoint, variant);
    const metadata = endpointMetadata(endpoint);
    // Fixtures created before the registry metadata existed retain the old
    // decoder behavior. A populated metadata object without this variant is
    // deliberately not treated as an implicit opt-in.
    const config = configured || (Object.keys(metadata).length === 0 ? {
      supported: true,
      direction,
      source_chain_id: direction === 'out' ? Number(envelope.chain_id) : null,
      destination_chain_id: null,
      canonical_asset: 'XDAI',
      reference_type: 'source_transaction_hash',
    } : null);
    if (!config || config.supported !== true || config.direction !== direction) return null;
    if (configured && !variantChainDirectionMatches(config, envelope, direction)) return null;
    return { endpoint, config };
  }).filter(Boolean);
  return candidates.length === 1 ? candidates[0] : null;
}

function gnosisIdentityFields(endpoint, config, { amount = null, assetContract = null } = {}) {
  const metadata = endpointMetadata(endpoint);
  const fields = {
    protocol_asset: config.canonical_asset || null,
    source_chain_id: config.source_chain_id == null ? null : String(config.source_chain_id),
    destination_chain_id: config.destination_chain_id == null
      ? null : String(config.destination_chain_id),
    deployment_key: config.deployment_key || metadata.deployment_key || null,
    reference_type: config.reference_type || null,
  };
  if (assetContract) fields.asset_contract = lower(assetContract);
  if (amount != null) fields.protocol_amount = String(amount);
  return fields;
}

function rawLogEvidence(log) {
  return {
    address: log?.address ?? null,
    logIndex: log?.logIndex ?? null,
    transactionHash: log?.transactionHash ?? null,
    blockHash: log?.blockHash ?? null,
    topics: Array.isArray(log?.topics) ? [...log.topics] : null,
    data: log?.data ?? null,
  };
}

function parseErc20TransferLog(log) {
  if (lower(log?.topics?.[0]) !== TOPICS.erc20Transfer
      || !Array.isArray(log?.topics) || log.topics.length !== 3
      || !ADDRESS_RE.test(lower(log?.address))) return null;
  const normalizedData = lower(log.data);
  if (!/^0x[0-9a-f]{64}$/.test(normalizedData)) return null;
  const from = addressWord(log.topics[1]);
  const to = addressWord(log.topics[2]);
  const amount = uintWord(dataWord(normalizedData, 0));
  if (!from || !to || amount == null || amount <= 0n) return null;
  return {
    token_contract: lower(log.address),
    from,
    to,
    amount,
  };
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
  erc20Transfer: eventTopic('Transfer(address,address,uint256)'),
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
  // The pinned mainnet v1 ABI emits the transfer id as an indexed event
  // field and uses the six-word static send ABI. Newer source revisions use
  // the tuple-shaped SwapData ABI and no longer emit the id; keep that event
  // as a separate variant so a route can never silently mix the two.
  hopTransferSentPinned: eventTopic('TransferSent(bytes32,uint256,address,uint256,bytes32,uint256,uint256,uint256,uint256)'),
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
  const destinationProtocol = Number(envelope.chain_id) === 10 ? 'optimism' : null;
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
      .filter((protocol) => protocol === 'optimism');
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
  const outcome = receiptStatus(envelope.receipt);
  const logs = envelope.receipt?.logs || [];

  if (envelope.category === 'bridge_in') {
    for (const log of logs) {
      const topic0 = lower(log.topics?.[0]);
      const variant = topic0 === TOPICS.gnosisAffirmationCompleted
        ? GNOSIS_VARIANTS.AFFIRMATION_DESTINATION
        : (topic0 === TOPICS.gnosisRelayedMessage
          ? GNOSIS_VARIANTS.RELAYED_DESTINATION : null);
      if (!variant) continue;
      const routed = gnosisEndpoint(envelope, log.address, variant, 'in');
      if (!routed) continue;

      // The legacy events are deliberately decoded only in their complete
      // three-word ABI shape: recipient, value, and the source reference.
      const recipient = addressWord(dataWord(log.data, 0));
      const amount = uintWord(dataWord(log.data, 1));
      const sourceTxHash = nonZeroBytes32(dataWord(log.data, 2));
      // The event is emitted by the bridge contract, not by the wallet. A
      // transaction can contain several bridge executions, so the recipient
      // is the only message-level binding between this receipt and the
      // wallet-scoped activity row. Without this check, a valid execution for
      // another recipient could be folded into the tracked wallet's bridge.
      const walletAddress = lower(envelope.wallet_address);
      if (!recipient || !ADDRESS_RE.test(walletAddress) || recipient !== walletAddress
          || amount == null || amount <= 0n || !sourceTxHash) continue;

      events.push(evidence(envelope, log, {
        protocol: 'gnosis', family_version: 'legacy-xdai',
        role: 'destination_execution', direction: 'in',
        correlation_key: `gnosis-legacy:${sourceTxHash}`,
        status: outcome === 0n ? 'failed' : (outcome === 1n ? 'protocol_verified' : 'pending'),
        amount: amount.toString(),
        asset_id: routed.config.canonical_asset || null,
        details: {
          source_tx_hash: sourceTxHash,
          recipient,
          amount: amount.toString(),
          abi_variant: variant,
          endpoint_address: lower(routed.endpoint.address),
          raw_log: rawLogEvidence(log),
          required_identity_fields: routed.config.required_identity_fields || [],
          identity_fields: gnosisIdentityFields(routed.endpoint, routed.config, {
            amount: amount.toString(),
          }),
        },
      }));
    }
    return events;
  }

  if (envelope.category !== 'bridge_out' || outcome !== 1n) return events;

  // The common ERC-20 source shape calls the token contract. The bridge is
  // proven only by the token's Transfer recipient, never by a bare address
  // match or a method name. Require the signer to be the tracked wallet so a
  // log emitted by an unrelated internal call cannot become its bridge leg.
  const signer = lower(envelope.transaction?.from);
  const walletAddress = lower(envelope.wallet_address);
  const transferCandidates = [];
  for (const log of logs) {
    const transfer = parseErc20TransferLog(log);
    if (!transfer || lower(envelope.transaction?.to) !== transfer.token_contract) continue;
    if (!ADDRESS_RE.test(signer) || transfer.from !== signer) continue;
    if (ADDRESS_RE.test(walletAddress) && walletAddress !== transfer.from) continue;
    const routed = gnosisEndpoint(envelope, transfer.to, GNOSIS_VARIANTS.ERC20_SOURCE, 'out');
    if (!routed) continue;
    const allowedTokens = Array.isArray(routed.config.source_asset_contracts)
      ? new Set(routed.config.source_asset_contracts.map(lower)) : null;
    if (!allowedTokens?.has(transfer.token_contract)) continue;
    transferCandidates.push({ log, transfer, routed });
  }

  // A batch with multiple eligible transfers has no message-level slice in
  // the transaction-granular activity model. Preserve the receipt and let the
  // caller expose it as unsupported instead of choosing one transfer.
  if (transferCandidates.length === 1) {
    const [{ log, transfer, routed }] = transferCandidates;
    const sourceTxHash = lower(envelope.tx_hash);
    events.push(evidence(envelope, log, {
      protocol: 'gnosis', family_version: 'legacy-xdai',
      role: 'initiation', direction: 'out',
      correlation_key: `gnosis-legacy:${sourceTxHash}`,
      status: 'protocol_verified',
      asset_id: `erc20:${Number(envelope.chain_id)}:${transfer.token_contract}`,
      amount: transfer.amount.toString(),
      details: {
        source_tx_hash: sourceTxHash,
        token_contract: transfer.token_contract,
        amount: transfer.amount.toString(),
        sender: transfer.from,
        recipient: transfer.to,
        abi_variant: GNOSIS_VARIANTS.ERC20_SOURCE,
        endpoint_address: lower(routed.endpoint.address),
        raw_log: rawLogEvidence(log),
        required_identity_fields: routed.config.required_identity_fields || [],
        identity_fields: gnosisIdentityFields(routed.endpoint, routed.config, {
          amount: transfer.amount.toString(),
          assetContract: transfer.token_contract,
        }),
      },
    }));
    return events;
  }

  // Native xDAI deposits use the bridge as the transaction target (or emit a
  // bridge-address log). Keep that reviewed legacy path, but route it through
  // the same deployment-scoped registry. A malformed ERC-20 candidate above
  // therefore cannot fall through to an arbitrary token/recipient heuristic.
  const legacySource = (envelope.endpoints || []).filter((endpoint) => (
    endpoint.protocol === 'gnosis'
      && endpoint.family_version === 'legacy-xdai'
      && Number(endpoint.chain_id) === Number(envelope.chain_id)
      && endpoint.role !== 'block_reward'
      && endpointInScope(endpoint, envelope)
      && [lower(envelope.transaction?.to), lower(envelope.receipt?.to), ...logs.map((log) => lower(log.address))]
        .includes(lower(endpoint.address))
  )).map((endpoint) => {
    const configured = endpointVariant(endpoint, GNOSIS_VARIANTS.LEGACY_SOURCE);
    const metadata = endpointMetadata(endpoint);
    const config = configured || (Object.keys(metadata).length === 0 ? {
      supported: true,
      direction: 'out',
      source_chain_id: Number(envelope.chain_id),
      destination_chain_id: null,
      canonical_asset: 'XDAI',
      reference_type: 'source_transaction_hash',
    } : null);
    return config?.supported === true && config.direction === 'out'
      && (!configured || variantChainDirectionMatches(config, envelope, 'out'))
      && endpointAllowsDirection(endpoint, 'out') ? { endpoint, config } : null;
  }).filter(Boolean);
  if (legacySource.length === 1) {
    const [{ endpoint, config }] = legacySource;
    const sourceTxHash = lower(envelope.tx_hash);
    events.push(evidence(envelope, null, {
      protocol: 'gnosis', family_version: 'legacy-xdai', role: 'initiation', direction: 'out',
      correlation_key: `gnosis-legacy:${sourceTxHash}`,
      status: 'protocol_verified',
      asset_id: config.canonical_asset || null,
      details: {
        source_tx_hash: sourceTxHash,
        abi_variant: GNOSIS_VARIANTS.LEGACY_SOURCE,
        endpoint_address: lower(endpoint.address),
        required_identity_fields: config.required_identity_fields || [],
        identity_fields: gnosisIdentityFields(endpoint, config),
      },
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
  log = null, abiVariant = null,
}) {
  const chainId = Number(envelope.chain_id);
  const assets = observedHopAssets(envelope, side === 'source' ? 'out' : 'in');
  return (envelope.hop_routes || []).filter((route) => {
    if (route.enabled === false || route.family_version !== 'v1') return false;
    if (abiVariant && route.abi_variant !== abiVariant) return false;
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

function hopTransferIdCurrent(
  chainId, recipient, amount, transferNonce, bonderFee, tokenIndex, amountOutMin, deadline
) {
  const words = [
    abiUintWord(chainId), abiAddressWord(recipient), abiUintWord(amount),
    abiBytes32Word(transferNonce), abiUintWord(bonderFee), abiUintWord(tokenIndex),
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
    if (![TOPICS.hopTransferSentPinned, TOPICS.hopTransferSent, TOPICS.hopTransferSentToL2,
      TOPICS.hopTransferFromL1Completed, TOPICS.hopWithdrawalBonded,
      TOPICS.hopWithdrawalBondedLegacy, TOPICS.hopWithdrew]
      .includes(topic0)) continue;
    if (!hopEndpointMentioned(envelope, log)) continue;

    if (topic0 === TOPICS.hopTransferSentPinned || topic0 === TOPICS.hopTransferSent) {
      if (envelope.category !== 'bridge_out') continue;
      const pinnedEvent = topic0 === TOPICS.hopTransferSentPinned;
      const expectedDataWords = pinnedEvent ? 6 : 8;
      if (log.topics?.length !== 4 || dataWordCount(log.data) !== expectedDataWords) {
        events.push(hopDiagnostic(envelope, log, 'malformed_transfer_sent_log'));
        continue;
      }
      const eventTransferId = pinnedEvent ? bytes32(log.topics[1]) : null;
      const destinationChainId = uintWord(log.topics[pinnedEvent ? 2 : 1]);
      const recipient = addressWord(log.topics[3]);
      const amount = uintWord(dataWord(log.data, 0));
      const transferNonce = bytes32(dataWord(log.data, 1));
      const bonderFee = uintWord(dataWord(log.data, 2));
      const tokenIndex = pinnedEvent ? null : uintWord(dataWord(log.data, 4));
      const amountOutMin = uintWord(dataWord(log.data, pinnedEvent ? 4 : 5));
      const deadline = uintWord(dataWord(log.data, pinnedEvent ? 5 : 6));
      const bonder = pinnedEvent ? null : addressWord(dataWord(log.data, 7));
      if (destinationChainId == null || (pinnedEvent && !eventTransferId) || !recipient
          || amount == null || !transferNonce || bonderFee == null
          || (!pinnedEvent && (tokenIndex == null || tokenIndex > 255n || !bonder))
          || amountOutMin == null || deadline == null) {
        events.push(hopDiagnostic(envelope, log, 'malformed_transfer_sent_fields'));
        continue;
      }
      const computedTransferId = pinnedEvent
        ? hopTransferId(
          destinationChainId, recipient, amount, transferNonce, bonderFee, amountOutMin, deadline
        )
        : hopTransferIdCurrent(
          destinationChainId, recipient, amount, transferNonce, bonderFee,
          tokenIndex, amountOutMin, deadline
        );
      const transferId = eventTransferId || computedTransferId;
      const transferIdMatches = Boolean(computedTransferId)
        && (!eventTransferId || eventTransferId === computedTransferId);
      const input = transactionInput(envelope.transaction);
      const call = decodeHopCall(input);
      const routes = hopRouteCandidates(envelope, {
        side: 'source', destinationChainId: destinationChainId.toString(),
        tokenIndex: tokenIndex == null ? null : tokenIndex.toString(),
        sourceTokenIndex: call.source_token_index, log,
        abiVariant: pinnedEvent ? 'hop-v1-transfer-sent-withdrawal-v1'
          : 'hop-v1-current-transfer-sent',
      });
      const routeSummaries = routes.map(hopRouteSummary);
      const callKnown = call.kind !== 'missing';
      const target = lower(envelope.transaction?.to || envelope.receipt?.to);
      const sourceTargets = new Set(routes.flatMap((route) => [
        lower(route.source_bridge_address), lower(route.source_wrapper_address),
      ]));
      if (!transferIdMatches || !routes.length
          || (callKnown && (!sourceTargets.has(target) || !hopCallMatchesSource(call, {
            destination_chain_id: destinationChainId.toString(), recipient,
            amount: amount.toString(), bonder_fee: bonderFee.toString(),
            token_index: tokenIndex == null ? null : tokenIndex.toString(),
            amount_out_min: amountOutMin.toString(), deadline: deadline.toString(), bonder,
          })))) {
        const reason = !transferIdMatches ? 'transfer_id_mismatch'
          : !routes.length ? 'unsupported_route'
          : call.kind === 'malformed' ? 'malformed_source_calldata'
            : call.kind === 'unknown' ? 'unsupported_source_calldata_selector'
              : !sourceTargets.has(target) ? 'source_endpoint_mismatch' : 'source_calldata_mismatch';
        events.push(hopDiagnostic(envelope, log, reason, {
          transfer_id: transferId, computed_transfer_id: computedTransferId,
          destination_chain_id: destinationChainId.toString(),
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
            token_index: tokenIndex == null ? null : tokenIndex.toString(),
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
  // Hop's Withdrew event records the amount including the bonder fee. The
  // contract subtracts that fee only when distributing the recipient's funds.
  if (destinationAmount !== gross) return reject('gross_amount_mismatch', {
    gross_amount: gross.toString(), bonder_fee: fee.toString(),
    destination_amount: destinationAmount.toString(), expected_gross_amount: gross.toString(),
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
  hopTransferIdCurrent,
  logIndex,
  opSourceHash,
  parseErc20TransferLog,
  receiptStatus,
  validateHopPair,
  uintWord,
};
