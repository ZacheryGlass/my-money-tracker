'use strict';

// Bridge adapter: polygon. Pure decoder of one envelope (transaction, receipt,
// chain-scoped endpoint rows) into bridge evidence events; see kit.js.

const {
  ADDRESS_RE,
  lower,
  eventTopic,
  logIndex,
  dataWord,
  dataWordCount,
  uintWord,
  receiptStatus,
  addressWord,
  endpointInScope,
  endpointAllowsDirection,
  rawLogEvidence,
  parseErc20TransferLog,
  evidence,
  TOPICS,
  bridgeSide,
} = require('./kit');

// Mainnet deployments: maticnetwork/static/network/mainnet/v1/index.json.
// Message ABI: contracts/root/stateSyncer/StateSender.sol, ChildChain.sol,
// pos-portal RootChainManager.sol, genesis-contracts StateReceiver.sol.
// StateCommitted is emitted AFTER the receiver call. Bor receipts batch many
// state syncs: only logs since the preceding commit belong to this state id.
const POLYGON = Object.freeze({
  stateSender: '0x28e4f3a7f651294b9564800b2d01f35189a5bfbe',
  stateReceiver: '0x0000000000000000000000000000000000001001',
  depositManager: '0x401f6c983ea34274ec46f84d70b31c151321188b',
  childChain: '0xd9c7c4ed4b66858301d0cb28cc88bf655fe34861',
  rootManager: '0xa0c68c638235ee32657e8f720a23cec1bfc77c77',
  childManager: '0xa6fa4fb5f76172d178d61b04b0ecd319c5d1c0aa',
  erc20Predicate: '0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf',
  nativeToken: '0x0000000000000000000000000000000000001010',
  rootNativeToken: '0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0',
  ecosystemToken: '0x455e53cbb86018ac2b8092fdcd39d8444affc3f6',
  zero: '0x0000000000000000000000000000000000000000',
});

function polygonEndpoint(envelope, address, direction) {
  return (envelope.endpoints || []).some((endpoint) => endpoint.protocol === 'polygon'
    && Number(endpoint.chain_id) === Number(envelope.chain_id)
    && lower(endpoint.address) === address && endpoint.enabled !== false
    && endpointInScope(endpoint, envelope) && endpointAllowsDirection(endpoint, direction));
}

function polygonEvidence(envelope, log, stateId, recipient, amount, assetId, details) {
  const direction = bridgeSide(envelope.chain_id, 'polygon') === 'l1' ? 'out' : 'in';
  return evidence(envelope, log, {
    protocol: 'polygon', family_version: 'state-sync',
    role: direction === 'out' ? 'initiation' : 'destination_execution', direction,
    correlation_key: `polygon-state-sync:1:137:${stateId}`,
    asset_id: assetId, amount: amount.toString(),
    details: {
      raw_log: rawLogEvidence(log),
      ...details,
      identity_fields: {
        source_chain_id: '1', destination_chain_id: '137',
        state_id: stateId.toString(), recipient, protocol_amount: amount.toString(),
        ...(details.root_token ? { root_token: details.root_token } : {}),
        ...(details.deposit_id != null ? { deposit_id: details.deposit_id } : {}),
      },
      required_identity_fields: [
        'source_chain_id', 'destination_chain_id', 'state_id', 'recipient', 'protocol_amount',
      ],
    },
  });
}

