'use strict';

// Bridge adapter: linea. Pure decoder of one envelope (transaction, receipt,
// chain-scoped endpoint rows) into bridge evidence events; see kit.js.

const {
  lower,
  bytes32,
  endpointProtocols,
  evidence,
  TOPICS,
} = require('./kit');

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

module.exports = {
  protocol: 'linea',
  order: 70,
  decode: decodeLinea,
};
