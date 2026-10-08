'use strict';

// Shared decoding kit for the bridge adapters (crypto/interpretation/bridges):
// ABI words, log/receipt accessors, endpoint scoping and the evidence shape
// every adapter emits. Pure: adapters receive only independently fetched
// transaction/receipt data and chain-scoped endpoint rows.

// The ABI/hex primitives are crypto/infra/evm.js, shared with the audit.
const {
  HASH_RE, ADDRESS_RE, lower, eventTopic, functionSelector, bytes32, nonZeroBytes32, logIndex,
  dataWord, dataWordCount, uintWord, receiptStatus, addressWord,
} = require('../../infra/evm');

const RULE_VERSION = 'bridge-match-v1';

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

function formatRawUnits(raw, decimals) {
  const value = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
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
  polygonStateSynced: eventTopic('StateSynced(uint256,address,bytes)'),
  polygonStateCommitted: eventTopic('StateCommitted(uint256,bool)'),
  polygonNewDeposit: eventTopic('NewDepositBlock(address,address,uint256,uint256)'),
  polygonTokenDeposited: eventTopic('TokenDeposited(address,address,address,uint256,uint256)'),
  polygonLockedERC20: eventTopic('LockedERC20(address,address,address,uint256)'),
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

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

module.exports = {
  RULE_VERSION,
  HASH_RE,
  ADDRESS_RE,
  lower,
  eventTopic,
  functionSelector,
  bytes32,
  nonZeroBytes32,
  logIndex,
  dataWord,
  dataWordCount,
  uintWord,
  receiptStatus,
  addressWord,
  endpointMetadata,
  endpointVariant,
  parseBlockNumber,
  envelopeBlockNumber,
  endpointInScope,
  endpointAllowsDirection,
  formatRawUnits,
  rawLogEvidence,
  parseErc20TransferLog,
  transactionInput,
  endpointProtocols,
  evidence,
  TOPICS,
  ZERO_ADDRESS,
};