function decodePolygon(envelope) {
  if (receiptStatus(envelope.receipt) !== 1n) return [];
  const logs = envelope.receipt?.logs || [];
  const events = [];
  if (bridgeSide(envelope.chain_id, 'polygon') === 'l1' && envelope.category === 'bridge_out') {
    for (const log of logs) {
      if (lower(log.address) !== POLYGON.stateSender || log.topics?.length !== 3
          || lower(log.topics[0]) !== TOPICS.polygonStateSynced) continue;
      const stateId = uintWord(log.topics[1]);
      const receiver = addressWord(log.topics[2]);
      if (stateId == null || stateId <= 0n || uintWord(dataWord(log.data, 0)) !== 32n) continue;
      let recipient; let rootToken; let amount; let depositId; let supporting;
      let sourceTokenContract;
      if (receiver === POLYGON.childChain && dataWordCount(log.data) === 6
          && uintWord(dataWord(log.data, 1)) === 128n
          && polygonEndpoint(envelope, POLYGON.depositManager, 'out')) {
        recipient = addressWord(dataWord(log.data, 2));
        rootToken = addressWord(dataWord(log.data, 3));
        amount = uintWord(dataWord(log.data, 4));
        depositId = uintWord(dataWord(log.data, 5));
        // Other Plasma tokens can be ERC721; their integer is an ID, not an
        // amount. This deployment's native-token mapping is explicit.
        const sourceTransfer = logs.map(parseErc20TransferLog).find((transfer) => (
          transfer && [POLYGON.rootNativeToken, POLYGON.ecosystemToken]
            .includes(transfer.token_contract) && transfer.from === lower(envelope.wallet_address)
            && transfer.to === POLYGON.depositManager && transfer.amount === amount
        ));
        if (rootToken !== POLYGON.rootNativeToken || !sourceTransfer) continue;
        sourceTokenContract = sourceTransfer.token_contract;
        supporting = logs.filter((item) => lower(item.address) === POLYGON.depositManager
          && item.topics?.length === 3 && lower(item.topics[0]) === TOPICS.polygonNewDeposit
          && addressWord(item.topics[1]) === recipient && addressWord(item.topics[2]) === rootToken
          && dataWordCount(item.data) === 2 && uintWord(dataWord(item.data, 0)) === amount
          && uintWord(dataWord(item.data, 1)) === depositId);
      } else if (receiver === POLYGON.childManager && dataWordCount(log.data) === 10
          && uintWord(dataWord(log.data, 1)) === 256n
          && dataWord(log.data, 2) === eventTopic('DEPOSIT')
          && uintWord(dataWord(log.data, 3)) === 64n
          && uintWord(dataWord(log.data, 4)) === 160n
          && uintWord(dataWord(log.data, 7)) === 96n
          && uintWord(dataWord(log.data, 8)) === 32n
          && polygonEndpoint(envelope, POLYGON.erc20Predicate, 'out')
          && polygonEndpoint(envelope, POLYGON.rootManager, 'out')) {
        recipient = addressWord(dataWord(log.data, 5));
        rootToken = addressWord(dataWord(log.data, 6));
        amount = uintWord(dataWord(log.data, 9));
        sourceTokenContract = rootToken;
        supporting = logs.filter((item) => lower(item.address) === POLYGON.erc20Predicate
          && item.topics?.length === 4 && lower(item.topics[0]) === TOPICS.polygonLockedERC20
          && addressWord(item.topics[1]) === lower(envelope.wallet_address)
          && addressWord(item.topics[2]) === recipient && addressWord(item.topics[3]) === rootToken
          && dataWordCount(item.data) === 1 && uintWord(dataWord(item.data, 0)) === amount);
      }
      if (!recipient || recipient === POLYGON.zero || !rootToken || rootToken === POLYGON.zero
          || amount == null || amount <= 0n || supporting?.length !== 1) continue;
      events.push(polygonEvidence(
        envelope, log, stateId, recipient, amount,
        `erc20:1:${sourceTokenContract}`,
        {
        receiver, root_token: rootToken, deposit_id: depositId?.toString(),
        supporting_logs: supporting.map(rawLogEvidence),
        projection_slice: {
          key: `${lower(log.address)}:${logIndex(log)}`,
          direction: 'out', contract: sourceTokenContract, amount_raw: amount.toString(),
        },
      }
      ));
    }
  } else if (bridgeSide(envelope.chain_id, 'polygon') === 'l2' && envelope.category === 'bridge_in'
      && lower(envelope.transaction?.to) === POLYGON.zero
      && polygonEndpoint(envelope, POLYGON.nativeToken, 'in')
      && ADDRESS_RE.test(lower(envelope.wallet_address))) {
    // Ordinary calls and replay transactions need their own framing. Do not
    // infer an execution boundary for them from nearby logs.
    if (logs.some((log) => logIndex(log) == null)
        || new Set(logs.map(logIndex)).size !== logs.length) return [];
    const ordered = [...logs].sort((a, b) => logIndex(a) - logIndex(b));
    let segment = [];
    for (const log of ordered) {
      if (lower(log.address) !== POLYGON.stateReceiver) { segment.push(log); continue; }
      const frame = segment;
      segment = []; // Every system-receiver event terminates the prior frame.
      if (log.topics?.length !== 2 || lower(log.topics[0]) !== TOPICS.polygonStateCommitted
          || dataWordCount(log.data) !== 1 || uintWord(dataWord(log.data, 0)) !== 1n) continue;
      const stateId = uintWord(log.topics[1]);
      if (stateId == null || stateId <= 0n) continue;
      const plasma = frame.filter((item) => lower(item.address) === POLYGON.childChain
        && item.topics?.length === 4 && lower(item.topics[0]) === TOPICS.polygonTokenDeposited
        && dataWordCount(item.data) === 2);
      let recipient; let amount; let rootToken; let depositId; let childToken; let supporting;
      if (plasma.length === 1) {
        const item = plasma[0];
        recipient = addressWord(item.topics[3]); rootToken = addressWord(item.topics[1]);
        childToken = addressWord(item.topics[2]); amount = uintWord(dataWord(item.data, 0));
        depositId = uintWord(dataWord(item.data, 1)); supporting = plasma;
        if (rootToken !== POLYGON.rootNativeToken || childToken !== POLYGON.nativeToken) continue;
      } else if (plasma.length === 0) {
        const mints = frame.map((item) => ({ item, transfer: parseErc20TransferLog(item) }))
          .filter(({ transfer }) => transfer?.from === POLYGON.zero);
        // ID is the cross-chain proof; matching amounts alone never form a
        // movement. Multiple minted assets require message-level asset slices.
        if (mints.length !== 1) continue;
        const { item, transfer } = mints[0];
        recipient = transfer.to; amount = transfer.amount; childToken = transfer.token_contract;
        supporting = [item];
      } else continue;
      if (recipient !== lower(envelope.wallet_address) || amount == null || amount <= 0n) continue;
      const destinationAssetId = childToken === POLYGON.nativeToken
        ? 'native:137:POL' : `erc20:137:${childToken}`;
      events.push(polygonEvidence(
        envelope, log, stateId, recipient, amount, destinationAssetId,
        {
        root_token: rootToken, child_token: childToken, deposit_id: depositId?.toString(),
        supporting_logs: supporting.map(rawLogEvidence),
        projection_slice: {
          key: `${lower(supporting[0].address)}:${logIndex(supporting[0])}`,
          direction: 'in',
          ...(childToken === POLYGON.nativeToken ? { native: true } : { contract: childToken }),
          amount_raw: amount.toString(),
        },
      }
      ));
    }
  }
  return events;
}

module.exports = {
  protocol: 'polygon',
  order: 30,
  decode: decodePolygon,
};
