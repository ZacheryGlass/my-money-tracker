'use strict';

// The spam quarantine (#74): address poisoning, dust and scam airdrops
// recognized at classification time and taken OUT of the review queue instead
// of demanding a human verdict each.
//
// Two properties are under test throughout, and they are the ones that make a
// quarantine safe rather than merely convenient:
//
//   1. IT HIDES, IT NEVER DELETES. Every quarantined row keeps its ladder
//      verdict, its netted legs, its at-the-time dollars and its fee, and
//      eth_transfers -- which the balance audit (#62) derives from -- is not
//      touched at all. A quarantine that dropped legs would make reconciliation
//      report drift the chain does not have.
//   2. IT CANNOT HIDE REAL MONEY. Each heuristic has a gate, and each gate is
//      exercised here against the transaction it exists to protect: a priced
//      inbound transfer, a claimed airdrop, a token the wallet actually trades,
//      a counterparty the user has already judged.
//
// The heuristics are pure, so they run directly against leg fixtures. The
// stateful half (rebuild, the spam override, route scoping) runs against a fake
// pg Pool, the same way ethActivity.test.js does.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OWN_OTHER = '0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2';
// The address the user actually pays -- the one a poisoner wants imitated.
const PAYEE = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
// Same first four and last four hex characters as PAYEE, which is exactly what
// every explorer and wallet abbreviates an address to.
const LOOKALIKE = '0xbbbb00000000000000000000000000000000bbbb';
const STRANGER = '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';
const ROUTER = '0xcccccccccccccccccccccccccccccccccccccccc';
const ZERO = '0x0000000000000000000000000000000000000000';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const SPAM_TOKEN = '0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1';
const SPAM_NFT = '0xf1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1';

const OWNED_WALLET_ID = 1;
const OWNER_ID = 1;
const FOREIGN_WALLET_ID = 99;
const TX = '0x1111111111111111111111111111111111111111111111111111111111111111';
const TX2 = '0x2222222222222222222222222222222222222222222222222222222222222222';
const TX3 = '0x3333333333333333333333333333333333333333333333333333333333333333';

// --- the fake database -----------------------------------------------------

const db = {
  transfers: [],
  ignoredTokens: [],
  labels: [],
  // Every address the owner has declared theirs. WALLET is added in
  // beforeEach; a second entry stands in for a second tracked wallet.
  ownWallets: [],
  activity: [],
  overrides: new Map(),
};
const queries = [];

const key = (walletId, chainId, txHash) => `${walletId}|${chainId}|${txHash}`;

const ACTIVITY_COLUMNS = [
  'wallet_id', 'chain_id', 'tx_hash', 'block_number', 'block_time', 'category',
  'counterparty_address', 'counterparty_name', 'method_id', 'method_name',
  'legs', 'fee_wei', 'needs_review', 'review_reason', 'confidence',
  'usd_value', 'usd_fee', 'usd_basis',
  'spam', 'spam_reason',
];

const walletRow = (id = OWNED_WALLET_ID) => ({
  id, user_id: OWNER_ID, address: WALLET, label: 'Main', last_block_normal: 0,
});

// Resolves override-over-derived the way the real query's COALESCE does, spam
// included -- and masks needs_review while a row is quarantined without
// clearing the stored flag, which is what makes un-quarantining lossless.
function resolvedRows() {
  return db.activity.map((row) => {
    const override = db.overrides.get(key(row.wallet_id, row.chain_id, row.tx_hash)) || null;
    const overrideCategory = override?.category ?? null;
    const spam = override && override.spam != null ? override.spam : row.spam === true;
    return {
      ...row,
      category: overrideCategory ?? row.category,
      derived_category: row.category,
      override_category: overrideCategory,
      override_note: override ? override.note : null,
      is_overridden: overrideCategory != null,
      spam,
      derived_spam: row.spam === true,
      override_spam: override ? override.spam ?? null : null,
      needs_review: overrideCategory != null || spam ? false : row.needs_review,
      review_reason: overrideCategory != null || spam ? null : row.review_reason,
      wallet_address: WALLET,
    };
  });
}

