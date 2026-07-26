'use strict';

// The transaction-level activity layer: eth_transfers legs -> exactly one
// eth_activity row per (wallet, chain, tx_hash), each either confidently
// categorized or flagged with a reason.
//
// The classification ladder is a pure function, so every rung is exercised
// directly against leg fixtures. The stateful half (rebuild, overrides, route
// scoping) runs against a fake pg Pool that stands in for the two tables and
// their UNIQUE keys, the same way exchangeRoutes.test.js does.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OWN_OTHER = '0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ROUTER = '0xcccccccccccccccccccccccccccccccccccccccc';
const ZERO = '0x0000000000000000000000000000000000000000';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const NFT_CONTRACT = '0xd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1';
const SPAM_TOKEN = '0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1';

const OWNED_WALLET_ID = 1;
const OWNER_ID = 1;
const FOREIGN_WALLET_ID = 99;
const TX = '0x1111111111111111111111111111111111111111111111111111111111111111';
const TX2 = '0x2222222222222222222222222222222222222222222222222222222222222222';

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
  // At-the-time USD (043).
  'usd_value', 'usd_fee', 'usd_basis',
  // The spam quarantine (045).
  'spam', 'spam_reason',
];

const walletRow = (id = OWNED_WALLET_ID) => ({
  id, user_id: OWNER_ID, address: WALLET, label: 'Main', last_block_normal: 0,
});

