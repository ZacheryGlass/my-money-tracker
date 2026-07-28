'use strict';

// Classic-era Arbitrum bridge deposits (pre-Nitro, block <= 22207817) are
// served BACKWARDS by Etherscan's txlist: the migrated retryable-ticket
// deposit comes back as an outbound call from the wallet to the ArbRetryableTx
// precompile with zero gas fields, when what actually happened is the wallet
// was CREDITED the deposit. Ingested as-is that books a phantom native debit
// and misses the credit -- drift of exactly twice the deposit.
//
// These tests are about the reshape being narrow: a row must match EVERY part
// of the declared shape AND name this wallet as the calldata destination to
// become a credit. Anything off-shape ingests through the normal path, where
// the activity ladder flags it -- flag, never guess.
//
// Addresses, hashes and amounts here are SYNTHETIC (the repo is public). The
// precompile, the createRetryableTicket selector and the Nitro cutover block
// are public constants and stay real -- they are the declaration under test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      async query() { return { rows: [], rowCount: 0 }; }
      connect() { throw new Error('Unexpected connect'); }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const chains = require('../src/config/chains');
const EthWalletService = require('../src/services/EthWalletService');

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const PRECOMPILE = '0x000000000000000000000000000000000000006e';
const CUTOVER = 22207817;
const SELECTOR = '0x679b6ded';
const DEPOSIT_WEI = '2000000000000000000';

const CONFIG = chains.getChain(42161).classicRetryableDeposits;

// createRetryableTicket calldata: the selector, then ABI words -- word 0 is
// destAddr (12 zero bytes + the 20 address bytes). Extra words ride along like
// the real calldata's remaining seven arguments.
const abiWord = (address) => address.replace(/^0x/, '').padStart(64, '0');
const calldataFor = (destAddress) =>
  `${SELECTOR}${abiWord(destAddress)}${'0'.repeat(64)}${'0'.repeat(64)}`;

const classicRow = (overrides = {}) => ({
  hash: `0x${'ab'.repeat(32)}`,
  blockNumber: '4000000',
  timeStamp: '1630000000',
  from: WALLET,
  to: PRECOMPILE,
  value: DEPOSIT_WEI,
  gasUsed: '0',
  gasPrice: '0',
  isError: '0',
  methodId: SELECTOR,
  functionName: 'createRetryableTicket(address destAddr,uint256 l2CallValue,uint256 maxSubmissionCost,address excessFeeRefundAddress,address callValueRefundAddress,uint256 maxGas,uint256 gasPriceBid,bytes data)',
  input: calldataFor(WALLET),
  ...overrides,
});

const normalize = (rows) =>
  EthWalletService.normalizeFeeds(WALLET, { normal: rows }, { classicDeposits: CONFIG });

// ---------------------------------------------------------------------------
// The registry declaration
// ---------------------------------------------------------------------------

test('Arbitrum One declares classicRetryableDeposits; no other chain does', () => {
  // Declared like Polygon's stateSyncDeposits: a per-chain fact the ingest
  // reads off the chain object, never a chain-id branch in the sync. All three
  // values are public constants verified against first-party source.
  assert.deepEqual(CONFIG, {
    arbRetryableTx: PRECOMPILE,
    lastClassicBlock: CUTOVER,
    depositMethodId: SELECTOR,
  });
  for (const chain of chains.allChains()) {
    if (chain.id === 42161) continue;
    assert.equal(chain.classicRetryableDeposits, undefined,
      `only Arbitrum One serves migrated classic history: chain ${chain.id}`);
  }
});

// ---------------------------------------------------------------------------
// The reshape
// ---------------------------------------------------------------------------

test('a matching classic deposit becomes ONE inbound credit from the precompile, with no gas leg', () => {
  const rows = normalize([classicRow()]);

  assert.equal(rows.length, 1, 'one credit, not a native-out plus a gas leg');
  const [credit] = rows;
  assert.equal(credit.transfer_type, 'native');
  assert.equal(credit.from_address, PRECOMPILE);
  assert.equal(credit.to_address, WALLET);
  assert.equal(credit.value_wei, DEPOSIT_WEI);
  assert.equal(credit.is_error, false);
  // The real hash, so the row is auditable against the chain and the activity
  // layer groups it like any other transaction.
  assert.equal(credit.tx_hash, `0x${'ab'.repeat(32)}`);
});