function fakeQuery(text, params = []) {
  const sql = String(text).replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  queries.push({ sql, params });

  if (/^SELECT \* FROM eth_wallets WHERE id = \$1 AND user_id = \$2/.test(sql)) {
    const [id, userId] = params;
    return { rows: id === OWNED_WALLET_ID && userId === OWNER_ID ? [walletRow()] : [] };
  }
  if (/^SELECT \* FROM eth_wallets WHERE id = \$1/.test(sql)) {
    return { rows: params[0] === OWNED_WALLET_ID ? [walletRow()] : [] };
  }
  if (/^SELECT \* FROM eth_transfers WHERE wallet_id/.test(sql)) {
    return { rows: db.transfers.filter((t) => t.wallet_id === params[0]) };
  }
  if (/^SELECT contract_address FROM eth_ignored_tokens/.test(sql)) {
    return { rows: db.ignoredTokens.map((contract_address) => ({ contract_address })) };
  }
  if (/^SELECT DISTINCT ON \(address\) address, name FROM eth_address_labels/.test(sql)) {
    const wanted = new Set(params[0]);
    return { rows: db.labels.filter((l) => wanted.has(l.address)) };
  }
  if (/^SELECT address, kind FROM eth_address_labels WHERE user_id/.test(sql)) {
    return { rows: db.labels.map((l) => ({ address: l.address, kind: l.kind ?? null })) };
  }
  // Every address the owner has declared theirs, across all their wallets.
  if (/^SELECT address FROM eth_wallets WHERE user_id/.test(sql)) {
    return { rows: db.ownWallets.map((address) => ({ address })) };
  }
  if (/^DELETE FROM eth_activity WHERE wallet_id/.test(sql)) {
    db.activity = db.activity.filter((row) => row.wallet_id !== params[0]);
    return { rows: [], rowCount: 0 };
  }
  if (/^INSERT INTO eth_activity \(/.test(sql)) {
    let inserted = 0;
    for (let i = 0; i < params.length; i += ACTIVITY_COLUMNS.length) {
      const row = {};
      ACTIVITY_COLUMNS.forEach((col, j) => { row[col] = params[i + j]; });
      row.legs = JSON.parse(row.legs);
      // Stands in for 045's paired CHECK: a quarantine always says why, and an
      // unquarantined row never carries a stale reason.
      assert.equal(
        row.spam === true, row.spam_reason != null,
        'eth_activity_spam_reason_paired: spam and spam_reason must agree'
      );
      const exists = db.activity.some((r) => key(r.wallet_id, r.chain_id, r.tx_hash)
        === key(row.wallet_id, row.chain_id, row.tx_hash));
      if (exists) continue;
      db.activity.push(row);
      inserted++;
    }
    return { rows: [], rowCount: inserted };
  }
  if (/^SELECT 1 FROM eth_activity a JOIN eth_wallets w/.test(sql)) {
    const [walletId, chainId, txHash, userId] = params;
    if (userId !== OWNER_ID) return { rows: [] };
    const exists = db.activity.some((r) => key(r.wallet_id, r.chain_id, r.tx_hash)
      === key(walletId, chainId, txHash));
    return { rows: exists ? [{ '?column?': 1 }] : [] };
  }
  if (/^INSERT INTO eth_activity_overrides \(wallet_id, chain_id, tx_hash, spam\)/.test(sql)) {
    const [walletId, chainId, txHash, spam, userId] = params;
    if (walletId !== OWNED_WALLET_ID || userId !== OWNER_ID) return { rows: [] };
    const k = key(walletId, chainId, txHash);
    const existing = db.overrides.get(k);
    const row = existing
      ? { ...existing, spam }
      : { wallet_id: walletId, chain_id: chainId, tx_hash: txHash, category: null, note: null, spam };
    db.overrides.set(k, row);
    return { rows: [row] };
  }
  if (/^INSERT INTO eth_activity_overrides/.test(sql)) {
    const [walletId, chainId, txHash, category, note, userId] = params;
    if (walletId !== OWNED_WALLET_ID || userId !== OWNER_ID) return { rows: [] };
    const existing = db.overrides.get(key(walletId, chainId, txHash));
    // The category upsert's DO UPDATE names category and note only, so a spam
    // verdict rides through a re-categorization untouched.
    const row = {
      wallet_id: walletId, chain_id: chainId, tx_hash: txHash, category, note,
      spam: existing ? existing.spam ?? null : null,
    };
    db.overrides.set(key(walletId, chainId, txHash), row);
    return { rows: [row] };
  }
  if (/^DELETE FROM eth_activity_overrides/.test(sql)) {
    const [walletId, chainId, txHash, userId] = params;
    if (walletId !== OWNED_WALLET_ID || userId !== OWNER_ID) return { rows: [] };
    const k = key(walletId, chainId, txHash);
    const row = db.overrides.get(k);
    if (!row) return { rows: [] };
    db.overrides.delete(k);
    return { rows: [row] };
  }
  if (/^WITH resolved AS/.test(sql)) {
    const filterOf = (column) => {
      const match = sql.match(new RegExp(`r\\.${column} = \\$(\\d+)`));
      return match ? params[Number(match[1]) - 1] : undefined;
    };
    let rows = resolvedRows();
    if (/AND NOT r\.spam/.test(sql)) rows = rows.filter((r) => !r.spam);
    else if (/AND r\.spam(?![_a-z])/.test(sql)) rows = rows.filter((r) => r.spam);
    const walletId = filterOf('wallet_id');
    const category = filterOf('category');
    const needsReview = filterOf('needs_review');
    if (walletId !== undefined) rows = rows.filter((r) => r.wallet_id === walletId);
    if (category !== undefined) rows = rows.filter((r) => r.category === category);
    if (needsReview !== undefined) rows = rows.filter((r) => r.needs_review === needsReview);
    const total = rows.length;
    return { rows: rows.map((r) => ({ ...r, total_count: total })) };
  }
  if (/^SELECT COUNT\(\*\)::int AS total, \(COUNT\(\*\) FILTER \(WHERE needs_review\)\)/.test(sql)) {
    const rows = resolvedRows();
    return {
      rows: [{
        total: rows.length,
        needs_review_count: rows.filter((r) => r.needs_review).length,
        spam_count: rows.filter((r) => r.spam).length,
      }],
    };
  }
  return { rows: [] };
}

const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      async query(text, params) { return fakeQuery(text, params); }
      async connect() {
        return { query: async (text, params) => fakeQuery(text, params), release() {} };
      }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const request = require('supertest');
const app = require('../src/server');
const EthTransfer = require('../src/models/EthTransfer');
const EthActivityService = require('../src/services/EthActivityService');

const { buildActivityRows, SPAM_REASONS } = EthActivityService;

// --- leg fixtures ----------------------------------------------------------

let nextId = 1;

function leg(overrides = {}) {
  return {
    id: nextId++,
    wallet_id: OWNED_WALLET_ID,
    chain_id: 1,
    tx_hash: TX,
    ordinal: 0,
    transfer_type: 'native',
    block_number: 1000,
    block_time: '2026-01-05T12:00:00.000Z',
    from_address: WALLET,
    to_address: PAYEE,
    value_wei: '1000000000000000000',
    token_contract: null,
    token_symbol: null,
    token_decimals: null,
    token_standard: null,
    token_id: null,
    is_error: false,
    tx_is_error: false,
    counterparty_is_own: false,
    counterparty_exchange: null,
    method_id: null,
    method_name: null,
    // Unpriced unless a test says otherwise, which is the honest default for a
    // token nobody lists.
    usd_at_time: null,
    usd_basis: 'unpriced',
    ...overrides,
  };
}

// A gas leg exists exactly once per tx the wallet SENT. Its presence IS the
// wallet owner's signature, which is the gate every heuristic runs behind.
const gasLeg = (overrides = {}) => leg({
  transfer_type: 'gas', value_wei: '2100000000000000', to_address: PAYEE, ...overrides,
});

const tokenLeg = (overrides = {}) => leg({
  transfer_type: 'token', token_standard: 'erc20', token_decimals: 18, ...overrides,
});

const nftLeg = (overrides = {}) => leg({
  transfer_type: 'nft',
  token_standard: 'erc721',
  token_contract: SPAM_NFT,
  token_symbol: 'FREEMINT',
  token_decimals: 0,
  token_id: '1',
  // 033: a count of units, never wei.
  value_wei: '1',
  ...overrides,
});

// The wallet's own history of paying PAYEE: signed (gas leg) and nonzero, which
// is what puts PAYEE in the set a lookalike would be imitating.
const paidPayeeBefore = () => [
  leg({ tx_hash: TX3, block_number: 900, to_address: PAYEE, usd_at_time: '2500.00', usd_basis: 'exact' }),
  gasLeg({ tx_hash: TX3, block_number: 900, to_address: PAYEE }),
];

const only = (legs, options) => {
  const rows = buildActivityRows(WALLET, legs, options);
  assert.equal(rows.length, 1, 'expected exactly one activity row');
  return rows[0];
};

// The row for one transaction out of a wallet-wide fixture, because the
// heuristics read wallet-wide evidence and a per-transaction build would answer
// differently.
const rowFor = (legs, txHash, options) => {
  const row = buildActivityRows(WALLET, legs, options).find((r) => r.tx_hash === txHash);
  assert.ok(row, `expected an activity row for ${txHash}`);
  return row;
};

beforeEach(() => {
  db.transfers = [];
  db.ignoredTokens = [];
  db.labels = [];
  db.ownWallets = [WALLET];
  db.activity = [];
  db.overrides.clear();
  queries.length = 0;
  delete process.env.DEV_AUTH_USER_ID;
});

// --- heuristic 1: address poisoning ----------------------------------------

test('a dust transfer from a lookalike address is quarantined as poisoning', () => {
  // Same first four and last four hex characters as an address the wallet
  // actually pays -- the whole mechanism of the attack, whose payoff is a
  // future copy-paste out of transaction history.
  const row = rowFor([
    ...paidPayeeBefore(),
    leg({
      tx_hash: TX, from_address: LOOKALIKE, to_address: WALLET,
      value_wei: '10000000000000', usd_at_time: '0.02', usd_basis: 'exact',
    }),
  ], TX);

  assert.equal(row.spam, true);
  assert.equal(row.spam_reason, SPAM_REASONS.ADDRESS_POISONING);
  // The verdict, the legs and the dollars all survive: this is a quarantine.
  assert.equal(row.category, 'receive');
  assert.equal(row.legs.length, 1);
  assert.equal(row.usd_value, 0.02);
});

test('the spoofed-outbound poisoning variant is caught, and cannot immunize itself', () => {
  // transferFrom(victim, lookalike, 0) needs no allowance in most ERC-20s, so
  // the attacker emits a Transfer event with `from` set to the victim. It shows
  // up in the victim's feed as an OUTBOUND leg -- which would make it material
  // in the triage queue -- and the wallet never signed a thing.
  const legs = [
    ...paidPayeeBefore(),
    tokenLeg({
      tx_hash: TX, token_contract: USDC, token_symbol: 'USDC', token_decimals: 6,
      from_address: WALLET, to_address: LOOKALIKE, value_wei: '0',
    }),
  ];
  const row = rowFor(legs, TX);

  assert.equal(row.spam, true);
  assert.equal(row.spam_reason, SPAM_REASONS.ADDRESS_POISONING);

  // And the lookalike must NOT join the set of addresses the wallet "pays",
  // or the next poisoning transfer from it would be shielded by the first.
  const second = rowFor([
    ...legs,
    leg({
      tx_hash: TX2, block_number: 1100, from_address: LOOKALIKE, to_address: WALLET,
      value_wei: '10000000000000', usd_at_time: '0.02', usd_basis: 'exact',
    }),
  ], TX2);
  assert.equal(second.spam_reason, SPAM_REASONS.ADDRESS_POISONING);
});

test('a lookalike of the wallet\'s own address counts too', () => {
  const impostor = `0x${WALLET.slice(2, 6)}${'1'.repeat(32)}${WALLET.slice(-4)}`;
  const row = only([
    leg({
      from_address: impostor, to_address: WALLET,
      value_wei: '1', usd_at_time: '0.00', usd_basis: 'exact',
    }),
  ]);

  assert.equal(row.spam_reason, SPAM_REASONS.ADDRESS_POISONING);
});

// --- heuristic 1's gate: a lookalike alone must never hide real money -------

test('a lookalike of the owner\'s OTHER wallet counts, even with no traffic between them', async () => {
  // counterparty_is_own only appears on transfers BETWEEN two of the owner's
  // addresses, so a user with two wallets that have never transacted would
  // otherwise be blind to a lookalike of their second address -- which is the
  // single most valuable thing for a poisoner to imitate.
  const secondWallet = `0x${'7'.repeat(40)}`;
  const impostor = `0x${secondWallet.slice(2, 6)}${'1'.repeat(32)}${secondWallet.slice(-4)}`;
  db.ownWallets = [WALLET, secondWallet];
  db.transfers = [leg({
    from_address: impostor, to_address: WALLET,
    value_wei: '10000000000000', usd_at_time: '0.02', usd_basis: 'exact',
  })];

  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);

  assert.equal(db.activity[0].spam, true);
  assert.equal(db.activity[0].spam_reason, SPAM_REASONS.ADDRESS_POISONING);
});