// Resolves override-over-derived the way the real query's COALESCE does.
function resolvedRows() {
  return db.activity.map((row) => {
    const override = db.overrides.get(key(row.wallet_id, row.chain_id, row.tx_hash)) || null;
    const overrideCategory = override?.category ?? null;
    // COALESCE(o.spam, a.spam): the user's verdict wins, NULL means they have
    // not given one.
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
      // A quarantined row is masked out of the queue, but the stored flag stays
      // honest, so un-quarantining brings it back.
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
  // Narrow on purpose: the triage-queue CTE also names eth_address_labels.
  if (/^SELECT DISTINCT ON \(address\) address, name FROM eth_address_labels/.test(sql)) {
    const wanted = new Set(params[0]);
    return { rows: db.labels.filter((l) => wanted.has(l.address)) };
  }
  // The owner's own label rows, which tell the quarantine which counterparties
  // already carry a verdict of any kind (including the inert 'external').
  if (/^WITH counterparties AS \(.*SELECT l\.address, l\.kind, l\.user_id FROM eth_address_labels/.test(sql)) {
    // The user's own rows, plus builtin rows (user_id NULL) for addresses this
    // wallet has actually transacted with -- the bounded arm that makes a pack
    // 'external' count as a verdict without loading all 5k of them.
    const seen = new Set(db.transfers.flatMap((t) => [t.from_address, t.to_address]));
    return {
      rows: db.labels
        .filter((l) => (l.user_id ?? OWNER_ID) === OWNER_ID || seen.has(l.address))
        .map((l) => ({ address: l.address, kind: l.kind ?? null, user_id: l.user_id ?? OWNER_ID })),
    };
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
      // Stands in for UNIQUE (wallet_id, chain_id, tx_hash) + DO NOTHING.
      const exists = db.activity.some((r) => key(r.wallet_id, r.chain_id, r.tx_hash)
        === key(row.wallet_id, row.chain_id, row.tx_hash));
      if (exists) continue;
      db.activity.push(row);
      inserted++;
    }
    return { rows: [], rowCount: inserted };
  }
  // The override's target check: a correction must point at a visible row.
  if (/^SELECT 1 FROM eth_activity a JOIN eth_wallets w/.test(sql)) {
    const [walletId, chainId, txHash, userId] = params;
    if (userId !== OWNER_ID) return { rows: [] };
    const exists = db.activity.some((r) => key(r.wallet_id, r.chain_id, r.tx_hash)
      === key(walletId, chainId, txHash));
    return { rows: exists ? [{ '?column?': 1 }] : [] };
  }
  // The spam verdict writes ONLY its own column, leaving any category override
  // in place -- and vice versa. Matched first because its column list is a
  // prefix-free subset of the category override's.
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
    // The INSERT ... SELECT FROM eth_wallets WHERE user_id is the ownership
    // gate: a foreign wallet selects nothing, so nothing is written.
    if (walletId !== OWNED_WALLET_ID || userId !== OWNER_ID) return { rows: [] };
    // Naming a category LIFTS the quarantine: the SQL writes spam = FALSE on
    // both the insert and the DO UPDATE. A correction that stayed hidden was
    // stored, acted on by the matcher, and invisible.
    const row = {
      wallet_id: walletId, chain_id: chainId, tx_hash: txHash, category, note,
      spam: false,
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
    // The dynamic WHERE names its parameters, so read the filters back off it
    // rather than guessing at positions.
    const filterOf = (column) => {
      const match = sql.match(new RegExp(`r\\.${column} = \\$(\\d+)`));
      return match ? params[Number(match[1]) - 1] : undefined;
    };
    const walletId = filterOf('wallet_id');
    const category = filterOf('category');
    const needsReview = filterOf('needs_review');
    let rows = resolvedRows();
    // The spam predicate is a bare literal, not a parameter, so it is read off
    // the SQL text the same way -- and its absence means 'all'.
    if (/AND NOT r\.spam/.test(sql)) rows = rows.filter((r) => !r.spam);
    else if (/AND r\.spam(?![_a-z])/.test(sql)) rows = rows.filter((r) => r.spam);
    if (walletId !== undefined) rows = rows.filter((r) => r.wallet_id === walletId);
    if (category !== undefined) rows = rows.filter((r) => r.category === category);
    if (needsReview !== undefined) rows = rows.filter((r) => r.needs_review === needsReview);
    const total = rows.length;
    return { rows: rows.map((r) => ({ ...r, total_count: total })) };
  }
  // summaryForUser: the badge counts, resolved the same way.
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
const EthActivity = require('../src/models/EthActivity');
const EthTransfer = require('../src/models/EthTransfer');
const EthActivityService = require('../src/services/EthActivityService');

const { buildActivityRows, REVIEW_REASONS } = EthActivityService;

// --- leg fixtures ----------------------------------------------------------

let nextId = 1;

function leg(overrides = {}) {
  return {
    id: nextId++,
    wallet_id: OWNED_WALLET_ID,
    tx_hash: TX,
    ordinal: 0,
    transfer_type: 'native',
    block_number: 1000,
    block_time: '2026-01-05T12:00:00.000Z',
    from_address: WALLET,
    to_address: OTHER,
    value_wei: '1000000000000000000',
    token_contract: null,
    token_symbol: null,
    token_decimals: null,
    token_standard: null,
    token_id: null,
    is_error: false,
    counterparty_is_own: false,
    counterparty_exchange: null,
    method_id: null,
    method_name: null,
    ...overrides,
  };
}

// One gas leg exists per tx the wallet SENT -- including a reverted one.
const gasLeg = (overrides = {}) => leg({
  transfer_type: 'gas', value_wei: '2100000000000000', to_address: OTHER, ...overrides,
});

const tokenLeg = (overrides = {}) => leg({
  transfer_type: 'token', token_standard: 'erc20', token_decimals: 18, ...overrides,
});

const nftLeg = (overrides = {}) => leg({
  transfer_type: 'nft',
  token_standard: 'erc721',
  token_contract: NFT_CONTRACT,
  token_symbol: 'PUNK',
  token_decimals: 0,
  token_id: '4242',
  // 033: value_wei on an NFT row is a COUNT OF UNITS, never wei.
  value_wei: '1',
  ...overrides,
});

const only = (legs, options) => {
  const rows = buildActivityRows(WALLET, legs, options);
  assert.equal(rows.length, 1, 'expected exactly one activity row');
  return rows[0];
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

// --- the classification ladder ---------------------------------------------

test('rule 1: every value leg between own addresses is a self_transfer', () => {
  const row = only([
    leg({ to_address: OWN_OTHER, counterparty_is_own: true }),
    gasLeg({ to_address: OWN_OTHER }),
  ]);

  assert.equal(row.category, 'self_transfer');
  assert.equal(row.needs_review, false);
  assert.equal(row.confidence, 'high');
  assert.deepEqual(row.legs.map((l) => [l.asset, l.direction, l.amount]), [['ETH', 'out', '1']]);
  assert.equal(row.fee_wei, '2100000000000000');
});

test('rule 2: value out to a labeled exchange is an exchange_deposit', () => {
  const row = only([
    leg({ counterparty_exchange: 'Coinbase' }),
    gasLeg(),
  ]);

  assert.equal(row.category, 'exchange_deposit');
  assert.equal(row.needs_review, false);
  assert.equal(row.counterparty_address, OTHER);
  assert.equal(row.counterparty_name, 'Coinbase');
});

test('rule 2: value in from a labeled exchange is an exchange_withdrawal', () => {
  const row = only([
    leg({ from_address: OTHER, to_address: WALLET, counterparty_exchange: 'Kraken' }),
  ]);

  assert.equal(row.category, 'exchange_withdrawal');
  assert.equal(row.legs[0].direction, 'in');
  assert.equal(row.counterparty_name, 'Kraken');
});

test('rule 1 beats rule 2: a tracked wallet that is also labeled stays a self_transfer', () => {
  const row = only([
    leg({ to_address: OWN_OTHER, counterparty_is_own: true, counterparty_exchange: 'Coinbase' }),
  ]);

  assert.equal(row.category, 'self_transfer');
});

test('rule 3: an NFT arriving from the zero address is an nft_mint, counted in UNITS', () => {
  const row = only([
    nftLeg({ from_address: ZERO, to_address: WALLET }),
    // A paid mint still moved ETH out; rule 3 sits above nft_purchase.
    leg({ value_wei: '80000000000000000' }),
    gasLeg(),
  ]);

  assert.equal(row.category, 'nft_mint');
  const nft = row.legs.find((l) => l.token_standard === 'erc721');
  // The whole 033 trap: value_wei is a unit count, so this must be "1" and
  // never 0.000000000000000001.
  assert.equal(nft.amount, '1');
  assert.equal(nft.amount_raw, '1');
  assert.equal(nft.token_id, '4242');
  assert.equal(nft.direction, 'in');
});

test('rule 3: an NFT sent to the zero address is an nft_burn', () => {
  const row = only([
    nftLeg({ from_address: WALLET, to_address: ZERO }),
    gasLeg({ to_address: NFT_CONTRACT }),
  ]);

  assert.equal(row.category, 'nft_burn');
  assert.equal(row.needs_review, false);
  assert.equal(row.legs[0].direction, 'out');
});

test('rule 3: an ERC-1155 batch leg carries its tokenValue as whole units', () => {
  const row = only([
    nftLeg({
      transfer_type: 'nft1155', token_standard: 'erc1155', from_address: ZERO,
      to_address: WALLET, value_wei: '3',
    }),
  ]);

  assert.equal(row.category, 'nft_mint');
  assert.equal(row.legs[0].amount, '3');
});

test('rule 4: a zero-value call is a contract_interaction, and the selector never votes', () => {
  // An ERC-20 approve emits no Transfer log, so it has no value leg at all --
  // only the gas leg, which is where 034 parks the calldata for a zero-value
  // call. `approval` is deliberately NOT reachable here: the only thing that
  // separates it from any other zero-value call is method_id/method_name, and
  // those are display-only. Overrides name it instead.
  const row = only([
    gasLeg({ to_address: USDC, method_id: '0x095ea7b3', method_name: 'approve(address,uint256)' }),
  ]);

  assert.equal(row.category, 'contract_interaction');
  assert.equal(row.needs_review, false, 'a zero-movement call is explained, not unexplained');
  assert.deepEqual(row.legs, []);
  // Copied for display, and only for display.
  assert.equal(row.method_id, '0x095ea7b3');
  assert.equal(row.method_name, 'approve(address,uint256)');
  assert.equal(row.counterparty_address, USDC);
});

test('a method name cannot change a verdict: a named send is still send + needs_review', () => {
  const named = only([
    leg({ method_id: '0xa9059cbb', method_name: 'transfer(address,uint256)' }),
    gasLeg(),
  ]);
  const unnamed = only([leg(), gasLeg()]);

  assert.equal(named.category, unnamed.category);
  assert.equal(named.category, 'send');
  assert.equal(named.needs_review, true);
});

test('rule 5: one fungible out and a different fungible in is a swap', () => {
  const row = only([
    tokenLeg({
      token_contract: USDC, token_symbol: 'USDC', token_decimals: 6,
      from_address: WALLET, to_address: ROUTER, value_wei: '3000000000',
    }),
    tokenLeg({
      token_contract: WETH, token_symbol: 'WETH',
      from_address: ROUTER, to_address: WALLET, value_wei: '1000000000000000000',
    }),
    gasLeg({ to_address: ROUTER }),
  ]);

  assert.equal(row.category, 'swap');
  assert.equal(row.needs_review, false);
  assert.deepEqual(
    row.legs.map((l) => [l.asset, l.direction, l.amount]),
    [['USDC', 'out', '3000'], ['WETH', 'in', '1']]
  );
  assert.equal(row.fee_wei, '2100000000000000');
});

test('rule 6: an NFT in against fungible out is an nft_purchase', () => {
  const row = only([
    nftLeg({ from_address: OTHER, to_address: WALLET }),
    leg({ from_address: WALLET, to_address: OTHER, value_wei: '2500000000000000000' }),
    gasLeg({ to_address: ROUTER }),
  ]);

  assert.equal(row.category, 'nft_purchase');
  assert.equal(row.needs_review, false);
});

test('rule 6: an NFT out against fungible in is an nft_sale', () => {
  const row = only([
    nftLeg({ from_address: WALLET, to_address: OTHER }),
    leg({ from_address: OTHER, to_address: WALLET, value_wei: '2500000000000000000' }),
    gasLeg({ to_address: ROUTER }),
  ]);

  assert.equal(row.category, 'nft_sale');
});

test('rule 7: a one-way send to an unlabeled counterparty is flagged, never spending', () => {
  const row = only([leg(), gasLeg()]);

  assert.equal(row.category, 'send');
  assert.equal(row.needs_review, true);
  assert.equal(row.confidence, 'low');
  assert.equal(row.review_reason, REVIEW_REASONS.unlabeled_send);
  assert.notEqual(row.category, 'spend');
});

test('rule 7: a one-way receive from an unlabeled counterparty is flagged', () => {
  const row = only([leg({ from_address: OTHER, to_address: WALLET })]);

  assert.equal(row.category, 'receive');
  assert.equal(row.needs_review, true);
  assert.equal(row.review_reason, REVIEW_REASONS.unlabeled_receive);
  assert.equal(row.fee_wei, '0', 'an inbound transfer costs the wallet no gas');
});

test('the failed gate: a reverted tx is failed, moved nothing, and still burned gas', () => {
  const row = only([
    // A reverted send to an exchange would read as a completed deposit if the
    // is_error check sat at the bottom of the ladder instead of the top.
    leg({ is_error: true, counterparty_exchange: 'Coinbase' }),
    gasLeg(),
  ]);

  assert.equal(row.category, 'failed');
  assert.equal(row.needs_review, false);
  assert.deepEqual(row.legs, [], 'a reverted transfer moved nothing');
  assert.equal(row.fee_wei, '2100000000000000', 'the fee is real either way');
});

test('the failed gate: a reverted ZERO-VALUE call is failed, and still burned gas', () => {
  // The most common revert on chain -- a failed approve, or a swap that reverts
  // before any Transfer log. It emits no native leg, so the ONLY row is the gas
  // leg, which is written is_error = false on purpose (the fee did not fail).
  // tx_is_error is what carries the transaction's own status there.
  const row = only([gasLeg({ to_address: ROUTER, tx_is_error: true })]);

  assert.equal(row.category, 'failed');
  assert.equal(row.needs_review, false);
  assert.deepEqual(row.legs, []);
  assert.equal(row.fee_wei, '2100000000000000', 'gas is burned by a revert too');
});

test('a pre-038 row (NULL tx_is_error) still classifies, as contract_interaction', () => {
  // tx_is_error is FORWARD-ONLY, like 034's method capture: rows ingested
  // before the column existed read as "not known to have failed" rather than
  // crashing or being retroactively invented. Remove + re-add the wallet to
  // re-ingest from block 0 and heal the history.
  const legacy = only([gasLeg({ to_address: ROUTER, tx_is_error: null })]);
  assert.equal(legacy.category, 'contract_interaction');
  assert.equal(legacy.needs_review, false);

  const missing = { ...gasLeg({ to_address: ROUTER }) };
  delete missing.tx_is_error;
  assert.equal(only([missing]).category, 'contract_interaction');
});

test('a successful zero-value call is untouched by the revert flag', () => {
  const row = only([gasLeg({ to_address: ROUTER, tx_is_error: false })]);
  assert.equal(row.category, 'contract_interaction');
});

test('netting takes the first NON-NULL token_decimals across a contract\'s legs', () => {
  // The feed omitted tokenDecimal on the first leg; legDecimals falls back to
  // 18, which would scale 6-decimal USDC by a trillion.
  const row = only([
    tokenLeg({
      token_contract: USDC, token_symbol: 'USDC', token_decimals: null,
      from_address: ROUTER, to_address: WALLET, value_wei: '1000000',
    }),
    tokenLeg({
      token_contract: USDC, token_symbol: 'USDC', token_decimals: 6,
      from_address: ROUTER, to_address: WALLET, value_wei: '2000000',
    }),
  ]);

  assert.equal(row.legs.length, 1);
  assert.equal(row.legs[0].amount, '3');
  assert.equal(row.legs[0].amount_raw, '3000000');
});

test('an ignored spam token drives no classification and refills no queue', () => {
  const legs = [tokenLeg({
    token_contract: SPAM_TOKEN, token_symbol: 'SCAM',
    from_address: OTHER, to_address: WALLET, value_wei: '10000000000000000000000',
  })];

  const flagged = only(legs);
  assert.equal(flagged.category, 'receive');
  assert.equal(flagged.needs_review, true);

  const ignored = only(legs, { ignoredContracts: new Set([SPAM_TOKEN]) });
  assert.equal(ignored.category, 'contract_interaction');
  assert.equal(ignored.needs_review, false, 'the user already declared this noise');
  assert.deepEqual(ignored.legs, []);
});

test('legs net per asset, so a partial ETH refund is one net outflow', () => {
  const row = only([
    leg({ to_address: ROUTER, value_wei: '3000000000000000000' }),
    leg({ transfer_type: 'internal', from_address: ROUTER, to_address: WALLET, value_wei: '1000000000000000000' }),
    gasLeg({ to_address: ROUTER }),
  ]);

  assert.equal(row.legs.length, 1);
  assert.equal(row.legs[0].direction, 'out');
  assert.equal(row.legs[0].amount, '2');
  assert.equal(row.category, 'send');
});

// --- the one-row-per-transaction invariant ---------------------------------

test('one activity row per tx_hash per wallet, however many legs the tx had', () => {
  const rows = buildActivityRows(WALLET, [
    tokenLeg({ token_contract: USDC, token_symbol: 'USDC', token_decimals: 6, to_address: ROUTER, value_wei: '3000000000' }),
    tokenLeg({ token_contract: WETH, token_symbol: 'WETH', from_address: ROUTER, to_address: WALLET, value_wei: '1000000000000000000' }),
    gasLeg({ to_address: ROUTER }),
    leg({ tx_hash: TX2, block_number: 1001 }),
    gasLeg({ tx_hash: TX2, block_number: 1001 }),
  ]);

  assert.equal(rows.length, 2);
  assert.deepEqual([...new Set(rows.map((r) => r.tx_hash))].sort(), [TX, TX2].sort());
  assert.deepEqual(rows.map((r) => r.chain_id), [1, 1]);
});

test('the same tx_hash on two chains is two activity rows, not one fused row', () => {
  // A cross-chain replay (same account, same nonce, same calldata) genuinely
  // shares a hash across chains; block numbers are unrelated sequences.
  const rows = buildActivityRows(WALLET, [
    leg({ tx_hash: TX, chain_id: 1, block_number: 1000 }),
    gasLeg({ tx_hash: TX, chain_id: 1, block_number: 1000 }),
    leg({ tx_hash: TX, chain_id: 42161, block_number: 250000000 }),
    gasLeg({ tx_hash: TX, chain_id: 42161, block_number: 250000000 }),
  ]);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.chain_id).sort((a, b) => a - b), [1, 42161]);
  for (const row of rows) assert.equal(row.tx_hash, TX);
  const arb = rows.find((r) => r.chain_id === 42161);
  assert.equal(arb.block_number, 250000000, 'each row keeps its own chain\'s block number');

  // Legacy rows with no chain_id column (pre-039 fake-pool shapes) default to 1.
  const legacy = buildActivityRows(WALLET, [leg({ tx_hash: TX2, chain_id: undefined })]);
  assert.equal(legacy[0].chain_id, 1);
});

test('rebuildForWallet writes one row per transaction and is idempotent', async () => {
  db.transfers = [
    leg({ tx_hash: TX }), gasLeg({ tx_hash: TX }),
    leg({ tx_hash: TX2, block_number: 1001, from_address: OTHER, to_address: WALLET }),
  ];

  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);
  assert.equal(db.activity.length, 2);

  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);
  assert.equal(db.activity.length, 2, 'a second rebuild must not duplicate rows');
});

