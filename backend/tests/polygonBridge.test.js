'use strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TOPICS, decodeEnvelope, eventTopic } = require('../src/services/bridge/adapters');
const { buildProtocolMovements, resolveProtocolCoordinateConflicts } = require('../src/services/bridge/matcher');
const EthBridgeMovement = require('../src/models/EthBridgeMovement');

const addr = (digit) => `0x${digit.repeat(40)}`;
const hash = (digit) => `0x${digit.repeat(64)}`;
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const aw = (value) => value.slice(2).padStart(64, '0');
const data = (...words) => `0x${words.join('')}`;
const zero = addr('0');
const wallet = addr('a');
const token = '0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0';
const childToken = addr('c');
const sender = '0x28e4f3a7f651294b9564800b2d01f35189a5bfbe';
const receiver = '0x0000000000000000000000000000000000001001';
const plasma = '0x401f6c983ea34274ec46f84d70b31c151321188b';
const childChain = '0xd9c7c4ed4b66858301d0cb28cc88bf655fe34861';
const rootManager = '0xa0c68c638235ee32657e8f720a23cec1bfc77c77';
const childManager = '0xa6fa4fb5f76172d178d61b04b0ecd319c5d1c0aa';
const predicate = '0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf';
const native = '0x0000000000000000000000000000000000001010';
function log(address, topics, body, index) {
  return { address, topics, data: body, logIndex: `0x${index.toString(16)}` };
}
function envelope(chain, logs) {
  return {
    wallet_id: 1, wallet_address: wallet, chain_id: chain,
    tx_hash: hash(chain === 1 ? '1' : '2'), category: chain === 1 ? 'bridge_out' : 'bridge_in',
    transaction: { to: chain === 1 ? rootManager : zero },
    receipt: { status: '0x1', blockHash: hash('d'), blockNumber: '0x100', logs },
    provider_boundary: { finality: { status: 'finalized' } },
    endpoints: (chain === 1 ? [plasma, rootManager, predicate] : [native]).map((address) => ({
      protocol: 'polygon', chain_id: chain, address, direction: chain === 1 ? 'out' : 'in',
    })),
  };
}
function source(id = 42, amount = 123, kind = 'pos') {
  const payload = kind === 'plasma'
    ? data(word(32), word(128), aw(wallet), aw(token), word(amount), word(1001))
    : data(word(32), word(256), eventTopic('DEPOSIT').slice(2), word(64), word(160),
      aw(wallet), aw(token), word(96), word(32), word(amount));
  const state = log(sender, [TOPICS.polygonStateSynced, data(word(id)),
    data(aw(kind === 'plasma' ? childChain : childManager))], payload, 8);
  const locked = kind === 'plasma'
    ? log(plasma, [TOPICS.polygonNewDeposit, data(aw(wallet)), data(aw(token))],
      data(word(amount), word(1001)), 9)
    : log(predicate, [TOPICS.polygonLockedERC20, data(aw(wallet)), data(aw(wallet)), data(aw(token))],
      data(word(amount)), 7);
  const transfer = log(token, [TOPICS.erc20Transfer, data(aw(wallet)), data(aw(plasma))], data(word(amount)), 6);
  return envelope(1, kind === 'plasma' ? [transfer, state, locked] : [locked, state]);
}
function destination(id = 42, amount = 123, kind = 'pos') {
  const credit = kind === 'plasma'
    ? log(childChain, [TOPICS.polygonTokenDeposited, data(aw(token)), data(aw(native)), data(aw(wallet))],
      data(word(amount), word(1001)), 15)
    : log(childToken, [TOPICS.erc20Transfer, data(aw(zero)), data(aw(wallet))], data(word(amount)), 15);
  const committed = log(receiver, [TOPICS.polygonStateCommitted, data(word(id))], data(word(1)), 16);
  return envelope(137, [credit, committed]);
}
const movements = (...envelopes) => buildProtocolMovements(envelopes.flatMap(decodeEnvelope));

test('Polygon matches PoS ERC20 and Plasma deposits by state id and execution payload', () => {
  for (const kind of ['pos', 'plasma']) {
    const result = movements(source(42, 123, kind), destination(42, 123, kind));
    assert.equal(result.length, 1);
    assert.equal(result[0].status, 'protocol_verified');
    assert.equal(result[0].members[0].amount, '123');
    assert.equal(result[0].members[1].amount, '123');
    assert.equal(result[0].evidence.decoder_events[0].evidence.supporting_logs.length, 1);
  }
});