test('an \'own\'-labeled untracked address is imitable too', async () => {
  const coldStorage = `0x${'8'.repeat(40)}`;
  const impostor = `0x${coldStorage.slice(2, 6)}${'1'.repeat(32)}${coldStorage.slice(-4)}`;
  db.labels = [{ address: coldStorage, name: 'Cold storage', kind: 'own' }];
  db.transfers = [leg({
    from_address: impostor, to_address: WALLET,
    value_wei: '10000000000000', usd_at_time: '0.02', usd_basis: 'exact',
  })];

  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);

  assert.equal(db.activity[0].spam_reason, SPAM_REASONS.ADDRESS_POISONING);
});

test('GATE: a PRICED inbound transfer from a lookalike is never quarantined', () => {
  // Four hex characters at each end is 32 bits of coincidence -- unlikely, not
  // impossible -- and the cost of being wrong here is hiding a payment. So a
  // lookalike quarantines dust and nothing else. This transfer stays visible,
  // stays in the review queue, and a human decides.
  const row = rowFor([
    ...paidPayeeBefore(),
    leg({
      tx_hash: TX, from_address: LOOKALIKE, to_address: WALLET,
      value_wei: '250000000000000000', usd_at_time: '450.00', usd_basis: 'exact',
    }),
  ], TX);

  assert.equal(row.spam, false);
  assert.equal(row.spam_reason, null);
  assert.equal(row.category, 'receive');
  assert.equal(row.needs_review, true, 'it stays a human decision');
});

