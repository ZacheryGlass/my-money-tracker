'use strict';

// Bridge adapter: zksync-lite. Pure decoder of one envelope (transaction, receipt,
// chain-scoped endpoint rows) into bridge evidence events; see kit.js.

const {
  HASH_RE,
  lower,
  evidence,
  bridgeSide,
} = require('./kit');

function decodeZkSyncLite(envelope) {
  const hash = lower(envelope.tx_hash);
  if (!HASH_RE.test(hash)) return [];
  const ethereumHash = lower(envelope.archive_source_tx_hash);
  if (bridgeSide(envelope.chain_id, 'zksync-lite') === 'l2'
      && envelope.category === 'bridge_in'
      && HASH_RE.test(ethereumHash)) {
    return [evidence(envelope, null, {
      protocol: 'zksync-lite', family_version: 'lite-v1',
      role: 'destination_execution', direction: 'in',
      correlation_key: `zksync-lite-deposit:${ethereumHash}`,
      status: 'protocol_verified',
      details: {
        archive_operation: 'Deposit', ethereum_tx_hash: ethereumHash, lite_tx_hash: hash,
      },
    })];
  }
  const recognized = bridgeSide(envelope.chain_id, 'zksync-lite') === 'l1' && envelope.category === 'bridge_out'
    && (envelope.endpoints || []).some((endpoint) => endpoint.protocol === 'zksync-lite'
      && [lower(envelope.transaction?.to), lower(envelope.receipt?.to)].includes(lower(endpoint.address)));
  return recognized ? [evidence(envelope, null, {
    protocol: 'zksync-lite', family_version: 'lite-v1',
    role: 'initiation', direction: 'out',
    correlation_key: `zksync-lite-deposit:${hash}`,
    details: { ethereum_tx_hash: hash },
  })] : [];
}

module.exports = {
  protocol: 'zksync-lite',
  order: 60,
  decode: decodeZkSyncLite,
};