test('counterparty names come from the owner\'s labels, for display', async () => {
  db.transfers = [leg({ tx_hash: TX })];
  db.labels = [{ address: OTHER, name: 'Vitalik' }];

  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);

  assert.equal(db.activity[0].counterparty_name, 'Vitalik');
  // Naming a counterparty 'external' does not settle whether the transfer was
  // spending, so the flag stays up.
  assert.equal(db.activity[0].needs_review, true);
});

// --- overrides -------------------------------------------------------------

test('an override survives a rebuild and a reclassification', async () => {
  db.transfers = [leg({ tx_hash: TX }), gasLeg({ tx_hash: TX })];
  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);
  assert.equal(db.activity[0].category, 'send');

  const saved = await request(app)
    .post('/api/eth/activity/override')
    .send({ wallet_id: OWNED_WALLET_ID, tx_hash: TX, category: 'spend', note: 'bought a coffee' });
  assert.equal(saved.status, 201);

  // A resync, then a relabel that re-derives the same wallet.
  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);
  db.transfers[0].counterparty_exchange = 'Coinbase';
  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);

  assert.equal(db.overrides.size, 1, 'the rebuild must not touch the overrides table');
  assert.equal(db.activity[0].category, 'exchange_deposit', 'the derived verdict did re-derive');

  const listed = await request(app).get('/api/eth/activity');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data[0].category, 'spend', 'the override wins');
  assert.equal(listed.body.data[0].derived_category, 'exchange_deposit');
  assert.equal(listed.body.data[0].is_overridden, true);
  assert.equal(listed.body.data[0].override_note, 'bought a coffee');
});

