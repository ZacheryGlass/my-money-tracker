'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  HOP_SELECTORS, TOPICS, decodeEnvelope, decodeHopCall, hopTransferId,
} = require('../src/services/bridge/adapters');
const { buildProtocolMovements } = require('../src/services/bridge/matcher');
const {
  buildSeed, endpointRows, routeRows,
} = require('../scripts/generate-hop-bridge-seed');

const hash = (digit) => `0x${digit.repeat(64)}`;
const address = (digit) => `0x${digit.repeat(40)}`;
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`;
const addressWord = (value) => `0x${value.slice(2).padStart(64, '0')}`;
const data = (...words) => `0x${words.map((value) => value.slice(2)).join('')}`;
const call = (selector, ...words) => `${selector}${words.map((value) => value.slice(2)).join('')}`;

const SOURCE_CHAIN = 100;
const DESTINATION_CHAIN = 10;
const SOURCE_BRIDGE = '0x25d8039bb044dc227f741a9e381ca4ceae2e6ae8';
const SOURCE_WRAPPER = '0x76b22b8c1079a44f1211d867d68b1eda76a635a7';
const DESTINATION_BRIDGE = '0x46ae9bab8cea96610807a275ebd36f8e916b5c61';
const DESTINATION_WRAPPER = '0x7d269d3e0d61a05a0ba976b7dbf8805bf844af3f';
const SOURCE_TOKEN = '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83';
const DESTINATION_TOKEN = '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca';
const WALLET = address('9');
const BONDER = address('8');
const AMOUNT = 1_000_000n;
const FEE = 10_000n;
const NET = AMOUNT - FEE;
const NONCE = hash('c');
const MIN = 980_000n;
const DEADLINE = 1_900_000_000n;

const ROUTE = {
  deployment_key: 'hop-mainnet-v1', family_version: 'v1', route_key: 'USDC.e:100->10',
  asset_key: 'USDC.e', source_chain_id: SOURCE_CHAIN, destination_chain_id: DESTINATION_CHAIN,
  source_bridge_address: SOURCE_BRIDGE, source_wrapper_address: SOURCE_WRAPPER,
  destination_bridge_address: DESTINATION_BRIDGE, destination_wrapper_address: DESTINATION_WRAPPER,
  source_asset_addresses: [SOURCE_TOKEN, '0x9ec9551d4a1a1593b0ee8124d98590cc71b3b09d'],
  destination_asset_addresses: [DESTINATION_TOKEN, '0x74fa978eaffa312bc92e76df40fcc1bfe7637aeb'],
  source_token_indices: [0, 1], destination_token_indices: [0, 1],
  source_valid_from_block: 16_617_211, destination_valid_from_block: 2_077_758,
  abi_variant: 'hop-v1-transfer-sent-withdrawal-v1',
  finality_policy: { mode: 'rpc_finalized', required_on: 'both_sides' },
};

const NATIVE_SOURCE_CHAIN = 42161;
const NATIVE_DESTINATION_CHAIN = 1;
const NATIVE_SOURCE_BRIDGE = '0x3749c4f034022c39ecaffaba182555d4508caccc';
const NATIVE_SOURCE_WRAPPER = '0x33ceb27b39d2bb7d2e61f7564d3df29344020417';
const NATIVE_DESTINATION_BRIDGE = '0xb8901acb165ed027e32754e0ffe830802919727f';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const NATIVE_ROUTE = {
  deployment_key: 'hop-mainnet-v1', family_version: 'v1', route_key: 'ETH:42161->1',
  asset_key: 'ETH', source_chain_id: NATIVE_SOURCE_CHAIN,
  destination_chain_id: NATIVE_DESTINATION_CHAIN,
  source_bridge_address: NATIVE_SOURCE_BRIDGE, source_wrapper_address: NATIVE_SOURCE_WRAPPER,
  destination_bridge_address: NATIVE_DESTINATION_BRIDGE, destination_wrapper_address: null,
  source_asset_addresses: [address('a'), address('b'), ZERO_ADDRESS],
  destination_asset_addresses: [ZERO_ADDRESS],
  source_token_indices: [0, 1], destination_token_indices: [0, 1],
  source_valid_from_block: 2_135_598, destination_valid_from_block: 13_331_564,
  abi_variant: 'hop-v1-transfer-sent-withdrawal-v1',
  finality_policy: { mode: 'rpc_finalized', required_on: 'both_sides' },
};

function hopEndpoints(chainId, bridge, wrapper) {
  return [
    { protocol: 'hop', family_version: 'v1', chain_id: chainId, address: bridge },
    { protocol: 'hop', family_version: 'v1', chain_id: chainId, address: wrapper },
  ];
}

function transferSentLog(txHash, blockHash, {
  amount = AMOUNT, fee = FEE, recipient = WALLET,
  amountOutMin = MIN, deadline = DEADLINE,
} = {}) {
  const transferId = hopTransferId(
    DESTINATION_CHAIN, recipient, amount, NONCE, fee, amountOutMin, deadline
  );
  return {
    address: SOURCE_BRIDGE,
    logIndex: '0x7',
    transactionHash: txHash,
    blockHash,
    topics: [TOPICS.hopTransferSentPinned, transferId, word(DESTINATION_CHAIN), addressWord(recipient)],
    data: data(
      word(amount), NONCE, word(fee), word(12), word(amountOutMin), word(deadline),
    ),
  };
}

function withdrewLog(txHash, blockHash, transferId, {
  amount = AMOUNT, recipient = WALLET, nonce = NONCE,
} = {}) {
  return {
    address: DESTINATION_BRIDGE,
    logIndex: '0x3',
    transactionHash: txHash,
    blockHash,
    topics: [TOPICS.hopWithdrew, transferId, addressWord(recipient)],
    data: data(word(amount), nonce),
  };
}

function sourceEnvelope({
  txHash = hash('1'), blockHash = hash('a'), amount = AMOUNT, fee = FEE,
  recipient = WALLET, amountOutMin = MIN, deadline = DEADLINE,
  status = '0x1', input = null, legs = [{ direction: 'out', contract: SOURCE_TOKEN }],
  providerBoundary = { finality: { status: 'finalized', method: 'synthetic-fixture' } },
} = {}) {
  const transactionInput = input || call(
    HOP_SELECTORS.sendLegacy, word(DESTINATION_CHAIN), addressWord(recipient), word(amount),
    word(fee), word(amountOutMin), word(deadline),
  );
  return {
    wallet_id: 1, wallet_address: address('1'), chain_id: SOURCE_CHAIN, tx_hash: txHash,
    category: 'bridge_out', counterparty_address: SOURCE_BRIDGE, wallet_address: address('1'),
    transaction: { hash: txHash, blockHash, to: SOURCE_BRIDGE, input: transactionInput },
    receipt: {
      transactionHash: txHash, blockHash, blockNumber: '0x1000000', status,
      logs: [transferSentLog(txHash, blockHash, {
        amount, fee, recipient, amountOutMin, deadline,
      })],
    },
    endpoints: hopEndpoints(SOURCE_CHAIN, SOURCE_BRIDGE, SOURCE_WRAPPER),
    hop_routes: [ROUTE],
    legs,
    provider_boundary: providerBoundary,
  };
}

function destinationEnvelope({
  txHash = hash('2'), blockHash = hash('b'), transferId, amount = AMOUNT,
  recipient = WALLET, chainId = DESTINATION_CHAIN, status = '0x1',
  legs = [{ direction: 'in', contract: DESTINATION_TOKEN }],
  providerBoundary = { finality: { status: 'finalized', method: 'synthetic-fixture' } },
  feedCoverage,
} = {}) {
  return {
    wallet_id: 1, wallet_address: WALLET, chain_id: chainId, tx_hash: txHash,
    category: 'bridge_in', counterparty_address: DESTINATION_BRIDGE,
    transaction: { hash: txHash, blockHash, to: DESTINATION_BRIDGE, input: '0x' },
    receipt: {
      transactionHash: txHash, blockHash, blockNumber: '0x200000', status,
      logs: [withdrewLog(txHash, blockHash, transferId, { amount, recipient })],
    },
    endpoints: hopEndpoints(chainId, DESTINATION_BRIDGE, DESTINATION_WRAPPER),
    hop_routes: [ROUTE],
    legs,
    feed_coverage: feedCoverage,
    provider_boundary: providerBoundary,
  };
}

function pair(options = {}) {
  const source = sourceEnvelope(options.source);
  const sourceLog = source.receipt.logs[0];
  const transferId = hopTransferId(
    DESTINATION_CHAIN, options.source?.recipient || WALLET,
    options.source?.amount || AMOUNT, NONCE, options.source?.fee || FEE,
    options.source?.amountOutMin || MIN, options.source?.deadline || DEADLINE,
  );
  const destination = destinationEnvelope({ transferId, ...options.destination });
  return { source, destination, sourceLog, transferId };
}

function decodePair(options = {}) {
  const fixtures = pair(options);
  return {
    ...fixtures,
    sourceEvents: decodeEnvelope(fixtures.source),
    destinationEvents: decodeEnvelope(fixtures.destination),
  };
}

function nativeBondedPair({
  destinationRecipient = WALLET, destinationAmount = 900_000n, distribute = false,
} = {}) {
  const gross = 900_000n;
  const fee = 10_000n;
  const transferId = hopTransferId(
    NATIVE_DESTINATION_CHAIN, WALLET, gross, NONCE, fee, 0n, 0n
  );
  const source = sourceEnvelope({
    amount: gross,
    fee,
    amountOutMin: 0n,
    deadline: 0n,
    input: call(
      HOP_SELECTORS.swapAndSendLegacy,
      word(NATIVE_DESTINATION_CHAIN), addressWord(WALLET), word(1_000_000), word(fee),
      word(880_000), word(DEADLINE), word(0), word(0),
    ),
    legs: [{ direction: 'out', contract: null }],
  });
  source.chain_id = NATIVE_SOURCE_CHAIN;
  source.transaction.to = NATIVE_SOURCE_WRAPPER;
  source.receipt.blockNumber = '0x3a00f9';
  source.receipt.logs[0].address = NATIVE_SOURCE_BRIDGE;
  source.receipt.logs[0].topics[1] = transferId;
  source.receipt.logs[0].topics[2] = word(NATIVE_DESTINATION_CHAIN);
  source.endpoints = hopEndpoints(
    NATIVE_SOURCE_CHAIN, NATIVE_SOURCE_BRIDGE, NATIVE_SOURCE_WRAPPER
  );
  source.hop_routes = [NATIVE_ROUTE];

  const destination = destinationEnvelope({
    transferId, amount: gross, recipient: WALLET,
    chainId: NATIVE_DESTINATION_CHAIN,
    legs: [{ direction: 'in', contract: null }],
    feedCoverage: [{ feed: 'internal', status: 'complete', covered_through_block: 13_794_100 }],
  });
  destination.transaction.to = NATIVE_DESTINATION_BRIDGE;
  destination.transaction.input = distribute
    ? call(
      HOP_SELECTORS.bondWithdrawalAndDistribute,
      addressWord(destinationRecipient), word(destinationAmount), NONCE, word(fee), word(0), word(0),
    )
    : call(
      HOP_SELECTORS.bondWithdrawal, addressWord(destinationRecipient), word(destinationAmount),
      NONCE, word(fee),
    );
  destination.receipt.blockNumber = '0xd27b33';
  destination.receipt.logs = [{
    address: NATIVE_DESTINATION_BRIDGE, logIndex: '0x2f',
    transactionHash: destination.tx_hash, blockHash: destination.receipt.blockHash,
    topics: [TOPICS.hopWithdrawalBondedLegacy, transferId], data: data(word(gross)),
  }];
  destination.endpoints = hopEndpoints(
    NATIVE_DESTINATION_CHAIN, NATIVE_DESTINATION_BRIDGE, null
  );
  destination.hop_routes = [NATIVE_ROUTE];
  return { source, destination, transferId, gross, fee };
}

test('Hop v1 derives the canonical transfer ID and folds a finalized route exactly once', () => {
  const { sourceEvents, destinationEvents, transferId } = decodePair();
  assert.equal(sourceEvents.length, 1);
  assert.equal(destinationEvents.length, 1);
  assert.equal(sourceEvents[0].correlation_key, `hop:v1:${transferId}`);
  assert.equal(sourceEvents[0].evidence.hop.transfer_id, transferId);
  assert.equal(sourceEvents[0].fee_amount, FEE.toString());
  assert.equal(destinationEvents[0].amount, AMOUNT.toString());

  const [movement] = buildProtocolMovements([...sourceEvents, ...destinationEvents]);
  assert.equal(movement.status, 'protocol_verified');
  assert.equal(movement.evidence.hop_pair.gross_amount, AMOUNT.toString());
  assert.equal(movement.evidence.hop_pair.bonder_fee, FEE.toString());
  assert.equal(movement.evidence.hop_pair.net_amount, NET.toString());
  assert.equal(movement.evidence.hop_pair.route.route_key, ROUTE.route_key);
});

test('Hop pinned TransferSent rejects an emitted transfer ID that does not recompute', () => {
  const source = sourceEnvelope();
  source.receipt.logs[0].topics[1] = hash('d');
  const [event] = decodeEnvelope(source);
  assert.equal(event.status, 'unsupported');
  assert.equal(event.evidence.hop.reason, 'transfer_id_mismatch');
});

test('Hop pinned swapAndSend validates destination swap bounds while allowing AMM conversion', () => {
  const input = call(
    HOP_SELECTORS.swapAndSendLegacy,
    word(DESTINATION_CHAIN), addressWord(WALLET), word(900_000), word(9_000),
    word(120_000), word(DEADLINE), word(880_000), word(DEADLINE),
  );
  const { sourceEvents } = decodePair({
    source: {
      input, amount: 900_000n, fee: 9_000n, amountOutMin: 880_000n,
      legs: [{ direction: 'out', contract: SOURCE_TOKEN }],
    },
    destination: { amount: 900_000n },
  });
  assert.equal(sourceEvents.length, 1);
  assert.equal(sourceEvents[0].evidence.hop.source_calldata.kind, 'swap_and_send_legacy');
  assert.equal(sourceEvents[0].evidence.hop.source_calldata.destination_amount_out_min, '880000');
});

test('Hop native ETH swap and bonded withdrawal pair from exact calldata and protocol identity', () => {
  const { source, destination, transferId, gross, fee } = nativeBondedPair();
  const sourceEvents = decodeEnvelope(source);
  const destinationEvents = decodeEnvelope(destination);
  assert.equal(sourceEvents.length, 1);
  assert.equal(sourceEvents[0].correlation_key, `hop:v1:${transferId}`);
  assert.deepEqual(sourceEvents[0].evidence.hop.source_asset_observation.addresses,
    [ZERO_ADDRESS]);
  assert.equal(destinationEvents.length, 1);
  assert.equal(destinationEvents[0].status, 'pending');
  assert.equal(destinationEvents[0].evidence.hop.destination_calldata.kind, 'bond_withdrawal');
  assert.equal(destinationEvents[0].evidence.hop.destination_bonder_fee, fee.toString());
  assert.equal(destinationEvents[0].evidence.hop.destination_coverage.feed, 'internal');

  const [movement] = buildProtocolMovements([...sourceEvents, ...destinationEvents]);
  assert.equal(movement.status, 'protocol_verified');
  assert.equal(movement.evidence.hop_pair.gross_amount, gross.toString());
  assert.equal(movement.evidence.hop_pair.net_amount, (gross - fee).toString());
  assert.equal(movement.evidence.hop_pair.route.route_key, NATIVE_ROUTE.route_key);
});

test('Hop retains proven historical feed coverage after a later provider deferral', () => {
  const native = nativeBondedPair();
  native.destination.feed_coverage[0].status = 'deferred';
  const nativeMovement = buildProtocolMovements([
    ...decodeEnvelope(native.source), ...decodeEnvelope(native.destination),
  ])[0];
  assert.equal(nativeMovement.status, 'protocol_verified');

  const token = decodePair({ destination: {
    feedCoverage: [{ feed: 'token', status: 'deferred', covered_through_block: 3_000_000 }],
  } });
  const tokenMovement = buildProtocolMovements([
    ...token.sourceEvents, ...token.destinationEvents,
  ])[0];
  assert.equal(tokenMovement.status, 'protocol_verified');
});

test('Hop bonded withdrawal rejects calldata that does not prove the wallet recipient or amount', () => {
  const wrongRecipient = nativeBondedPair({ destinationRecipient: address('7') });
  const recipientEvent = decodeEnvelope(wrongRecipient.destination)[0];
  assert.equal(recipientEvent.status, 'unsupported');
  assert.equal(recipientEvent.evidence.hop.reason, 'destination_recipient_not_owned');

  const wrongAmount = nativeBondedPair({ destinationAmount: 899_999n });
  const amountEvent = decodeEnvelope(wrongAmount.destination)[0];
  assert.equal(amountEvent.status, 'unsupported');
  assert.equal(amountEvent.evidence.hop.reason, 'destination_calldata_amount_mismatch');
});

test('Hop bonded withdrawal-and-distribute retains its destination swap bounds', () => {
  const { source, destination } = nativeBondedPair({ distribute: true });
  const sourceEvents = decodeEnvelope(source);
  const destinationEvents = decodeEnvelope(destination);
  assert.equal(destinationEvents[0].evidence.hop.destination_calldata.kind,
    'bond_withdrawal_and_distribute');
  assert.equal(destinationEvents[0].evidence.hop.destination_amount_out_min, '0');
  assert.equal(destinationEvents[0].evidence.hop.destination_deadline, '0');
  assert.equal(buildProtocolMovements([...sourceEvents, ...destinationEvents])[0].status,
    'protocol_verified');
});

test('Hop identity does not fold when gross, fee, asset, route, or recipient evidence disagrees', () => {
  const wrongGross = decodePair({ destination: { amount: NET + 1n } });
  const wrongGrossMovements = buildProtocolMovements([
    ...wrongGross.sourceEvents, ...wrongGross.destinationEvents,
  ]);
  assert.equal(wrongGrossMovements.some((movement) => movement.status === 'protocol_verified'), false);
  assert.equal(wrongGrossMovements.find((movement) => movement.protocol === 'hop')?.evidence.ambiguity,
    'gross_amount_mismatch');

  const wrongAsset = decodePair({
    destination: { legs: [{ direction: 'in', contract: address('e') }] },
  });
  assert.equal(wrongAsset.destinationEvents[0].status, 'unsupported');
  assert.equal(buildProtocolMovements([...wrongAsset.sourceEvents, ...wrongAsset.destinationEvents])
    .some((movement) => movement.status === 'protocol_verified'), false);

  const wrongRecipient = decodePair({ destination: { recipient: address('7') } });
  assert.equal(wrongRecipient.destinationEvents[0].status, 'unsupported');
  assert.equal(buildProtocolMovements([
    ...wrongRecipient.sourceEvents, ...wrongRecipient.destinationEvents,
  ]).some((movement) => movement.status === 'protocol_verified'), false);

  const wrongChain = decodePair({
    destination: { chainId: 42161 },
  });
  // The route registry rejects a destination observed on a chain outside the
  // exact source/destination pair; it must not fall back to amount/time.
  assert.equal(wrongChain.destinationEvents.length, 1);
  assert.equal(wrongChain.destinationEvents[0].status, 'unsupported');
});

test('Hop failures, non-finalized receipts, incomplete token coverage, and settlement-only logs stay unfolded', () => {
  const failed = decodePair({ source: { status: '0x0' } });
  assert.equal(buildProtocolMovements([...failed.sourceEvents, ...failed.destinationEvents])[0].status, 'failed');

  const pending = decodePair({
    source: { providerBoundary: { finality: { status: 'pending', method: 'synthetic-fixture' } } },
  });
  assert.equal(buildProtocolMovements([...pending.sourceEvents, ...pending.destinationEvents])[0].status, 'pending');

  const incomplete = decodePair({ destination: {
    feedCoverage: [{ feed: 'token', status: 'complete', covered_through_block: 99 }],
  } });
  const incompleteMovement = buildProtocolMovements([
    ...incomplete.sourceEvents, ...incomplete.destinationEvents,
  ])[0];
  assert.equal(incompleteMovement.status, 'pending');
  assert.equal(incompleteMovement.evidence.ambiguity, 'destination_token_feed_coverage_behind_receipt');

  const { destination, transferId } = pair();
  destination.receipt.logs = [{
    address: DESTINATION_BRIDGE, logIndex: '0x3', transactionHash: destination.tx_hash,
    blockHash: destination.receipt.blockHash,
    topics: [TOPICS.hopWithdrawalBonded, transferId], data: data(word(AMOUNT), addressWord(BONDER)),
  }];
  const settlement = decodeEnvelope(destination);
  assert.equal(settlement.length, 1);
  assert.equal(settlement[0].status, 'unsupported');
  assert.equal(settlement[0].evidence.hop.reason, 'malformed_destination_calldata');
});

test('Hop malformed and L1-to-L2 events are explicit unsupported diagnostics', () => {
  const malformed = sourceEnvelope();
  malformed.receipt.logs[0].data = '0x1234';
  const malformedEvents = decodeEnvelope(malformed);
  assert.equal(malformedEvents.length, 1);
  assert.equal(malformedEvents[0].status, 'unsupported');
  assert.equal(malformedEvents[0].evidence.hop.reason, 'malformed_transfer_sent_log');

  const l1 = sourceEnvelope();
  l1.receipt.logs[0] = {
    ...l1.receipt.logs[0],
    topics: [TOPICS.hopTransferSentToL2], data: '0x',
  };
  const l1Events = decodeEnvelope(l1);
  assert.equal(l1Events.length, 1);
  assert.equal(l1Events[0].status, 'unsupported');
  assert.equal(l1Events[0].evidence.hop.reason, 'unsupported_l1_l2_transfer_id_absent');
});

test('the Hop registry seed is reproducible and remains separate from personal address labels', () => {
  const pack = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../data/hop-bridge-registry.json'), 'utf8'
  ));
  const migration = fs.readFileSync(
    path.join(__dirname, '../migrations/074_hop_bridge_matching.sql'), 'utf8'
  );
  const incrementalMigration = fs.readFileSync(
    path.join(__dirname, '../migrations/084_hop_native_eth_routes.sql'), 'utf8'
  );
  assert.ok(migration.includes(buildSeed(pack)));
  assert.ok(incrementalMigration.includes(buildSeed(pack)));
  const eth = pack.assets.find((asset) => asset.assetKey === 'ETH');
  assert.equal(eth.native, true);
  assert.equal(eth.chains.some((chain) => chain.chainId === 42170), true);
  assert.equal(endpointRows(pack).length, 20);
  assert.equal(routeRows(pack).length, 41);
  assert.equal(fs.existsSync(path.join(__dirname, '../data/builtin-bridge-labels.json')), true);
  const labels = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../data/builtin-bridge-labels.json'), 'utf8'
  ));
  assert.equal((labels.entries || []).some((entry) => entry.protocol === 'hop'), false);
});

test('Hop calldata decoder rejects malformed static ABI and exposes the pinned selectors', () => {
  assert.equal(decodeHopCall(null).kind, 'missing');
  assert.equal(decodeHopCall(`${HOP_SELECTORS.send}00`).kind, 'malformed');
  assert.match(HOP_SELECTORS.send, /^0x[0-9a-f]{8}$/);
  assert.match(HOP_SELECTORS.sendLegacy, /^0x[0-9a-f]{8}$/);
  assert.match(HOP_SELECTORS.swapAndSend, /^0x[0-9a-f]{8}$/);
  assert.match(HOP_SELECTORS.swapAndSendLegacy, /^0x[0-9a-f]{8}$/);
  assert.equal(HOP_SELECTORS.bondWithdrawalAndDistribute, '0x3d12a85a');
  assert.equal(HOP_SELECTORS.bondWithdrawal, '0x23c452cd');
});
