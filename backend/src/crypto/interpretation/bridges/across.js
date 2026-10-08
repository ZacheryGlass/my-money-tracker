'use strict';

// Bridge adapter: across. Pure decoder of one envelope (transaction, receipt,
// chain-scoped endpoint rows) into bridge evidence events; see kit.js.

const {
  lower,
  bytes32,
  dataWord,
  uintWord,
  addressWord,
  endpointProtocols,
  evidence,
  TOPICS,
} = require('./kit');

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

module.exports = {
  protocol: 'across',
  order: 80,
  decode: decodeAcross,
};