test('GATE: an UNPRICED inbound ETH transfer from a lookalike is never quarantined', () => {
  // No price means the size is unknown, not small. Quarantining on a lookalike
  // plus a shrug would be the silent-zero failure wearing a security hat.
  const row = rowFor([
    ...paidPayeeBefore(),
    leg({
      tx_hash: TX, from_address: LOOKALIKE, to_address: WALLET,
      value_wei: '3000000000000000000', usd_at_time: null, usd_basis: 'unpriced',
    }),
  ], TX);

  assert.equal(row.spam, false);
  assert.equal(row.needs_review, true);
});

test('GATE: an address that merely shares a prefix is not a lookalike', () => {
  const halfMatch = `0x${PAYEE.slice(2, 6)}${'9'.repeat(36)}`;
  const row = rowFor([
    ...paidPayeeBefore(),
    leg({
      tx_hash: TX, from_address: halfMatch, to_address: WALLET,
      value_wei: '10000000000000', usd_at_time: '0.02', usd_basis: 'exact',
    }),
  ], TX);

  assert.equal(row.spam, false);
});

// --- heuristic 2: a zero-value transfer nobody asked for --------------------

test('a zero-value token transfer the wallet did not initiate is always spam', () => {
  const row = only([
    tokenLeg({
      token_contract: SPAM_TOKEN, token_symbol: 'CLAIM-AT-EVIL.IO',
      from_address: STRANGER, to_address: WALLET, value_wei: '0',
    }),
  ]);

  assert.equal(row.spam, true);
  assert.equal(row.spam_reason, SPAM_REASONS.ZERO_VALUE_TRANSFER);
  // Zero cost to being wrong: a transaction in which every leg is exactly zero
  // has no financial content to hide.
  assert.deepEqual(row.legs, []);
  assert.equal(row.category, 'contract_interaction');
});

test('GATE: a zero-value leg riding alongside a real one is not spam', () => {
  const row = only([
    tokenLeg({
      token_contract: SPAM_TOKEN, from_address: STRANGER, to_address: WALLET, value_wei: '0',
    }),
    tokenLeg({
      token_contract: USDC, token_symbol: 'USDC', token_decimals: 6,
      from_address: STRANGER, to_address: WALLET, value_wei: '500000000',
      usd_at_time: '500.00', usd_basis: 'exact',
    }),
  ]);

  assert.equal(row.spam, false, 'money moved in this transaction');
  assert.equal(row.usd_value, 500);
});

// --- heuristic 3: an unsolicited NFT ---------------------------------------

test('an NFT minted to the wallet by someone else is quarantined', () => {
  const row = only([nftLeg({ from_address: ZERO, to_address: WALLET })]);

  assert.equal(row.spam, true);
  assert.equal(row.spam_reason, SPAM_REASONS.UNSOLICITED_NFT);
  // The ladder still says what it was, and the unit count is still a unit count.
  assert.equal(row.category, 'nft_mint');
  assert.equal(row.legs[0].amount, '1');
});