test('Polygon equal amounts never join different IDs; mismatched amount or recipient cannot verify', () => {
  assert.deepEqual(movements(source(42), destination(43)).map((m) => m.status), ['pending', 'pending']);
  assert.equal(movements(source(42, 123), destination(42, 124))[0].status, 'unsupported');
  const d = destination();
  d.receipt.logs[0].topics[2] = data(aw(addr('e')));
  assert.deepEqual(decodeEnvelope(d), []);
});

test('Polygon batch boundaries prevent another state credit from being reused', () => {
  const d = destination(42, 123, 'plasma');
  const other = destination(43, 456);
  other.receipt.logs.forEach((l, i) => { l.logIndex = `0x${(17 + i).toString(16)}`; });
  d.receipt.logs.push(...other.receipt.logs);
  d.receipt.logs.reverse(); // Providers need not return logs in order.
  const decoded = decodeEnvelope(d);
  assert.deepEqual(decoded.map((e) => [e.evidence.identity_fields.state_id, e.amount]),
    [['42', '123'], ['43', '456']]);
  const firstSource = source(42, 123, 'plasma');
  const secondSource = source(43, 456);
  secondSource.tx_hash = hash('4');
  const pairs = movements(firstSource, secondSource, d);
  assert.equal(pairs.filter((m) => m.status === 'protocol_verified').length, 2);
  assert.ok(resolveProtocolCoordinateConflicts(pairs).every(
    (m) => m.status === 'protocol_verified'
  ));
});

test('Polygon rejects failed, spoofed, incomplete and non-system execution evidence', () => {
  for (const change of [
    (d) => { d.receipt.status = '0x0'; },
    (d) => { d.receipt.logs[1].data = data(word(0)); },
    (d) => { d.receipt.logs[1].address = addr('f'); },
    (d) => { d.receipt.logs.pop(); },
    (d) => { d.transaction.to = receiver; },
    (d) => { d.chain_id = 8453; },
    (d) => { d.endpoints[0].enabled = false; },
    (d) => { d.endpoints[0].valid_from_block = 257; },
    (d) => { d.receipt.logs[0].topics.push(data(word(9))); }, // NFT is not ERC20
    (d) => { d.receipt.logs[0].logIndex = d.receipt.logs[1].logIndex; },
    (d) => { d.receipt.logs[1].topics[1] = '0x01'; },
    (d) => { d.receipt.logs[0].data = data(word(0)); },
  ]) {
    const d = destination(); change(d); assert.deepEqual(decodeEnvelope(d), []);
  }
  const d = destination();
  d.receipt.logs.splice(1, 0, { ...d.receipt.logs[0], logIndex: '0xe' });
  assert.deepEqual(decodeEnvelope(d), []);
});

test('Polygon cannot carry a failed or unrelated state frame forward into the next commit', () => {
  const d = destination();
  d.receipt.logs[1].data = data(word(0));
  d.receipt.logs.push(log(receiver, [TOPICS.polygonStateCommitted, data(word(43))], data(word(1)), 17));
  assert.deepEqual(decodeEnvelope(d), []);
});

test('Polygon source requires canonical ABI, known emitters, registry scope and matching lock event', () => {
  for (const change of [
    (s) => { s.receipt.logs[1].address = addr('f'); },
    (s) => { s.receipt.logs[1].topics[2] = data(aw(addr('e'))); },
    (s) => { s.receipt.logs[1].data += word(0); },
    (s) => { s.receipt.logs[1].data = '0x'; },
    (s) => { s.receipt.logs[1].data = data(word(64)) + s.receipt.logs[1].data.slice(66); },
    (s) => { s.receipt.logs[0].data = data(word(124)); },
    (s) => { s.receipt.logs[0].address = addr('e'); },
    (s) => { s.endpoints = []; },
    (s) => { s.receipt.status = null; },
    (s) => { s.receipt.logs.push({ ...s.receipt.logs[0], logIndex: '0x10' }); },
  ]) {
    const s = source(); change(s); assert.deepEqual(decodeEnvelope(s), []);
  }
});

