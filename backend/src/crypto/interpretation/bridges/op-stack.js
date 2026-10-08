'use strict';

// Bridge adapter: op-stack. Pure decoder of one envelope (transaction, receipt,
// chain-scoped endpoint rows) into bridge evidence events; see kit.js.

const { keccak_256 } = require('@noble/hashes/sha3.js');
const { bytesToHex, concatBytes, hexToBytes } = require('@noble/hashes/utils.js');
const {
  lower,
  bytes32,
  logIndex,
  dataWord,
  uintWord,
  receiptStatus,
  endpointProtocols,
  evidence,
  TOPICS,
} = require('./kit');
const chains = require('../../../config/chains');

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
  // The canonical bridge settling deposits into this network, from its
  // registry entry (bridge.opStackDestination).
  const destination = chains.getChain(Number(envelope.chain_id))?.bridge?.opStackDestination || null;
  const destinationProtocol = destination?.protocol || null;
  const sourceHash = bytes32(envelope.transaction?.sourceHash);
  const txType = lower(envelope.transaction?.type);
  const outcome = receiptStatus(envelope.receipt);
  if (destinationProtocol
      && envelope.category === 'bridge_in'
      && sourceHash && outcome != null && (txType === '0x7e' || txType === '126')) {
    events.push(evidence(envelope, null, {
      protocol: destinationProtocol, family_version: destination.familyVersion,
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

module.exports = {
  protocol: 'op-stack',
  order: 10,
  decode: decodeOpStack,
  opSourceHash,
};