test('GATE: an NFT the wallet minted itself is never spam', () => {
  const row = only([
    nftLeg({ from_address: ZERO, to_address: WALLET }),
    leg({ to_address: SPAM_NFT, value_wei: '80000000000000000', usd_at_time: '150.00', usd_basis: 'exact' }),
    gasLeg({ to_address: SPAM_NFT }),
  ]);

  assert.equal(row.spam, false, 'the wallet signed this transaction');
  assert.equal(row.category, 'nft_mint');
});

test('GATE: a second NFT from a collection the wallet has traded is not unsolicited', () => {
  const row = rowFor([
    // Bought one, signed for it.
    nftLeg({ tx_hash: TX3, block_number: 900, from_address: ROUTER, to_address: WALLET, token_id: '7' }),
    leg({ tx_hash: TX3, block_number: 900, to_address: ROUTER, value_wei: '500000000000000000' }),
    gasLeg({ tx_hash: TX3, block_number: 900, to_address: ROUTER }),
    // A second one arrives unbidden -- an airdrop to holders, not a scam mint.
    nftLeg({ tx_hash: TX, from_address: STRANGER, to_address: WALLET, token_id: '8' }),
  ], TX);

  assert.equal(row.spam, false);
});

// --- heuristic 4: an unsolicited, unpriced token ---------------------------

test('an unpriced token the wallet has never touched, arriving unbidden, is spam', () => {
  const row = only([
    tokenLeg({
      token_contract: SPAM_TOKEN, token_symbol: 'USDC-REWARD',
      from_address: STRANGER, to_address: WALLET, value_wei: '10000000000000000000000',
    }),
  ]);

  assert.equal(row.spam, true);
  assert.equal(row.spam_reason, SPAM_REASONS.UNSOLICITED_TOKEN);
  assert.equal(row.category, 'receive');
  // Nothing was thrown away: the leg is still netted and still countable.
  assert.equal(row.legs[0].amount, '10000');
});

test('GATE: a PRICED token arriving unbidden is never quarantined', () => {
  // Somebody paying you in USDC is not spam, however unexpected it was. Only
  // the first of the three conditions holds here, and one is not enough.
  const row = only([
    tokenLeg({
      token_contract: USDC, token_symbol: 'USDC', token_decimals: 6,
      from_address: STRANGER, to_address: WALLET, value_wei: '2500000000',
      usd_at_time: '2500.00', usd_basis: 'exact',
    }),
  ]);

  assert.equal(row.spam, false);
  assert.equal(row.needs_review, true, 'an unexplained $2,500 arrival stays in the queue');
});

test('GATE: a token the wallet has sent before is not unsolicited, priced or not', () => {
  const row = rowFor([
    tokenLeg({
      tx_hash: TX3, block_number: 900, token_contract: SPAM_TOKEN, token_symbol: 'OBSCURE',
      from_address: WALLET, to_address: ROUTER, value_wei: '5000000000000000000',
    }),
    gasLeg({ tx_hash: TX3, block_number: 900, to_address: ROUTER }),
    tokenLeg({
      tx_hash: TX, token_contract: SPAM_TOKEN, token_symbol: 'OBSCURE',
      from_address: STRANGER, to_address: WALLET, value_wei: '5000000000000000000',
    }),
  ], TX);

  assert.equal(row.spam, false, 'the wallet holds this token on purpose');
});

test('GATE: approving a token counts as touching it, even with no transfer log', () => {
  // An approve emits no Transfer event at all, so its ONLY trace is the gas
  // leg's destination. Without reading that, an approved-then-received token
  // would look like it arrived from nowhere.
  const row = rowFor([
    gasLeg({ tx_hash: TX3, block_number: 900, to_address: SPAM_TOKEN }),
    tokenLeg({
      tx_hash: TX, token_contract: SPAM_TOKEN, token_symbol: 'OBSCURE',
      from_address: STRANGER, to_address: WALLET, value_wei: '5000000000000000000',
    }),
  ], TX);

  assert.equal(row.spam, false);
});

// --- the gates every heuristic runs behind ---------------------------------

test('GATE: a claimed airdrop is never spam -- signing it is the distinguishing signal', () => {
  // The ENS case from the issue. The wallet called the claim contract, so it
  // has a gas leg, so gate 3 stops every heuristic dead -- even though the
  // token is unpriced and had never been seen before.
  //
  // The ladder still calls it `receive` + needs_review rather than `airdrop`:
  // an inbound-only arrival in a transaction you signed is equally a vesting
  // release, a staking claim or a DeFi withdrawal, and rule 7 exists precisely
  // so that judgment stays a human's. Not spam is the property under test.
  const row = only([
    tokenLeg({
      token_contract: SPAM_TOKEN, token_symbol: 'ENS',
      from_address: ROUTER, to_address: WALLET, value_wei: '1000000000000000000000',
    }),
    gasLeg({ to_address: ROUTER }),
  ]);

  assert.equal(row.spam, false);
  assert.equal(row.spam_reason, null);
  assert.equal(row.category, 'receive');
  assert.equal(row.needs_review, true);
});

test('GATE: an outbound transfer the wallet signed is never spam', () => {
  const row = only([
    leg({ to_address: STRANGER, value_wei: '1', usd_at_time: '0.00', usd_basis: 'exact' }),
    gasLeg({ to_address: STRANGER }),
  ]);

  assert.equal(row.spam, false, 'the user signed it, however small it was');
  assert.equal(row.category, 'send');
});