test('an override clears needs_review, so the queue can drain', async () => {
  db.transfers = [leg({ tx_hash: TX })];
  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);

  const before = await request(app).get('/api/eth/activity?needs_review=true');
  assert.equal(before.body.data.length, 1);

  await request(app).post('/api/eth/activity/override')
    .send({ wallet_id: OWNED_WALLET_ID, tx_hash: TX, category: 'spend' });

  const after = await request(app).get('/api/eth/activity?needs_review=true');
  assert.equal(after.body.data.length, 0);
  assert.equal(after.body.pagination.total, 0);
});

test('an override can be undone, which uncovers the derived verdict again', async () => {
  db.transfers = [leg({ tx_hash: TX })];
  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);
  await request(app).post('/api/eth/activity/override')
    .send({ wallet_id: OWNED_WALLET_ID, tx_hash: TX, category: 'spend' });

  const removed = await request(app)
    .delete(`/api/eth/activity/override?wallet_id=${OWNED_WALLET_ID}&tx_hash=${TX}`);
  assert.equal(removed.status, 200);

  const listed = await request(app).get('/api/eth/activity');
  assert.equal(listed.body.data[0].category, 'send');
  assert.equal(listed.body.data[0].is_overridden, false);
  assert.equal(listed.body.data[0].needs_review, true, 'the derived flag comes back too');

  const again = await request(app)
    .delete(`/api/eth/activity/override?wallet_id=${OWNED_WALLET_ID}&tx_hash=${TX}`);
  assert.equal(again.status, 404);
});

