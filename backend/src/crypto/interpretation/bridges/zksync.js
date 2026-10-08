'use strict';

// Bridge adapter: zksync. Pure decoder of one envelope (transaction, receipt,
// chain-scoped endpoint rows) into bridge evidence events; see kit.js.

const {
  lower,
  bytes32,
  uintWord,
  endpointProtocols,
  evidence,
  TOPICS,
  bridgeSide,
} = require('./kit');

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
  if (bridgeSide(envelope.chain_id, 'zksync') === 'l2' && envelope.category === 'bridge_in') {
    events.push(evidence(envelope, null, {
      protocol: 'zksync', family_version: 'era-bridgehub',
      role: 'destination_execution', direction: 'in',
      correlation_key: `zksync-era-deposit:324:${lower(envelope.tx_hash)}`,
      status: 'protocol_verified', details: { l2_tx_hash: lower(envelope.tx_hash) },
    }));
  }
  return events;
}

module.exports = {
  protocol: 'zksync',
  order: 50,
  decode: decodeZkSyncEra,
};