test('GATE: a counterparty the user has already judged is never spam', () => {
  const spamLegs = (from) => [tokenLeg({
    token_contract: SPAM_TOKEN, from_address: from, to_address: WALLET,
    value_wei: '10000000000000000000000',
  })];

  assert.equal(only(spamLegs(STRANGER)).spam, true);

  // 'external' -- reviewed, genuinely a third party -- is inert in
  // classification by design, but it still means the user looked at this
  // address and decided. Quarantining it afterwards would undo their answer.
  const reviewed = only(spamLegs(STRANGER), { labeledAddresses: new Set([STRANGER]) });
  assert.equal(reviewed.spam, false);

  // An exchange withdrawal and a transfer between the user's own addresses are
  // both settled verdicts that assert real money moved.
  assert.equal(only([tokenLeg({
    token_contract: SPAM_TOKEN, from_address: STRANGER, to_address: WALLET,
    value_wei: '1000', counterparty_exchange: 'Kraken',
  })]).spam, false);
  assert.equal(only([tokenLeg({
    token_contract: SPAM_TOKEN, from_address: OWN_OTHER, to_address: WALLET,
    value_wei: '1000', counterparty_is_own: true,
  })]).spam, false);
});

test('GATE: a reverted transaction stays `failed` and is not quarantined', () => {
  const row = only([
    tokenLeg({
      token_contract: SPAM_TOKEN, from_address: STRANGER, to_address: WALLET,
      value_wei: '10000000000000000000000', is_error: true,
    }),
  ]);

  assert.equal(row.category, 'failed');
  assert.equal(row.spam, false, '`failed` already explains it, and it is not in the queue');
});

test('the calldata selector cannot make a transaction spam, or save one from it', () => {
  // method_id/method_name are display-only by standing decision: selector
  // collisions are mined deliberately, so letting either vote would put the
  // attacker in charge of whether their own transfer was hidden.
  const spam = tokenLeg({
    token_contract: SPAM_TOKEN, from_address: STRANGER, to_address: WALLET,
    value_wei: '10000000000000000000000',
  });
  const plain = only([spam]);
  const named = only([{ ...spam, method_id: '0xa9059cbb', method_name: 'transfer(address,uint256)' }]);

  assert.equal(named.spam, plain.spam);
  assert.equal(named.spam_reason, plain.spam_reason);
  assert.equal(named.method_name, 'transfer(address,uint256)', 'still carried, still only for display');
});

test('an already-ignored token is not re-quarantined, and does not refill anything', () => {
  const legs = [tokenLeg({
    token_contract: SPAM_TOKEN, from_address: STRANGER, to_address: WALLET,
    value_wei: '10000000000000000000000',
  })];

  const ignored = only(legs, { ignoredContracts: new Set([SPAM_TOKEN]) });
  assert.equal(ignored.spam, false, 'the ignore list already removed it from every feed');
  assert.equal(ignored.needs_review, false);
  assert.deepEqual(ignored.legs, []);
});

// --- quarantine, not deletion ----------------------------------------------

test('a quarantined row keeps every number on it', () => {
  const row = only([
    tokenLeg({
      token_contract: SPAM_TOKEN, token_symbol: 'SCAM',
      from_address: STRANGER, to_address: WALLET, value_wei: '4200000000000000000',
    }),
  ]);

  assert.equal(row.spam, true);
  // Legs, counterparty, fee and the transaction's own identity all survive. The
  // balance audit (#62) derives from eth_transfers, which nothing here touches
  // at all -- the wei moved on chain whatever we call the transaction.
  assert.equal(row.legs.length, 1);
  assert.equal(row.legs[0].amount, '4.2');
  assert.equal(row.legs[0].direction, 'in');
  assert.equal(row.counterparty_address, STRANGER);
  assert.equal(row.tx_hash, TX);
  assert.equal(row.block_number, 1000);
});

test('the derived needs_review is kept, not cleared, so un-quarantining restores it', async () => {
  db.transfers = [tokenLeg({
    token_contract: SPAM_TOKEN, from_address: STRANGER, to_address: WALLET,
    value_wei: '10000000000000000000000',
  })];
  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);

  // Stored honestly...
  assert.equal(db.activity[0].spam, true);
  assert.equal(db.activity[0].needs_review, true);
  // ...and masked on the way out, which is what empties the queue.
  const listed = await request(app).get('/api/eth/activity?spam=only');
  assert.equal(listed.body.data[0].needs_review, false);
});

// --- reversibility ---------------------------------------------------------

test('un-quarantining restores the row and survives a resync', async () => {
  db.transfers = [tokenLeg({
    token_contract: SPAM_TOKEN, from_address: STRANGER, to_address: WALLET,
    value_wei: '10000000000000000000000',
  })];
  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);

  const hidden = await request(app).get('/api/eth/activity');
  assert.equal(hidden.body.data.length, 0, 'quarantined by default');
  assert.equal(hidden.body.summary.spam_count, 1, 'and it says how many it hid');

  const rescued = await request(app).post('/api/eth/activity/spam')
    .send({ wallet_id: OWNED_WALLET_ID, tx_hash: TX, spam: false });
  assert.equal(rescued.status, 201);

  // A resync, then a relabel -- both re-derive eth_activity wholesale.
  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);
  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);
  assert.equal(db.activity[0].spam, true, 'the derived verdict did re-derive');

  const listed = await request(app).get('/api/eth/activity');
  assert.equal(listed.body.data.length, 1, 'the override outlives the rebuild');
  const [row] = listed.body.data;
  assert.equal(row.spam, false);
  assert.equal(row.derived_spam, true);
  assert.equal(row.spam_reason, SPAM_REASONS.UNSOLICITED_TOKEN, 'why we thought so is still auditable');
  // Restored means restored: the ladder's category AND its review flag.
  assert.equal(row.category, 'receive');
  assert.equal(row.needs_review, true);
});