// --- route scoping and validation ------------------------------------------

test('GET /api/eth/activity with a foreign wallet id is a 404, not a widened feed', async () => {
  const response = await request(app).get(`/api/eth/activity?wallet_id=${FOREIGN_WALLET_ID}`);
  assert.equal(response.status, 404);

  const unparseable = await request(app).get('/api/eth/activity?wallet_id=abc');
  assert.equal(unparseable.status, 404);
});

test('a second user cannot read or override the first user\'s activity', async () => {
  db.transfers = [leg({ tx_hash: TX })];
  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);

  process.env.DEV_AUTH_USER_ID = '2';

  const scoped = await request(app).get(`/api/eth/activity?wallet_id=${OWNED_WALLET_ID}`);
  assert.equal(scoped.status, 404);

  const override = await request(app).post('/api/eth/activity/override')
    .send({ wallet_id: OWNED_WALLET_ID, tx_hash: TX, category: 'spend' });
  assert.equal(override.status, 404);
  assert.equal(db.overrides.size, 0, 'nothing may be written for a foreign wallet');
});

test('an unknown category is a 400, never a silently unfiltered feed', async () => {
  const response = await request(app).get('/api/eth/activity?category=nft');
  assert.equal(response.status, 400);
  assert.match(response.body.error, /Unknown category/);
});