test('the credit is transfer_type native, so its own feed deletes and re-derives it', () => {
  // The row comes from txlist, and the normal feed's delete window covers
  // ['native', 'gas']. Stored as 'internal' it would sit inside the internal
  // feed's delete window while never being in the internal feed's fetch, so
  // the first internal resync over its block would delete it forever.
  const [credit] = normalize([classicRow()]);
  assert.equal(credit.transfer_type, 'native');
});

test('a deposit whose calldata destination is another address is left untouched', () => {
  // The wallet's txlist can serve a ticket it funded for someone else. That is
  // a real outbound movement as far as this ledger can tell -- it ingests
  // through the normal path and rule 8 flags it. Flag, never guess.
  const rows = normalize([classicRow({ input: calldataFor(OTHER) })]);

  assert.equal(rows.length, 2, 'the ordinary native-out plus its gas leg');
  const native = rows.find((row) => row.transfer_type === 'native');
  assert.equal(native.from_address, WALLET);
  assert.equal(native.to_address, PRECOMPILE);
});

test('every declaration mismatch falls through to the normal path', () => {
  const offShape = [
    // Nitro-era: one block past the cutover. Type 0x64 deposits ingest
    // correctly already and must not be touched.
    classicRow({ blockNumber: String(CUTOVER + 1) }),
    // A different selector at the precompile.
    classicRow({ methodId: '0xaaaaaaaa' }),
    // Real gas spent: not the migrated shape, and reshaping it would delete a
    // genuine fee from the ledger.
    classicRow({ gasUsed: '21000', gasPrice: '100000000' }),
    classicRow({ gasPrice: '100000000' }),
    // A different contract entirely.
    classicRow({ to: OTHER }),
    // A reverted ticket credited nothing.
    classicRow({ isError: '1' }),
    // Success must be AFFIRMATIVE: Etherscan writes isError as a string, so
    // the number 1 slips past a strict === '1' check, and any unrecognized
    // shape must decline rather than reshape.
    classicRow({ isError: 1 }),
    classicRow({ isError: '2' }),
    // A malformed blockNumber must decline, not coerce: '' and null read as 0
    // through Number(), which would pass the cutover gate and store block 0 --
    // below every future resume window, so the row could never be re-derived.
    classicRow({ blockNumber: '' }),
    classicRow({ blockNumber: null }),
    classicRow({ blockNumber: 'not-a-block' }),
    // Off-shape calldata: too short for word 0, and a word 0 that is not a
    // left-padded address.
    classicRow({ input: SELECTOR }),
    classicRow({ input: `${SELECTOR}${'ff'.repeat(32)}` }),
    classicRow({ input: null }),
  ];

  for (const raw of offShape) {
    const rows = normalize([raw]);
    assert.ok(!rows.some((row) => row.from_address === PRECOMPILE),
      `must not reshape: ${JSON.stringify(raw).slice(0, 120)}`);
  }
});

test('the boundary block itself is still classic', () => {
  // ARB1_NITRO_GENESIS_L2_BLOCK carries the migrated classic state, so a
  // deposit AT the cutover is a classic row; one block later is Nitro.
  const [credit] = normalize([classicRow({ blockNumber: String(CUTOVER) })]);
  assert.equal(credit.from_address, PRECOMPILE);
});

test('without the declaration nothing is reshaped, whatever the row looks like', () => {
  // Mainnet (and every chain but 42161) passes no classicDeposits, so even a
  // byte-identical row ingests through the normal path.
  const rows = EthWalletService.normalizeFeeds(WALLET, { normal: [classicRow()] }, {});
  assert.equal(rows.length, 2);
  assert.ok(!rows.some((row) => row.from_address === PRECOMPILE));
});

test('a zero-value matched row credits nothing and keeps its gas leg', () => {
  const rows = normalize([classicRow({ value: '0' })]);
  // No native leg (nothing moved); the zero-fee gas leg still records the tx.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].transfer_type, 'gas');
  assert.equal(rows[0].value_wei, '0');
});