test('a transaction can be quarantined by hand, and that also survives a resync', async () => {
  db.transfers = [
    leg({ from_address: STRANGER, to_address: WALLET, usd_at_time: '2500.00', usd_basis: 'exact' }),
  ];
  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);
  assert.equal(db.activity[0].spam, false);

  const marked = await request(app).post('/api/eth/activity/spam')
    .send({ wallet_id: OWNED_WALLET_ID, tx_hash: TX, spam: true });
  assert.equal(marked.status, 201);

  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);

  const listed = await request(app).get('/api/eth/activity');
  assert.equal(listed.body.data.length, 0);
  const quarantined = await request(app).get('/api/eth/activity?spam=only');
  assert.equal(quarantined.body.data.length, 1);
  assert.equal(quarantined.body.data[0].spam, true);
  assert.equal(quarantined.body.data[0].derived_spam, false);
  // The heuristics never fired, so there is no reason code to show -- the user
  // is the reason.
  assert.equal(quarantined.body.data[0].spam_reason, null);
});

test('the two verdicts are independent: re-categorizing does not re-hide', async () => {
  db.transfers = [tokenLeg({
    token_contract: SPAM_TOKEN, from_address: STRANGER, to_address: WALLET,
    value_wei: '10000000000000000000000',
  })];
  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);

  await request(app).post('/api/eth/activity/spam')
    .send({ wallet_id: OWNED_WALLET_ID, tx_hash: TX, spam: false });
  await request(app).post('/api/eth/activity/override')
    .send({ wallet_id: OWNED_WALLET_ID, tx_hash: TX, category: 'airdrop', note: 'a real one' });

  const listed = await request(app).get('/api/eth/activity');
  assert.equal(listed.body.data.length, 1, 'still un-quarantined');
  assert.equal(listed.body.data[0].category, 'airdrop');
  assert.equal(listed.body.data[0].spam, false);
});

test('deleting the override drops the spam verdict with it', async () => {
  db.transfers = [tokenLeg({
    token_contract: SPAM_TOKEN, from_address: STRANGER, to_address: WALLET,
    value_wei: '10000000000000000000000',
  })];
  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);
  await request(app).post('/api/eth/activity/spam')
    .send({ wallet_id: OWNED_WALLET_ID, tx_hash: TX, spam: false });

  const removed = await request(app)
    .delete(`/api/eth/activity/override?wallet_id=${OWNED_WALLET_ID}&tx_hash=${TX}`);
  assert.equal(removed.status, 200);

  const listed = await request(app).get('/api/eth/activity');
  assert.equal(listed.body.data.length, 0, 'the derived quarantine is uncovered again');
});

// --- review-queue exclusion ------------------------------------------------

test('a wave of scam airdrops adds nothing to the activity review queue', async () => {
  // Twenty senders, twenty tokens, none of them ever touched, none of them
  // priced, none of them signed for.
  db.transfers = Array.from({ length: 20 }, (unused, i) => tokenLeg({
    tx_hash: `0x${String(i + 1).padStart(64, 'e')}`,
    block_number: 2000 + i,
    token_contract: `0x${String(i + 1).padStart(40, 'd')}`,
    token_symbol: `AIRDROP${i}`,
    from_address: `0x${String(i + 1).padStart(40, 'c')}`,
    to_address: WALLET,
    value_wei: '10000000000000000000000',
  }));
  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);

  const queue = await request(app).get('/api/eth/activity?needs_review=true');
  assert.equal(queue.body.data.length, 0, 'not a single review-queue item');
  assert.equal(queue.body.summary.needs_review_count, 0);
  assert.equal(queue.body.summary.spam_count, 20);

  // And nothing was lost: all twenty are one filter away.
  const quarantined = await request(app).get('/api/eth/activity?spam=only');
  assert.equal(quarantined.body.pagination.total, 20);
});

test('the counterparty triage queue drops quarantined transfers, override-aware', async () => {
  await EthTransfer.unreviewedCounterparties(OWNER_ID);
  const { sql } = queries.find((q) => /unlabeled AS/.test(q.sql));

  // Excluded in the legs CTE, not in `ranked`, so a quarantined transfer counts
  // toward neither the badge nor usd_volume nor sent_count.
  assert.match(sql, /AND NOT EXISTS \( SELECT 1 FROM eth_activity act/);
  assert.match(sql, /LEFT JOIN eth_activity_overrides ovr/);
  // The user's verdict wins, so un-quarantining puts the counterparty back in
  // the queue where it can be labeled.
  assert.match(sql, /AND COALESCE\(ovr\.spam, act\.spam\)/);
  // Joined on the full per-chain key -- block numbers and hashes are per-chain
  // sequences since 039.
  assert.match(sql, /act\.wallet_id = t\.wallet_id AND act\.chain_id = t\.chain_id AND act\.tx_hash = t\.tx_hash/);
  // The pre-existing materiality rules are untouched.
  assert.match(sql, /usd_volume >= \$2::float8 OR g\.sent_count_valued > 0/);
});

// --- the route -------------------------------------------------------------

test('the activity feed hides quarantined rows by default and can show only them', async () => {
  db.transfers = [
    leg({ tx_hash: TX, from_address: STRANGER, to_address: WALLET, usd_at_time: '900.00', usd_basis: 'exact' }),
    tokenLeg({
      tx_hash: TX2, block_number: 1001, token_contract: SPAM_TOKEN,
      from_address: STRANGER, to_address: WALLET, value_wei: '10000000000000000000000',
    }),
  ];
  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);

  const byDefault = await request(app).get('/api/eth/activity');
  assert.deepEqual(byDefault.body.data.map((r) => r.tx_hash), [TX]);

  const onlySpam = await request(app).get('/api/eth/activity?spam=only');
  assert.deepEqual(onlySpam.body.data.map((r) => r.tx_hash), [TX2]);

  const all = await request(app).get('/api/eth/activity?spam=all');
  assert.equal(all.body.data.length, 2);

  const explicit = await request(app).get('/api/eth/activity?spam=exclude');
  assert.equal(explicit.body.data.length, 1);
});