test('a known category filters', async () => {
  db.transfers = [
    leg({ tx_hash: TX }),
    leg({ tx_hash: TX2, block_number: 1001, to_address: OWN_OTHER, counterparty_is_own: true }),
  ];
  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);

  const response = await request(app).get('/api/eth/activity?category=self_transfer');
  assert.equal(response.status, 200);
  assert.equal(response.body.data.length, 1);
  assert.equal(response.body.data[0].tx_hash, TX2);
});

test('the override endpoint validates the wallet, the hash and the category', async () => {
  db.transfers = [leg({ tx_hash: TX })];
  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);

  const noWallet = await request(app).post('/api/eth/activity/override')
    .send({ tx_hash: TX, category: 'spend' });
  assert.equal(noWallet.status, 404);

  const badHash = await request(app).post('/api/eth/activity/override')
    .send({ wallet_id: OWNED_WALLET_ID, tx_hash: '0x1234', category: 'spend' });
  assert.equal(badHash.status, 400);
  assert.match(badHash.body.error, /tx_hash/);

  const badCategory = await request(app).post('/api/eth/activity/override')
    .send({ wallet_id: OWNED_WALLET_ID, tx_hash: TX, category: 'groceries' });
  assert.equal(badCategory.status, 400);
  assert.match(badCategory.body.error, /category must be one of/);

  // 'approval' is unreachable from the ladder but must stay overridable.
  const approval = await request(app).post('/api/eth/activity/override')
    .send({ wallet_id: OWNED_WALLET_ID, tx_hash: TX, category: 'approval' });
  assert.equal(approval.status, 201);
  assert.equal(approval.body.override.category, 'approval');
});

