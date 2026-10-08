'use strict';

// Bridge adapter: gnosis. Pure decoder of one envelope (transaction, receipt,
// chain-scoped endpoint rows) into bridge evidence events; see kit.js.

const {
  ADDRESS_RE,
  lower,
  nonZeroBytes32,
  dataWord,
  uintWord,
  receiptStatus,
  addressWord,
  endpointMetadata,
  endpointVariant,
  endpointInScope,
  endpointAllowsDirection,
  formatRawUnits,
  rawLogEvidence,
  parseErc20TransferLog,
  evidence,
  TOPICS,
} = require('./kit');

const GNOSIS_VARIANTS = Object.freeze({
  ERC20_SOURCE: 'erc20_transfer_source',
  LEGACY_SOURCE: 'legacy_source',
  AFFIRMATION_DESTINATION: 'affirmation_completed_destination',
  RELAYED_DESTINATION: 'relayed_message_destination',
});

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

function gnosisDestinationProjectionSlice(envelope, amount, config) {
  const decimals = Number(config.canonical_decimals ?? 18);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const candidates = (envelope.legs || []).filter((leg) => (
    leg.direction === 'in' && !lower(leg.contract || leg.token_contract)
      && /^\d+$/.test(String(leg.amount_raw)) && BigInt(leg.amount_raw) >= amount
  ));
  if (candidates.length !== 1) return null;
  return {
    direction: 'in', native: true, amount_raw: amount.toString(),
    amount: formatRawUnits(amount, decimals), exact_protocol_amount: true,
  };
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
          projection_slice: gnosisDestinationProjectionSlice(envelope, amount, routed.config),
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

module.exports = {
  protocol: 'gnosis',
  order: 40,
  decode: decodeGnosis,
};