test('an unknown spam filter is a 400, never a silently unfiltered feed', async () => {
  const bogus = await request(app).get('/api/eth/activity?spam=hide');
  assert.equal(bogus.status, 400);
  assert.match(bogus.body.error, /spam must be one of/);

  // 'true' is a plausible guess and must not silently mean something else.
  const truthy = await request(app).get('/api/eth/activity?spam=true');
  assert.equal(truthy.status, 400);

  const empty = await request(app).get('/api/eth/activity?spam=');
  assert.equal(empty.status, 200, 'an empty value means the default');
});

test('the spam endpoint validates the wallet, the hash and the verdict', async () => {
  db.transfers = [tokenLeg({
    token_contract: SPAM_TOKEN, from_address: STRANGER, to_address: WALLET,
    value_wei: '10000000000000000000000',
  })];
  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);

  const noWallet = await request(app).post('/api/eth/activity/spam').send({ tx_hash: TX, spam: false });
  assert.equal(noWallet.status, 404);

  const badHash = await request(app).post('/api/eth/activity/spam')
    .send({ wallet_id: OWNED_WALLET_ID, tx_hash: '0x1234', spam: false });
  assert.equal(badHash.status, 400);

  const badChain = await request(app).post('/api/eth/activity/spam')
    .send({ wallet_id: OWNED_WALLET_ID, tx_hash: TX, chain_id: 0, spam: false });
  assert.equal(badChain.status, 400);

  // A string is refused rather than coerced: 'false' is truthy, and coercing it
  // would quarantine the row the user was rescuing.
  for (const verdict of ['false', 'true', 0, 1, undefined, null]) {
    const coerced = await request(app).post('/api/eth/activity/spam')
      .send({ wallet_id: OWNED_WALLET_ID, tx_hash: TX, spam: verdict });
    assert.equal(coerced.status, 400, `spam: ${JSON.stringify(verdict)} must be refused`);
  }
  assert.equal(db.overrides.size, 0);

  // A well-formed verdict against a hash this wallet never saw would be stored
  // and then invisible forever -- every reader joins activity -> override.
  const orphan = await request(app).post('/api/eth/activity/spam')
    .send({ wallet_id: OWNED_WALLET_ID, tx_hash: TX2, spam: false });
  assert.equal(orphan.status, 404);
  assert.equal(db.overrides.size, 0);
});

test('a second user cannot read or un-quarantine the first user\'s spam', async () => {
  db.transfers = [tokenLeg({
    token_contract: SPAM_TOKEN, from_address: STRANGER, to_address: WALLET,
    value_wei: '10000000000000000000000',
  })];
  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);

  process.env.DEV_AUTH_USER_ID = '2';

  const scoped = await request(app).get(`/api/eth/activity?wallet_id=${OWNED_WALLET_ID}&spam=only`);
  assert.equal(scoped.status, 404);

  const rescue = await request(app).post('/api/eth/activity/spam')
    .send({ wallet_id: OWNED_WALLET_ID, tx_hash: TX, spam: false });
  assert.equal(rescue.status, 404);
  assert.equal(db.overrides.size, 0, 'nothing may be written for a foreign wallet');
});

test('spam writes refuse to run unscoped', async () => {
  const EthActivity = require('../src/models/EthActivity');
  await assert.rejects(
    () => EthActivity.setSpamOverride(undefined, 1, TX, { spam: false }),
    /requires a userId/
  );
  await assert.rejects(
    () => EthActivity.setSpamOverride(OWNER_ID, 1, TX, { spam: 'false' }),
    /boolean spam verdict/
  );
});

// --- determinism -----------------------------------------------------------

test('the quarantine is deterministic, so a nightly rebuild writes the same answer', async () => {
  db.transfers = [
    ...paidPayeeBefore(),
    leg({
      tx_hash: TX, from_address: LOOKALIKE, to_address: WALLET,
      value_wei: '10000000000000', usd_at_time: '0.02', usd_basis: 'exact',
    }),
    tokenLeg({
      tx_hash: TX2, block_number: 1100, token_contract: SPAM_TOKEN,
      from_address: STRANGER, to_address: WALLET, value_wei: '10000000000000000000000',
    }),
  ];

  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);
  const first = db.activity.map((r) => [r.tx_hash, r.spam, r.spam_reason]).sort();
  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);
  const second = db.activity.map((r) => [r.tx_hash, r.spam, r.spam_reason]).sort();

  assert.deepEqual(second, first);
  assert.equal(db.activity.length, 3);
  assert.equal(db.activity.filter((r) => r.spam).length, 2);
});