test('an unknown needs_review value is a 400, like an unknown category', async () => {
  const bogus = await request(app).get('/api/eth/activity?needs_review=yes');
  assert.equal(bogus.status, 400);
  assert.match(bogus.body.error, /needs_review/);

  // The two accepted spellings still work, and an empty value means "no filter".
  for (const value of ['true', 'false', '']) {
    const ok = await request(app).get(`/api/eth/activity?needs_review=${value}`);
    assert.equal(ok.status, 200, `needs_review=${value} must be accepted`);
  }
});

test('an override for a transaction with no activity row is a 404, not an invisible write', async () => {
  db.transfers = [leg({ tx_hash: TX })];
  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);

  // Well-formed, owned wallet, but a hash this wallet never saw. Every reader
  // joins activity -> override, so writing it would store a correction that can
  // never be rendered or undone from the UI.
  const orphan = await request(app).post('/api/eth/activity/override')
    .send({ wallet_id: OWNED_WALLET_ID, tx_hash: TX2, category: 'spend' });
  assert.equal(orphan.status, 404);
  assert.equal(db.overrides.size, 0, 'nothing may be written against a hash with no activity');

  const real = await request(app).post('/api/eth/activity/override')
    .send({ wallet_id: OWNED_WALLET_ID, tx_hash: TX, category: 'spend' });
  assert.equal(real.status, 201);
});

