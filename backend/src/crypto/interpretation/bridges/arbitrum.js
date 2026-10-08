'use strict';

// Bridge adapter: arbitrum. Pure decoder of one envelope (transaction, receipt,
// chain-scoped endpoint rows) into bridge evidence events; see kit.js.

const {
  lower,
  dataWord,
  uintWord,
  endpointProtocols,
  evidence,
  TOPICS,
  bridgeSide,
} = require('./kit');

function decodeArbitrum(envelope) {
  const events = [];
  for (const log of envelope.receipt?.logs || []) {
    if (!endpointProtocols(envelope, log).has('arbitrum')) continue;
    const topic0 = lower(log.topics?.[0]);
    if (topic0 === TOPICS.arbL2ToL1Tx && bridgeSide(envelope.chain_id, 'arbitrum') === 'l2'
        && envelope.category === 'bridge_out') {
      const position = uintWord(log.topics?.[3]);
      if (position != null) events.push(evidence(envelope, log, {
        protocol: 'arbitrum', family_version: 'nitro', role: 'initiation', direction: 'out',
        correlation_key: `arbitrum-nitro-withdrawal:42161:${position}`,
        details: { position: position.toString() },
      }));
    } else if (topic0 === TOPICS.arbOutboxExecuted && bridgeSide(envelope.chain_id, 'arbitrum') === 'l1'
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

module.exports = {
  protocol: 'arbitrum',
  order: 20,
  decode: decodeArbitrum,
};