test('the credit counts toward the derived native balance like any inbound native leg', () => {
  // nativeBalanceDeltas sums transfer_type IN ('native','internal') by
  // to_address/from_address against the wallet -- the reshaped credit is
  // inbound native, so the balance audit reads it with no change of its own.
  const [credit] = normalize([classicRow()]);
  assert.equal(credit.transfer_type, 'native');
  assert.equal(credit.to_address, WALLET);
  assert.notEqual(credit.from_address, WALLET);
});

test('classicRetryableDestination reads word 0, not wherever an address appears', () => {
  // destAddr is createRetryableTicket's FIRST argument. An address in a later
  // word (a refund address, say) must not make the row this wallet's credit.
  const input = `${SELECTOR}${abiWord(OTHER)}${abiWord(WALLET)}`;
  const dest = EthWalletService.classicRetryableDestination(classicRow({ input }), CONFIG);
  assert.equal(dest, OTHER);
});

test('isError declines unless it affirmatively says success', () => {
  // The strict === '1' comparison failed OPEN on the NUMBER 1. The guard now
  // requires a '0'-shaped success signal, with absence normalized to success
  // ('0' is the default) -- every other shape declines.
  assert.equal(EthWalletService.classicRetryableDestination(classicRow({ isError: 1 }), CONFIG), null);
  assert.equal(EthWalletService.classicRetryableDestination(classicRow({ isError: '1' }), CONFIG), null);
  assert.equal(EthWalletService.classicRetryableDestination(classicRow({ isError: '2' }), CONFIG), null);
  assert.equal(EthWalletService.classicRetryableDestination(classicRow({ isError: '' }), CONFIG), null);
  assert.equal(EthWalletService.classicRetryableDestination(classicRow({ isError: '0' }), CONFIG), WALLET);
});

test('a malformed blockNumber declines rather than reading as block 0', () => {
  // Number('') and Number(null) are both 0: under the cutover gate alone the
  // row would reshape and store block_number 0, below every future resume
  // window, so the credit's own feed could never delete and re-derive it.
  for (const blockNumber of ['', null, undefined, 'not-a-block', '1.5']) {
    assert.equal(
      EthWalletService.classicRetryableDestination(classicRow({ blockNumber }), CONFIG),
      null, `blockNumber ${JSON.stringify(blockNumber)} must decline`);
  }
  assert.equal(EthWalletService.classicRetryableDestination(classicRow({ blockNumber: '0' }), CONFIG), WALLET);
});

test('an internal trace from the precompile is filtered, mirroring the state-sync symmetry', () => {
  // The reshaped credit is a NATIVE leg owned by the normal feed's delete
  // window. txlistinternal serves no trace from the precompile today, but if
  // Etherscan ever starts, an unfiltered insert would double-count the deposit
  // -- native and internal are the same inbound arm of the balance derivation,
  // in ordinal namespaces no UNIQUE ties together.
  const trace = {
    hash: `0x${'ab'.repeat(32)}`, blockNumber: '4000000', timeStamp: '1630000000',
    from: PRECOMPILE, to: WALLET, value: DEPOSIT_WEI, isError: '0',
  };
  const rows = EthWalletService.normalizeFeeds(
    WALLET, { normal: [classicRow()], internal: [trace] }, { classicDeposits: CONFIG });
  assert.equal(rows.length, 1, 'exactly the one reshaped credit');
  assert.equal(rows[0].transfer_type, 'native');

  // An ordinary internal trace still ingests when the declaration is present...
  const ordinary = EthWalletService.normalizeFeeds(
    WALLET, { internal: [{ ...trace, from: OTHER }] }, { classicDeposits: CONFIG });
  assert.equal(ordinary.length, 1);
  assert.equal(ordinary[0].transfer_type, 'internal');

  // ...and a chain that declares nothing filters nothing: the filter is a fact
  // about the chain, exactly like the state-sync contract's beside it.
  const undeclared = EthWalletService.normalizeFeeds(WALLET, { internal: [trace] }, {});
  assert.equal(undeclared.length, 1);
  assert.equal(undeclared[0].transfer_type, 'internal');
});