test('the activity feed orders by a unique key, so paging cannot repeat or drop a row', async () => {
  db.transfers = [leg({ tx_hash: TX })];
  await EthActivityService.rebuildForWallet(OWNED_WALLET_ID);
  queries.length = 0;

  await request(app).get('/api/eth/activity');
  const { sql } = queries.find((q) => /^WITH resolved AS/.test(q.sql));
  // block_time leads: block_number became a per-chain sequence in 039, so
  // time is the only order that interleaves a multi-chain feed. Two of the
  // user's wallets both see an A->B self-send: same time, same hash. Without
  // the id the ORDER BY is not total and LIMIT/OFFSET can serve one of them
  // twice and the other never.
  assert.match(sql, /ORDER BY r\.block_time DESC, r\.block_number DESC, r\.tx_hash DESC, r\.id DESC/);
});

test('activity reads refuse to run unscoped', async () => {
  await assert.rejects(() => EthActivity.findForUser(undefined), /requires a userId/);
  await assert.rejects(() => EthActivity.findForUser(null, { walletId: 1 }), /requires a userId/);
  await assert.rejects(() => EthActivity.summaryForUser(undefined), /requires a userId/);
  await assert.rejects(
    () => EthActivity.upsertOverride(undefined, 1, TX, { category: 'spend' }),
    /requires a userId/
  );
  await assert.rejects(() => EthActivity.deleteOverride(null, 1, TX), /requires a userId/);
  await assert.rejects(
    () => EthActivity.overrideTargetExists(undefined, 1, TX),
    /requires a userId/
  );
});

// --- the NFT materiality decision ------------------------------------------

test('outbound NFT legs no longer make a counterparty permanently material', async () => {
  await EthTransfer.unreviewedCounterparties(OWNER_ID);
  const { sql } = queries.find((q) => /unlabeled AS/.test(q.sql));

  // The OR arm rescues an outbound transfer whose dollar value merely failed to
  // resolve. An NFT leg gets no mirror row, so its value never resolves at all
  // -- it would pass forever and pin the badge above zero.
  assert.match(sql, /usd_volume >= \$2::float8 OR g\.sent_count_valued > 0/);
  assert.match(sql, /FILTER \(WHERE outgoing AND transfer_type NOT IN \('nft', 'nft1155'\)\)/);
  // The true outbound count is still reported: the queue displays it.
  assert.match(sql, /FILTER \(WHERE outgoing\)\)::int AS sent_count/);
  // The documented ordering trap stays intact.
  assert.match(sql, /ORDER BY r\.material DESC, r\.usd_volume DESC/);
});