test('Polygon mismatched Plasma deposit or root token stays incompatible; finality remains required', () => {
  const d = destination(42, 123, 'plasma');
  d.receipt.logs[0].data = data(word(123), word(1002));
  assert.equal(movements(source(42, 123, 'plasma'), d)[0].status, 'unsupported');
  d.receipt.logs[0].data = data(word(123), word(1001));
  d.receipt.logs[0].topics[1] = data(aw(addr('f')));
  assert.deepEqual(decodeEnvelope(d), []);
  const unfinalized = destination();
  unfinalized.provider_boundary.finality.status = 'unknown';
  assert.equal(movements(source(), unfinalized)[0].status, 'pending');
});

test('projection writes two exact links for distinct messages in one destination transaction', async () => {
  const sourceOne = { id: 11, wallet_id: 1, chain_id: 1, tx_hash: hash('1'),
    category: 'bridge_out', legs: [{ asset: 'POL', contract: token, direction: 'out',
      amount: '3', amount_raw: '3000000000000000000' }] };
  const sourceTwo = { id: 12, wallet_id: 1, chain_id: 1, tx_hash: hash('2'),
    category: 'bridge_out', legs: [{ asset: 'USDC', contract: token, direction: 'out',
      amount: '2', amount_raw: '2000000' }] };
  const destination = { id: 13, wallet_id: 1, chain_id: 137, tx_hash: hash('3'),
    category: 'bridge_in', legs: [
      { asset: 'POL', contract: null, direction: 'in', amount: '3', amount_raw: '3000000000000000000' },
      { asset: 'USDC.e', contract: childToken, direction: 'in', amount: '2', amount_raw: '2000000' },
    ] };
  const movementRows = [
    { id: 21, status: 'protocol_verified', verification_method: 'protocol_identity', members: [
      { wallet_id: 1, chain_id: 1, tx_hash: hash('1'), role: 'initiation',
        asset_id: `erc20:1:${token}`, amount: '3000000000000000000', evidence: {
          projection_slice: { key: 'source:1', direction: 'out', contract: token,
            amount_raw: '3000000000000000000' },
        } },
      { wallet_id: 1, chain_id: 137, tx_hash: hash('3'), role: 'destination_execution',
        asset_id: 'native:137:POL', amount: '3000000000000000000', evidence: {
          projection_slice: { key: 'destination:1', direction: 'in', native: true,
            amount_raw: '3000000000000000000' },
        } },
    ] },
    { id: 22, status: 'protocol_verified', verification_method: 'protocol_identity', members: [
      { wallet_id: 1, chain_id: 1, tx_hash: hash('2'), role: 'initiation',
        asset_id: `erc20:1:${token}`, amount: '2000000', evidence: {
          projection_slice: { key: 'source:2', direction: 'out', contract: token, amount_raw: '2000000' },
        } },
      { wallet_id: 1, chain_id: 137, tx_hash: hash('3'), role: 'destination_execution',
        asset_id: `erc20:137:${childToken}`, amount: '2000000', evidence: {
          projection_slice: { key: 'destination:2', direction: 'in', contract: childToken,
            amount_raw: '2000000' },
        } },
    ] },
  ];
  let inserted = null;
  const client = { query: async (sql, params = []) => {
    if (/SELECT a\.id, a\.wallet_id/.test(sql)) return { rows: [sourceOne, sourceTwo, destination] };
    if (/SELECT m\.id, m\.status/.test(sql)) return { rows: movementRows };
    if (/DELETE FROM eth_activity_links/.test(sql)) return { rowCount: 0, rows: [] };
    if (/INSERT INTO eth_activity_links/.test(sql)) {
      inserted = params;
      return { rowCount: 2, rows: [] };
    }
    throw new Error(`Unexpected SQL: ${String(sql).slice(0, 60)}`);
  } };

  assert.equal(await EthBridgeMovement.rebuildProjectionForUser(1, client), 2);
  assert.ok(inserted);
  assert.deepEqual([inserted[0], inserted[9]], [11, 12]);
  assert.deepEqual([inserted[1], inserted[10]], [13, 13]);
  assert.deepEqual(JSON.parse(inserted[6]).map((asset) => asset.asset), ['POL', 'POL']);
  assert.deepEqual(JSON.parse(inserted[15]).map((asset) => asset.asset), ['USDC', 'USDC.e']);
});
