'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const {
  TOPICS, decodeEnvelope, opSourceHash,
} = require('../src/services/bridge/adapters');
const {
  buildProtocolMovements, resolveProtocolCoordinateConflicts,
  suggestBridgeLegs, verdictMovement,
} = require('../src/services/bridge/matcher');
const { validateEvidence } = require('../src/models/EthBridgeReceipt');
const BridgeMatchingService = require('../src/services/BridgeMatchingService');
const EthBridgeEndpoint = require('../src/models/EthBridgeEndpoint');
const EthBridgeMovement = require('../src/models/EthBridgeMovement');
const EthActivityLink = require('../src/models/EthActivityLink');
const pool = require('../src/config/database');
const { endpointApplies, unsupportedMovement } = BridgeMatchingService;
const { buildFinalityBoundary } = require('../src/services/EtherscanService');

const hash = (digit) => `0x${digit.repeat(64)}`;
const address = (digit) => `0x${digit.repeat(40)}`;
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`;
const addressWord = (value) => `0x${value.slice(2).padStart(64, '0')}`;
const data = (...words) => `0x${words.map((value) => value.slice(2)).join('')}`;

function log({ txHash, blockHash, logAddress, index = 0, topics, body = '0x' }) {
  return {
    address: logAddress,
    logIndex: `0x${index.toString(16)}`,
    transactionHash: txHash,
    blockHash,
    topics,
    data: body,
  };
}

function envelope({
  walletId = 1, chainId, txHash, category, tx = {}, logs = [], endpoints = [],
  blockHash = hash('b'), methodName = null, walletAddress = null,
  blockNumber = '0x64', status = '0x1',
  providerBoundary = { finality: { status: 'finalized', method: 'synthetic-fixture' } },
}) {
  return {
    wallet_id: walletId,
    wallet_address: walletAddress,
    chain_id: chainId,
    tx_hash: txHash,
    category,
    method_name: methodName,
    receipt_id: walletId * 10 + chainId,
    transaction: { hash: txHash, blockHash, ...tx },
    receipt: { transactionHash: txHash, blockHash, blockNumber, status, logs },
    endpoints,
    provider_boundary: providerBoundary,
  };
}

function endpoint(protocol, chainId, endpointAddress, familyVersion = 'fixture', extras = {}) {
  return {
    protocol, family_version: familyVersion, chain_id: chainId, address: endpointAddress,
    ...extras,
  };
}

function event(overrides = {}) {
  return {
    protocol: 'fixture', family_version: 'v1', correlation_key: 'id:1',
    role: 'initiation', direction: 'out', status: 'pending',
    wallet_id: 1, chain_id: 1, tx_hash: hash('1'), log_index: 0,
    evidence: { finality: { status: 'finalized', method: 'synthetic-fixture' } },
    ...overrides,
  };
}

test('OP Stack endpoints route Optimism and sourceHash proves identity', () => {
  const sourceTx = hash('1');
  const destinationTx = hash('2');
  const blockHash = hash('a');
  const portal = address('1');
  const source = envelope({
    chainId: 1, txHash: sourceTx, category: 'bridge_out', blockHash,
    endpoints: [endpoint('optimism', 1, portal)],
  });
  source.receipt.logs = [log({
    txHash: sourceTx, blockHash, logAddress: portal, index: 7,
    topics: [TOPICS.opTransactionDeposited],
  })];
  const sourceHash = opSourceHash(blockHash, 7);
  const destination = envelope({
    walletId: 2, chainId: 10, txHash: destinationTx, category: 'bridge_in',
    tx: { sourceHash, type: '0x7e' },
  });

  const decoded = [...decodeEnvelope(destination), ...decodeEnvelope(source)];
  assert.equal(decoded.length, 2);
  assert.deepEqual(new Set(decoded.map((row) => row.protocol)), new Set(['optimism']));
  const movements = buildProtocolMovements(decoded);
  assert.equal(movements.length, 1);
  assert.equal(movements[0].status, 'protocol_verified');
  assert.equal(movements[0].correlation_key, `op-deposit:${sourceHash}`);

  destination.receipt.status = '0x0';
  assert.equal(buildProtocolMovements([
    ...decodeEnvelope(destination), ...decodeEnvelope(source),
  ])[0].status, 'failed');
});

test('Arbitrum Nitro uses non-indexed Outbox transactionIndex, not indexed compatibility zero', () => {
  const position = 43n;
  const sourceTx = hash('3');
  const destinationTx = hash('4');
  const arbSys = address('3');
  const outbox = address('4');
  const l2 = envelope({
    chainId: 42161, txHash: sourceTx, category: 'bridge_out',
    endpoints: [endpoint('arbitrum', 42161, arbSys)],
  });
  l2.receipt.logs = [log({
    txHash: sourceTx, blockHash: l2.receipt.blockHash, logAddress: arbSys,
    topics: [TOPICS.arbL2ToL1Tx, word(0), word(0), word(position)],
  })];
  const l1 = envelope({
    walletId: 2, chainId: 1, txHash: destinationTx, category: 'bridge_in',
    endpoints: [endpoint('arbitrum', 1, outbox)],
  });
  l1.receipt.logs = [log({
    txHash: destinationTx, blockHash: l1.receipt.blockHash, logAddress: outbox,
    topics: [TOPICS.arbOutboxExecuted, word(0), word(0), word(0)],
    body: data(word(position)),
  })];

  const movement = buildProtocolMovements([
    ...decodeEnvelope(l1), ...decodeEnvelope(l2),
  ])[0];
  assert.equal(movement.status, 'protocol_verified');
  assert.equal(movement.correlation_key, `arbitrum-nitro-withdrawal:42161:${position}`);
});

test('Linea joins MessageSent and MessageClaimed by indexed message hash', () => {
  const messageHash = hash('5');
  const sourceTx = hash('6');
  const destinationTx = hash('7');
  const l1Service = address('5');
  const l2Service = address('6');
  const source = envelope({
    chainId: 1, txHash: sourceTx, category: 'bridge_out',
    endpoints: [endpoint('linea', 1, l1Service)],
  });
  source.receipt.logs = [log({
    txHash: sourceTx, blockHash: source.receipt.blockHash, logAddress: l1Service,
    topics: [TOPICS.lineaMessageSent, addressWord(address('a')), addressWord(address('b')), messageHash],
  })];
  const destination = envelope({
    walletId: 2, chainId: 59144, txHash: destinationTx, category: 'bridge_in',
    endpoints: [endpoint('linea', 59144, l2Service)],
  });
  destination.receipt.logs = [log({
    txHash: destinationTx, blockHash: destination.receipt.blockHash, logAddress: l2Service,
    topics: [TOPICS.lineaMessageClaimed, messageHash],
  })];

  assert.equal(buildProtocolMovements([
    ...decodeEnvelope(destination), ...decodeEnvelope(source),
  ])[0].status, 'protocol_verified');
});

test('Gnosis legacy decodes the third non-indexed word as source transaction hash', () => {
  const sourceTx = hash('8');
  const destinationTx = hash('9');
  const l1Bridge = address('7');
  const l2Bridge = address('8');
  const source = envelope({
    chainId: 1, txHash: sourceTx, category: 'bridge_out',
    tx: { to: l1Bridge }, endpoints: [endpoint('gnosis', 1, l1Bridge, 'legacy-xdai')],
  });
  const destination = envelope({
    walletId: 2, chainId: 100, txHash: destinationTx, category: 'bridge_in',
    walletAddress: address('9'),
    endpoints: [endpoint('gnosis', 100, l2Bridge, 'legacy-xdai')],
  });
  destination.receipt.logs = [log({
    txHash: destinationTx, blockHash: destination.receipt.blockHash, logAddress: l2Bridge,
    topics: [TOPICS.gnosisAffirmationCompleted],
    body: data(addressWord(address('9')), word(250), sourceTx),
  })];

  const movement = buildProtocolMovements([
    ...decodeEnvelope(source), ...decodeEnvelope(destination),
  ])[0];
  assert.equal(movement.status, 'protocol_verified');
  assert.equal(movement.correlation_key, `gnosis-legacy:${sourceTx}`);

  source.endpoints = [endpoint('gnosis', 1, l1Bridge, 'usds-router')];
  assert.deepEqual(decodeEnvelope(source), []);
});

test('Gnosis legacy decodes an allowlisted ERC-20 Transfer recipient and exact RelayedMessage reference', () => {
  const sourceTx = hash('a');
  const destinationTx = hash('b');
  const wallet = address('c');
  const token = address('d');
  const sourceBridge = address('e');
  const destinationBridge = address('f');
  const amount = 123456789n;
  const deploymentKey = 'gnosis-xdai-legacy-pre-usds';
  const requiredIdentityFields = [
    'protocol_asset', 'source_chain_id', 'destination_chain_id',
    'deployment_key', 'reference_type',
  ];
  const sourceEndpoint = endpoint('gnosis', 100, sourceBridge, 'legacy-xdai', {
    role: 'bridge', direction: 'out',
    metadata: {
      deployment_key: deploymentKey,
      abi_variants: {
        erc20_transfer_source: {
          supported: true, direction: 'out', source_chain_id: 100,
          destination_chain_id: 1, canonical_asset: 'XDAI',
          source_asset_contracts: [token], reference_type: 'source_transaction_hash',
          required_identity_fields: requiredIdentityFields,
        },
      },
    },
  });
  const destinationEndpoint = endpoint('gnosis', 1, destinationBridge, 'legacy-xdai', {
    role: 'bridge', direction: 'in',
    metadata: {
      deployment_key: deploymentKey,
      abi_variants: {
        relayed_message_destination: {
          supported: true, direction: 'in', source_chain_id: 100,
          destination_chain_id: 1, canonical_asset: 'XDAI',
          reference_type: 'source_transaction_hash',
          required_identity_fields: requiredIdentityFields,
        },
      },
    },
  });
  const source = envelope({
    chainId: 100, txHash: sourceTx, category: 'bridge_out', walletAddress: wallet,
    tx: { from: wallet, to: token }, endpoints: [sourceEndpoint],
  });
  source.receipt.logs = [log({
    txHash: sourceTx, blockHash: source.receipt.blockHash, logAddress: token,
    topics: [TOPICS.erc20Transfer, addressWord(wallet), addressWord(sourceBridge)],
    body: word(amount),
  })];
  const destination = envelope({
    walletId: 2, chainId: 1, txHash: destinationTx, category: 'bridge_in',
    walletAddress: wallet,
    endpoints: [destinationEndpoint],
  });
  destination.receipt.logs = [log({
    txHash: destinationTx, blockHash: destination.receipt.blockHash,
    logAddress: destinationBridge, topics: [TOPICS.gnosisRelayedMessage],
    body: data(addressWord(wallet), word(amount), sourceTx),
  })];

  const sourceEvents = decodeEnvelope(source);
  assert.equal(sourceEvents.length, 1);
  assert.equal(sourceEvents[0].asset_id, `erc20:100:${token}`);
  assert.equal(sourceEvents[0].amount, amount.toString());
  assert.deepEqual(sourceEvents[0].evidence.raw_log, source.receipt.logs[0]);
  assert.deepEqual({
    token_contract: sourceEvents[0].evidence.token_contract,
    amount: sourceEvents[0].evidence.amount,
    sender: sourceEvents[0].evidence.sender,
    recipient: sourceEvents[0].evidence.recipient,
    source_tx_hash: sourceEvents[0].evidence.source_tx_hash,
  }, {
    token_contract: token, amount: amount.toString(), sender: wallet,
    recipient: sourceBridge, source_tx_hash: sourceTx,
  });

  const destinationEvents = decodeEnvelope(destination);
  assert.equal(destinationEvents.length, 1);
  assert.equal(destinationEvents[0].correlation_key, `gnosis-legacy:${sourceTx}`);
  const wrongWalletDestination = structuredClone(destination);
  wrongWalletDestination.wallet_address = address('0');
  assert.deepEqual(decodeEnvelope(wrongWalletDestination), []);
  const movement = buildProtocolMovements([...sourceEvents, ...destinationEvents])[0];
  assert.equal(movement.status, 'protocol_verified');
  assert.equal(movement.members[0].asset_id, `erc20:100:${token}`);

  const failedDestination = structuredClone(destination);
  failedDestination.receipt.status = '0x0';
  assert.equal(buildProtocolMovements([
    ...sourceEvents, ...decodeEnvelope(failedDestination),
  ])[0].status, 'failed');

  const pendingDestination = structuredClone(destination);
  pendingDestination.provider_boundary = {
    finality: { status: 'pending', method: 'eth_getBlockByNumber(finalized)' },
  };
  assert.equal(buildProtocolMovements([
    ...sourceEvents, ...decodeEnvelope(pendingDestination),
  ])[0].status, 'pending');
});

test('Gnosis ERC-20 bridge evidence fails closed for wrong token, recipient, receipt, ABI, and deployment', () => {
  const sourceTx = hash('c');
  const wallet = address('1');
  const token = address('2');
  const bridge = address('3');
  const wrongToken = address('4');
  const wrongRecipient = address('5');
  const deploymentKey = 'gnosis-xdai-legacy-pre-usds';
  const variant = {
    supported: true, direction: 'out', source_chain_id: 100,
    destination_chain_id: 1, canonical_asset: 'XDAI',
    source_asset_contracts: [token], reference_type: 'source_transaction_hash',
    required_identity_fields: [
      'protocol_asset', 'source_chain_id', 'destination_chain_id',
      'deployment_key', 'reference_type',
    ],
  };
  const sourceEndpoint = endpoint('gnosis', 100, bridge, 'legacy-xdai', {
    role: 'bridge', direction: 'out',
    valid_from_block: 50, valid_to_block: 200,
    metadata: { deployment_key: deploymentKey, abi_variants: { erc20_transfer_source: variant } },
  });
  const makeSource = (overrides = {}) => {
    const candidate = envelope({
      chainId: 100, txHash: sourceTx, category: 'bridge_out', walletAddress: wallet,
      tx: { from: wallet, to: token }, endpoints: [sourceEndpoint], ...overrides,
    });
    candidate.receipt.logs = [log({
      txHash: sourceTx, blockHash: candidate.receipt.blockHash, logAddress: token,
      topics: [TOPICS.erc20Transfer, addressWord(wallet), addressWord(bridge)],
      body: word(10),
    })];
    return candidate;
  };

  const wrongRecipientSource = makeSource();
  wrongRecipientSource.receipt.logs[0].topics[2] = addressWord(wrongRecipient);
  assert.deepEqual(decodeEnvelope(wrongRecipientSource), []);

  const wrongTokenSource = makeSource({ tx: { from: wallet, to: wrongToken } });
  wrongTokenSource.receipt.logs[0].address = wrongToken;
  assert.deepEqual(decodeEnvelope(wrongTokenSource), []);

  const failedSource = makeSource({ status: '0x0' });
  assert.deepEqual(decodeEnvelope(failedSource), []);
  assert.equal(unsupportedMovement(failedSource, new Set()).status, 'unsupported');

  const malformedSource = makeSource();
  malformedSource.receipt.logs[0].data = '0x1234';
  assert.deepEqual(decodeEnvelope(malformedSource), []);
  assert.equal(unsupportedMovement(malformedSource, new Set()).status, 'unsupported');

  const outOfWindowSource = makeSource({ blockNumber: '0xc9' });
  assert.deepEqual(decodeEnvelope(outOfWindowSource), []);
  assert.equal(unsupportedMovement(outOfWindowSource, new Set()).status, 'unsupported');

  const sourceOnly = buildProtocolMovements(decodeEnvelope(makeSource()))[0];
  assert.equal(sourceOnly.status, 'pending');

  const unknownVariant = makeSource();
  unknownVariant.endpoints[0].metadata.abi_variants.erc20_transfer_source = {
    ...variant, supported: false, unsupported_reason: 'unreviewed_deployment',
  };
  assert.deepEqual(decodeEnvelope(unknownVariant), []);
  assert.equal(unsupportedMovement(unknownVariant, new Set()).status, 'unsupported');
});

test('zkSync Era Bridgehub destination hash and Lite archive hash are exact identities', () => {
  const eraL2Hash = hash('a');
  const eraSourceTx = hash('b');
  const router = address('a');
  const eraSource = envelope({
    chainId: 1, txHash: eraSourceTx, category: 'bridge_out',
    endpoints: [endpoint('zksync', 1, router)],
  });
  eraSource.receipt.logs = [log({
    txHash: eraSourceTx, blockHash: eraSource.receipt.blockHash, logAddress: router,
    topics: [TOPICS.zksyncDepositFinalized, word(324), hash('c'), eraL2Hash],
  })];
  const eraDestination = envelope({
    walletId: 2, chainId: 324, txHash: eraL2Hash, category: 'bridge_in',
  });
  assert.equal(buildProtocolMovements([
    ...decodeEnvelope(eraSource), ...decodeEnvelope(eraDestination),
  ])[0].status, 'protocol_verified');

  const liteHash = hash('d');
  const liteMain = address('d');
  const liteSource = envelope({
    chainId: 1, txHash: liteHash, category: 'bridge_out', tx: { to: liteMain },
    endpoints: [endpoint('zksync-lite', 1, liteMain)],
  });
  const liteDestination = envelope({
    walletId: 2, chainId: 32401, txHash: liteHash, category: 'bridge_in',
    methodName: 'zkSync Lite Deposit',
  });
  assert.equal(buildProtocolMovements([
    ...decodeEnvelope(liteDestination), ...decodeEnvelope(liteSource),
  ])[0].status, 'protocol_verified');
});

test('Across V3 compares protocol key and common relay fields; V2 remains suggestion-only', () => {
  const sourceTx = hash('e');
  const destinationTx = hash('f');
  const sourcePool = address('e');
  const destinationPool = address('f');
  const token = address('1');
  const outputToken = address('2');
  const depositor = address('3');
  const recipient = address('4');
  const source = envelope({
    chainId: 1, txHash: sourceTx, category: 'bridge_out',
    endpoints: [endpoint('across', 1, sourcePool)],
  });
  source.receipt.logs = [log({
    txHash: sourceTx, blockHash: source.receipt.blockHash, logAddress: sourcePool,
    topics: [TOPICS.acrossV3Deposit, word(10), word(77), addressWord(depositor)],
    body: data(
      addressWord(token), addressWord(outputToken), word(1_000_000), word(995_000),
      word(100), word(200), word(0), addressWord(recipient), addressWord(address('5')), word(320)
    ),
  })];
  const destination = envelope({
    walletId: 2, chainId: 10, txHash: destinationTx, category: 'bridge_in',
    endpoints: [endpoint('across', 10, destinationPool)],
  });
  destination.receipt.logs = [log({
    txHash: destinationTx, blockHash: destination.receipt.blockHash, logAddress: destinationPool,
    topics: [TOPICS.acrossV3Fill, word(1), word(77), addressWord(address('6'))],
    body: data(
      addressWord(token), addressWord(outputToken), word(1_000_000), word(995_000),
      word(1), word(200), word(0), addressWord(address('5')), addressWord(depositor),
      addressWord(recipient), word(352)
    ),
  })];
  assert.equal(buildProtocolMovements([
    ...decodeEnvelope(source), ...decodeEnvelope(destination),
  ])[0].status, 'protocol_verified');

  destination.receipt.logs[0].data = data(
    addressWord(token), addressWord(outputToken), word(1_000_000), word(995_000)
  );
  assert.deepEqual(decodeEnvelope(destination), []);

  source.receipt.logs[0].topics[0] = TOPICS.acrossV2Deposit;
  assert.deepEqual(decodeEnvelope(source), []);
});

test('Polygon PoS and Plasma stay suggestion-only without a shared proof identifier', () => {
  const txHash = hash('1');
  const bridge = address('1');
  const candidate = envelope({
    chainId: 1, txHash, category: 'bridge_out',
    endpoints: [endpoint('polygon', 1, bridge)],
  });
  candidate.receipt.logs = [log({
    txHash, blockHash: candidate.receipt.blockHash, logAddress: bridge,
    topics: [hash('2')], body: data(word(1)),
  })];
  assert.deepEqual(decodeEnvelope(candidate), []);
  const unsupported = unsupportedMovement(candidate, new Set());
  assert.equal(unsupported.status, 'unsupported');
  assert.equal(unsupported.protocol, 'polygon');
  assert.equal(unsupported.members[0].role, 'initiation');
});

test('matching is set-based across out-of-order, concurrent, and cross-protocol identities', () => {
  const events = [
    event({ protocol: 'arbitrum', correlation_key: 'deposit:2', role: 'destination_execution', direction: 'in', chain_id: 42161, tx_hash: hash('4') }),
    event({ protocol: 'optimism', correlation_key: 'deposit:1', tx_hash: hash('1') }),
    event({ protocol: 'arbitrum', correlation_key: 'deposit:2', tx_hash: hash('3') }),
    event({ protocol: 'optimism', correlation_key: 'deposit:1', role: 'destination_execution', direction: 'in', chain_id: 10, tx_hash: hash('2') }),
    // Same textual key in another protocol is intentionally independent.
    event({ protocol: 'linea', correlation_key: 'deposit:1', tx_hash: hash('5') }),
    event({ protocol: 'linea', correlation_key: 'deposit:1', role: 'destination_execution', direction: 'in', chain_id: 59144, tx_hash: hash('6') }),
  ];
  const movements = buildProtocolMovements(events);
  assert.equal(movements.length, 3);
  assert.ok(movements.every((movement) => movement.status === 'protocol_verified'));
});

test('duplicate members, incompatible fields, failures, and refunds never become successful folds', () => {
  const duplicate = buildProtocolMovements([
    event(),
    event({ role: 'destination_execution', direction: 'in', chain_id: 10, tx_hash: hash('2') }),
    event({ role: 'destination_execution', direction: 'in', chain_id: 10, tx_hash: hash('3') }),
  ])[0];
  assert.equal(duplicate.status, 'unsupported');

  const incompatible = buildProtocolMovements([
    event({ evidence: { identity_fields: { recipient: address('1') } } }),
    event({ role: 'destination_execution', direction: 'in', chain_id: 10, tx_hash: hash('2'), evidence: { identity_fields: { recipient: address('2') } } }),
  ])[0];
  assert.equal(incompatible.status, 'unsupported');

  const missingRequired = buildProtocolMovements([
    event({ evidence: {
      required_identity_fields: ['deployment_key'],
      identity_fields: { deployment_key: 'legacy-a' },
    } }),
    event({ role: 'destination_execution', direction: 'in', chain_id: 10, tx_hash: hash('2') }),
  ])[0];
  assert.equal(missingRequired.status, 'unsupported');

  assert.equal(buildProtocolMovements([
    event(), event({ role: 'finalization', direction: 'in', chain_id: 10, status: 'failed' }),
  ])[0].status, 'failed');
  assert.equal(buildProtocolMovements([
    event(), event({ role: 'refund', direction: 'in', chain_id: 1 }),
  ])[0].status, 'refunded');
});

test('multiple protocol messages in one transaction remain unsupported instead of colliding', () => {
  const sharedSource = hash('1');
  const movements = buildProtocolMovements([
    event({ correlation_key: 'id:1', tx_hash: sharedSource, log_index: 0 }),
    event({ correlation_key: 'id:1', role: 'destination_execution', direction: 'in', chain_id: 10, tx_hash: hash('2') }),
    event({ correlation_key: 'id:2', tx_hash: sharedSource, log_index: 1 }),
    event({ correlation_key: 'id:2', role: 'destination_execution', direction: 'in', chain_id: 10, tx_hash: hash('3') }),
  ]);
  assert.ok(movements.every((movement) => movement.status === 'protocol_verified'));

  const resolved = resolveProtocolCoordinateConflicts(movements);
  assert.ok(resolved.every((movement) => movement.status === 'unsupported'));
  assert.ok(resolved.every((movement) => (
    movement.evidence.ambiguity === 'shared_transaction_multiple_protocol_identities'
  )));
});

test('a durable user confirmation owns its transaction coordinates', () => {
  const automatic = buildProtocolMovements([
    event(),
    event({ role: 'destination_execution', direction: 'in', chain_id: 10, tx_hash: hash('2') }),
  ]);
  const manual = [verdictMovement({
    id: 9, out_wallet_id: 1, out_chain_id: 1, out_tx_hash: hash('1'),
    in_wallet_id: 3, in_chain_id: 42161, in_tx_hash: hash('3'),
  })];
  const [resolved] = resolveProtocolCoordinateConflicts(automatic, manual);
  assert.equal(resolved.status, 'unsupported');
  assert.equal(resolved.evidence.ambiguity, 'user_verdict_claims_transaction');
});

test('a transaction-scoped user lock precedes every bridge rebuild snapshot', async (t) => {
  const calls = [];
  const originals = {
    activities: BridgeMatchingService._activitiesForUser,
    acquire: BridgeMatchingService._acquire,
    endpoints: EthBridgeEndpoint.findForTransactions,
    verdicts: EthBridgeMovement.findVerdictsForUser,
    replace: EthBridgeMovement.replaceForUser,
    project: EthBridgeMovement.rebuildProjectionForUser,
    review: EthActivityLink.syncBridgeReviewState,
  };
  t.after(() => {
    BridgeMatchingService._activitiesForUser = originals.activities;
    BridgeMatchingService._acquire = originals.acquire;
    EthBridgeEndpoint.findForTransactions = originals.endpoints;
    EthBridgeMovement.findVerdictsForUser = originals.verdicts;
    EthBridgeMovement.replaceForUser = originals.replace;
    EthBridgeMovement.rebuildProjectionForUser = originals.project;
    EthActivityLink.syncBridgeReviewState = originals.review;
  });

  const client = {
    query: async (sql, params) => {
      calls.push({ kind: 'query', sql, params });
      return { rows: [] };
    },
  };
  BridgeMatchingService._activitiesForUser = async () => { calls.push({ kind: 'activities' }); return []; };
  EthBridgeEndpoint.findForTransactions = async () => [];
  BridgeMatchingService._acquire = async () => [];
  EthBridgeMovement.findVerdictsForUser = async () => { calls.push({ kind: 'verdicts' }); return []; };
  EthBridgeMovement.replaceForUser = async () => {};
  EthBridgeMovement.rebuildProjectionForUser = async () => 0;
  EthActivityLink.syncBridgeReviewState = async () => 0;

  await BridgeMatchingService.rebuildForUser(7, { client, acquireReceipts: false });
  assert.match(calls[0].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(calls[0].params, [1112688964, 7]);
  assert.ok(calls.findIndex((call) => call.kind === 'activities') > 0);
  assert.ok(calls.findIndex((call) => call.kind === 'verdicts') > 0);
});

test('bridge suggestions page independently and report visible truncation', async (t) => {
  const generation = '0123456789abcdef0123456789abcdef';
  const originalConnect = pool.connect;
  const calls = [];
  t.after(() => { pool.connect = originalConnect; });
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM eth_bridge_suggestions s\s+JOIN eth_wallets/.test(sql)) {
        return { rows: [{ id: 2 }] };
      }
      if (/AS protocol_verified/.test(sql)) {
        return { rows: [{ suggestions: 3, suggestion_generation: generation }] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  pool.connect = async () => client;

  const result = await EthBridgeMovement.findAuditForUser(7, {
    limit: 20, offset: 0, suggestionLimit: 1, suggestionOffset: 1,
    suggestionGeneration: generation,
  });
  const suggestionQuery = calls.find(({ sql }) => /FROM eth_bridge_suggestions s\s+JOIN eth_wallets/.test(sql));
  assert.deepEqual(suggestionQuery.params, [7, 1, 1]);
  assert.deepEqual(result.pagination.suggestions, {
    limit: 1, offset: 1, total: 3, generation, has_more: true,
  });
  const summaryQuery = calls.find(({ sql }) => /AS protocol_verified/.test(sql));
  assert.match(summaryQuery.sql, /md5\(COALESCE\(string_agg/);
  assert.match(summaryQuery.sql, /out_wallet_id::text/);
  assert.doesNotMatch(summaryQuery.sql, /MAX\(s\.id\)/);
  assert.match(calls[0].sql, /REPEATABLE READ READ ONLY/);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('bridge continuation rejects and rolls back when its generation changed', async (t) => {
  const originalGeneration = '0123456789abcdef0123456789abcdef';
  const changedGeneration = 'fedcba9876543210fedcba9876543210';
  await assert.rejects(
    EthBridgeMovement.findAuditForUser(7, { suggestionOffset: 1 }),
    (error) => error.code === 'BRIDGE_SUGGESTION_GENERATION_REQUIRED'
  );

  const originalConnect = pool.connect;
  const calls = [];
  t.after(() => { pool.connect = originalConnect; });
  pool.connect = async () => ({
    query: async (sql) => {
      calls.push(sql);
      if (/AS protocol_verified/.test(sql)) {
        return { rows: [{ suggestions: 3, suggestion_generation: changedGeneration }] };
      }
      return { rows: [] };
    },
    release: () => {},
  });

  await assert.rejects(
    EthBridgeMovement.findAuditForUser(7, {
      suggestionOffset: 1, suggestionGeneration: originalGeneration,
    }),
    (error) => error.code === 'BRIDGE_SUGGESTION_PAGE_STALE'
  );
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.ok(!calls.includes('COMMIT'));
});

test('amount and time enumerate every alternative as a suggestion and create no movement', () => {
  const base = {
    wallet_id: 1, block_time: '2026-01-01T00:00:00.000Z',
    legs: [{ asset: 'ETH', amount: '1', token_standard: null, symbol_known: true }],
  };
  const rows = [
    { ...base, chain_id: 1, tx_hash: hash('1'), category: 'bridge_out', endpoint_protocol: 'arbitrum', legs: [{ ...base.legs[0], direction: 'out' }] },
    { ...base, wallet_id: 2, chain_id: 42161, tx_hash: hash('2'), category: 'bridge_in', endpoint_protocol: 'arbitrum', block_time: '2026-01-01T00:05:00.000Z', legs: [{ ...base.legs[0], direction: 'in' }] },
    { ...base, wallet_id: 3, chain_id: 10, tx_hash: hash('3'), category: 'bridge_in', block_time: '2026-01-01T00:06:00.000Z', legs: [{ ...base.legs[0], direction: 'in' }] },
  ];
  const suggestions = suggestBridgeLegs(rows);
  assert.equal(suggestions.length, 2);
  assert.ok(suggestions.every((suggestion) => suggestion.ambiguous));
  assert.deepEqual(buildProtocolMovements([]), []);
});

test('protocol identity remains pending until both receipt chains are finalized', () => {
  const movement = buildProtocolMovements([
    event(),
    event({
      role: 'destination_execution', direction: 'in', chain_id: 10, tx_hash: hash('2'),
      evidence: { finality: { status: 'pending', method: 'eth_getBlockByNumber(finalized)' } },
    }),
  ])[0];
  assert.equal(movement.status, 'pending');
  assert.equal(movement.evidence.ambiguity, 'awaiting_chain_finality');
});

test('finality boundaries use the standard finalized block and fail closed when unavailable', () => {
  assert.deepEqual(buildFinalityBoundary(
    { blockNumber: '0x64' }, { number: '0x65', hash: hash('a') }
  ), {
    status: 'finalized', method: 'eth_getBlockByNumber(finalized)',
    receipt_block_number: '100', finalized_block_number: '101',
    finalized_block_hash: hash('a'),
  });
  assert.equal(buildFinalityBoundary(
    { blockNumber: '0x66' }, { number: '0x65', hash: hash('a') }
  ).status, 'pending');
  assert.equal(buildFinalityBoundary(
    { blockNumber: '0x64' }, null, { code: 'ETHERSCAN_API_ERROR' }
  ).status, 'unknown');
});

test('a durable confirmation is the only non-protocol path to a fold', () => {
  const movement = verdictMovement({
    id: 9, out_wallet_id: 1, out_chain_id: 1, out_tx_hash: hash('1'),
    in_wallet_id: 2, in_chain_id: 10, in_tx_hash: hash('2'), note: 'confirmed by user',
  });
  assert.equal(movement.status, 'user_confirmed');
  assert.equal(movement.verification_method, 'user_verdict');
});

test('malformed or inconsistent provider receipts fail closed before decoding', () => {
  const txHash = hash('1');
  const blockHash = hash('2');
  const transaction = { hash: txHash, blockHash };
  const receipt = {
    transactionHash: txHash, blockHash, blockNumber: '0x10', status: '0x1', logs: [],
  };
  assert.deepEqual(validateEvidence(txHash, transaction, receipt), {
    hash: txHash, blockNumber: 16, blockHash, status: 1,
  });
  assert.throws(() => validateEvidence(txHash, transaction, {
    ...receipt,
    logs: [log({ txHash, blockHash, logAddress: address('1'), topics: [hash('3')], body: '0x123' })],
  }), /malformed/);
  assert.throws(() => validateEvidence(txHash, transaction, {
    ...receipt, blockHash: hash('4'),
  }), /disagree/);
  assert.throws(() => validateEvidence(txHash, transaction, {
    ...receipt, status: null,
  }), /execution status/);
});

test('migration enforces evidence-only folds and cross-owner isolation', () => {
  const migration = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../migrations/072_evidence_first_bridge_matching.sql'),
    'utf8'
  );
  assert.match(migration, /verification_method = 'protocol_identity'/);
  assert.match(migration, /verification_method = 'user_verdict'/);
  assert.doesNotMatch(migration, /verification_method = '(?:amount|address|time)/);
  assert.match(migration, /out_owner <> movement\.user_id OR in_owner <> movement\.user_id/);
  assert.match(migration, /movement_owner <> wallet_owner/);
  assert.match(migration, /out_owner <> NEW\.user_id OR in_owner <> NEW\.user_id/);
  assert.match(migration, /bridge link activities must be members of the verified movement/);
  assert.match(migration, /uq_eth_bridge_confirmed_out_member/);
  assert.match(migration, /uq_eth_bridge_confirmed_in_member/);
  assert.match(migration, /column_name = 'movement_id'/);
});

test('Gnosis endpoint migration records deployment bounds, ABI variants, and finality policy', () => {
  const migration = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../migrations/074_gnosis_bridge_endpoint_variants.sql'),
    'utf8'
  );
  assert.match(migration, /valid_to_block = 23748178/);
  assert.match(migration, /valid_to_block = 43027712/);
  assert.match(migration, /"erc20_transfer_source"/);
  assert.match(migration, /"source_asset_contracts"/);
  assert.match(migration, /"required_identity_fields"/);
  assert.match(migration, /"finality_policy"/);
  assert.match(migration, /"router_message_identity_not_decoded"/);
});

test('endpoint deployment bounds route only receipts from the reviewed version window', () => {
  const bounded = {
    chain_id: 1, valid_from_block: 100, valid_to_block: 200,
  };
  assert.equal(endpointApplies(bounded, { chain_id: 1, block_number: 100 }), true);
  assert.equal(endpointApplies(bounded, { chain_id: 1, block_number: 200 }), true);
  assert.equal(endpointApplies(bounded, { chain_id: 1, block_number: 99 }), false);
  assert.equal(endpointApplies(bounded, { chain_id: 1, block_number: 201 }), false);
  assert.equal(endpointApplies(bounded, { chain_id: 10, block_number: 150 }), false);
  assert.equal(endpointApplies(bounded, { chain_id: 1, block_number: null }), false);
});

test('the reviewed endpoint pack and generated migration seed cannot drift', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { buildSeed } = require('../scripts/generate-bridge-endpoint-seed');
  const pack = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../data/builtin-bridge-labels.json'), 'utf8'
  ));
  const migration = fs.readFileSync(
    path.join(__dirname, '../migrations/072_evidence_first_bridge_matching.sql'), 'utf8'
  );
  assert.ok(migration.includes(buildSeed(pack)));
});

test('OP Mainnet keeps its shared OP Stack predeploy metadata', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const pack = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../data/builtin-bridge-labels.json'), 'utf8'
  ));
  const optimismL2 = pack.labels.filter((entry) => (
    entry.protocol === 'optimism' && entry.chain_id === 10
  ));
  assert.deepEqual(
    optimismL2.map((entry) => entry.address).sort(),
    [
      '0x4200000000000000000000000000000000000010',
      '0x4200000000000000000000000000000000000016',
    ]
  );
});
