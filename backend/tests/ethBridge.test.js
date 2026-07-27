'use strict';

// Bridge detection (#59): the ladder rung that reads a bridge-labeled
// counterparty, and the cross-chain pass that pairs the two halves of one
// movement into a single self-transfer.
//
// Two halves, tested two ways. The pairing policy is a pure function, so every
// bound (fee tolerance, time window, cross-chain requirement, direction) is
// exercised directly. The stateful half runs against a fake pg Pool that models
// label shadowing, the activity table and the links table -- including the
// UNIQUE constraints, because "one leg is claimed once" is the whole integrity
// story.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OWN_OTHER = '0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
// Stands in for a canonical bridge; the real seed is asserted further down.
const BRIDGE = '0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f';
const BRIDGE_L2 = '0x5288c571fd7ad117bea99bf60fe0846c4e84f933';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

const OWNED_WALLET_ID = 1;
const OWNER_ID = 1;
const TX = '0x1111111111111111111111111111111111111111111111111111111111111111';
const TX2 = '0x2222222222222222222222222222222222222222222222222222222222222222';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// --- the fake database -----------------------------------------------------

const db = {
  transfers: [],
  ignoredTokens: [],
  labels: [],
  activity: [],
  links: [],
  overrides: [],
};
let nextActivityId = 1;

const ACTIVITY_COLUMNS = [
  'wallet_id', 'chain_id', 'tx_hash', 'block_number', 'block_time', 'category',
  'counterparty_address', 'counterparty_name', 'method_id', 'method_name',
  'legs', 'fee_wei', 'needs_review', 'review_reason', 'confidence',
];
const LINK_COLUMNS = ['out_activity_id', 'in_activity_id', 'asset', 'out_amount', 'in_amount', 'fee_amount'];

const walletRow = (id = OWNED_WALLET_ID) => ({
  id, user_id: OWNER_ID, address: WALLET, label: 'Main', last_block_normal: 0,
});

// Mirrors the SQL's DISTINCT ON (address) ... ORDER BY user_id NULLS LAST: one
// winning row per address, a user row shadowing any builtin.
function resolvedLabels(userId) {
  const byAddress = new Map();
  for (const label of db.labels) {
    if (label.user_id !== userId && label.user_id != null) continue;
    const current = byAddress.get(label.address);
    if (!current || (current.user_id == null && label.user_id != null)) {
      byAddress.set(label.address, label);
    }
  }
  return [...byAddress.values()];
}

const isLinked = (id) => db.links.some((l) => l.out_activity_id === id || l.in_activity_id === id);

// COALESCE(o.category, a.category), joined on the full (wallet, chain, tx_hash)
// key -- the same resolution every other reader of eth_activity performs.
function resolvedCategory(row) {
  const override = db.overrides.find((o) => o.wallet_id === row.wallet_id
    && o.chain_id === row.chain_id && o.tx_hash === row.tx_hash);
  return override ? override.category : row.category;
}
const isBridgeLeg = (row) => ['bridge_out', 'bridge_in'].includes(resolvedCategory(row));

function fakeQuery(text, params = []) {
  const sql = String(text).replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

  if (/^SELECT \* FROM eth_wallets WHERE id = \$1/.test(sql)) {
    return { rows: params[0] === OWNED_WALLET_ID ? [walletRow()] : [] };
  }
  if (/^SELECT \* FROM eth_transfers WHERE wallet_id/.test(sql)) {
    return { rows: db.transfers.filter((t) => t.wallet_id === params[0]) };
  }
  if (/^SELECT contract_address FROM eth_ignored_tokens/.test(sql)) {
    return { rows: db.ignoredTokens.map((contract_address) => ({ contract_address })) };
  }
  // The bridge set: kind filtered OUTSIDE the DISTINCT ON, so shadowing wins.
  if (/^SELECT address FROM \( SELECT DISTINCT ON \(address\) address, kind/.test(sql)) {
    return { rows: resolvedLabels(params[0]).filter((l) => l.kind === 'bridge').map((l) => ({ address: l.address })) };
  }
  if (/^SELECT DISTINCT ON \(address\) address, name FROM eth_address_labels/.test(sql)) {
    const wanted = new Set(params[0]);
    return { rows: resolvedLabels(params[1]).filter((l) => wanted.has(l.address)) };
  }
  if (/^DELETE FROM eth_activity WHERE wallet_id/.test(sql)) {
    const doomed = new Set(db.activity.filter((r) => r.wallet_id === params[0]).map((r) => r.id));
    db.activity = db.activity.filter((row) => row.wallet_id !== params[0]);
    // ON DELETE CASCADE on both endpoints.
    db.links = db.links.filter((l) => !doomed.has(l.out_activity_id) && !doomed.has(l.in_activity_id));
    return { rows: [], rowCount: 0 };
  }
  if (/^INSERT INTO eth_activity \(/.test(sql)) {
    let inserted = 0;
    for (let i = 0; i < params.length; i += ACTIVITY_COLUMNS.length) {
      const row = { id: nextActivityId++ };
      ACTIVITY_COLUMNS.forEach((col, j) => { row[col] = params[i + j]; });
      row.legs = JSON.parse(row.legs);
      db.activity.push(row);
      inserted++;
    }
    return { rows: [], rowCount: inserted };
  }
  if (/^SELECT a\.id, a\.chain_id, a\.block_time, COALESCE\(o\.category, a\.category\) AS category, a\.legs FROM eth_activity a/.test(sql)) {
    assert.match(sql, /LEFT JOIN eth_activity_overrides o ON o\.wallet_id = a\.wallet_id AND o\.chain_id = a\.chain_id AND o\.tx_hash = a\.tx_hash/);
    const rows = db.activity
      .filter(isBridgeLeg)
      .map((row) => ({ ...row, category: resolvedCategory(row) }))
      .sort((a, b) => (new Date(a.block_time) - new Date(b.block_time))
        || (a.chain_id - b.chain_id) || (a.id - b.id));
    return { rows };
  }
  if (/^DELETE FROM eth_activity_links l USING eth_activity a, eth_wallets w/.test(sql)) {
    const removed = db.links.length;
    db.links = [];
    return { rows: [], rowCount: removed };
  }
  if (/^INSERT INTO eth_activity_links/.test(sql)) {
    let inserted = 0;
    for (let i = 0; i < params.length; i += LINK_COLUMNS.length) {
      const row = {};
      LINK_COLUMNS.forEach((col, j) => { row[col] = params[i + j]; });
      // The two UNIQUE constraints: a leg can be claimed once from each side.
      if (db.links.some((l) => l.out_activity_id === row.out_activity_id)) {
        throw new Error('duplicate key value violates unique constraint "eth_activity_links_out_unique"');
      }
      if (db.links.some((l) => l.in_activity_id === row.in_activity_id)) {
        throw new Error('duplicate key value violates unique constraint "eth_activity_links_in_unique"');
      }
      db.links.push(row);
      inserted++;
    }
    return { rows: [], rowCount: inserted };
  }
  if (/^UPDATE eth_activity a SET needs_review = FALSE/.test(sql)) {
    assert.match(sql, /COALESCE\( \(SELECT o\.category FROM eth_activity_overrides o/);
    let n = 0;
    for (const row of db.activity) {
      if (!isBridgeLeg(row) || !isLinked(row.id)) continue;
      Object.assign(row, { needs_review: false, review_reason: null, confidence: 'high' });
      n++;
    }
    return { rows: [], rowCount: n };
  }
  if (/^UPDATE eth_activity a SET needs_review = TRUE/.test(sql)) {
    assert.match(sql, /COALESCE\( \(SELECT o\.category FROM eth_activity_overrides o/);
    let n = 0;
    for (const row of db.activity) {
      if (!isBridgeLeg(row) || isLinked(row.id)) continue;
      Object.assign(row, { needs_review: true, review_reason: params[1], confidence: 'medium' });
      n++;
    }
    return { rows: [], rowCount: n };
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

const EthActivityService = require('../src/services/EthActivityService');
const EthActivity = require('../src/models/EthActivity');
const EthTransfer = require('../src/models/EthTransfer');

const {
  buildActivityRows, REVIEW_REASONS, pairBridgeLegs, bridgeAsset,
  BRIDGE_DEPOSIT_WINDOW_MS, BRIDGE_WITHDRAWAL_WINDOW_MS,
} = EthActivityService;

// --- leg fixtures ----------------------------------------------------------

let nextLegId = 1;

function leg(overrides = {}) {
  return {
    id: nextLegId++,
    wallet_id: OWNED_WALLET_ID,
    tx_hash: TX,
    chain_id: 1,
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

const gasLeg = (overrides = {}) => leg({
  transfer_type: 'gas', value_wei: '2100000000000000', to_address: OTHER, ...overrides,
});

const only = (legs, options) => {
  const rows = buildActivityRows(WALLET, legs, options);
  assert.equal(rows.length, 1, 'expected exactly one activity row');
  return rows[0];
};

const bridging = (extra = {}) => ({ bridgeAddresses: new Set([BRIDGE, BRIDGE_L2]), ...extra });

beforeEach(() => {
  db.transfers = [];
  db.ignoredTokens = [];
  db.labels = [];
  db.activity = [];
  db.links = [];
  db.overrides = [];
  nextActivityId = 1;
});

// --- the ladder rung -------------------------------------------------------

test('rule 3: ETH out to a bridge-labeled counterparty is a flagged bridge_out', () => {
  const row = only([
    leg({ to_address: BRIDGE }),
    gasLeg({ to_address: BRIDGE }),
  ], bridging());

  assert.equal(row.category, 'bridge_out');
  assert.equal(row.counterparty_address, BRIDGE);
  // Flagged until the far side is found. The alternative -- asserting a
  // completed transfer the moment the money leaves -- would claim funds landed
  // on a chain we may not even sync.
  assert.equal(row.needs_review, true);
  assert.equal(row.review_reason, REVIEW_REASONS.unmatched_bridge);
  assert.equal(row.confidence, 'medium');
  assert.deepEqual(row.legs.map((l) => [l.asset, l.direction, l.amount]), [['ETH', 'out', '1']]);
});

test('rule 3: value in from a bridge-labeled counterparty is a flagged bridge_in', () => {
  const row = only([
    leg({ from_address: BRIDGE_L2, to_address: WALLET, chain_id: 42161 }),
  ], bridging());

  assert.equal(row.category, 'bridge_in');
  assert.equal(row.legs[0].direction, 'in');
  assert.equal(row.needs_review, true);
});

test('rule 3 beats rule 8: without the label the same transfer is a possible SPEND', () => {
  // The whole point of the issue. One bridge deposit, classified twice.
  const legs = [leg({ to_address: BRIDGE }), gasLeg({ to_address: BRIDGE })];

  assert.equal(only(legs, bridging()).category, 'bridge_out');
  const unlabeled = only(legs, { bridgeAddresses: new Set() });
  assert.equal(unlabeled.category, 'send');
  assert.equal(unlabeled.review_reason, REVIEW_REASONS.unlabeled_send);
});

test('rule 1 beats rule 3: own wins over bridge', () => {
  // 'own' beats every other verdict, exactly as it beats 'exchange'. Belt and
  // braces: the resolved label set cannot contain an address whose winning kind
  // is 'own', and the rung tests counterparty_is_own on top of that.
  const row = only([
    leg({ to_address: OWN_OTHER, counterparty_is_own: true }),
  ], { bridgeAddresses: new Set([OWN_OTHER]) });

  assert.equal(row.category, 'self_transfer');
});

test('rule 2 beats rule 3: a labeled exchange keeps the rung it has always had', () => {
  const row = only([
    leg({ to_address: BRIDGE, counterparty_exchange: 'Coinbase' }),
  ], bridging());

  assert.equal(row.category, 'exchange_deposit',
    'inserting the bridge rung must not change any verdict that already existed');
});

test('a bridged ERC-20 classifies on the label, not on the token', () => {
  const row = only([
    leg({
      transfer_type: 'token', token_standard: 'erc20', token_decimals: 6,
      token_contract: USDC, token_symbol: 'USDC', to_address: BRIDGE,
      value_wei: '250000000',
    }),
    gasLeg({ to_address: BRIDGE }),
  ], bridging());

  assert.equal(row.category, 'bridge_out');
  assert.deepEqual(row.legs.map((l) => [l.asset, l.direction, l.amount]), [['USDC', 'out', '250']]);
});

test('a reverted bridge deposit is `failed`, never a completed bridge_out', () => {
  // The gate runs before every rung. A revert moved nothing, and a bridge_out
  // that could be paired would assert money crossed a chain it never left.
  const row = only([
    leg({ to_address: BRIDGE, is_error: true }),
    gasLeg({ to_address: BRIDGE, tx_is_error: true }),
  ], bridging());

  assert.equal(row.category, 'failed');
});

test('no bridge rule reads method_id or method_name', () => {
  // Selector collisions are mined deliberately, so a decoded name is an
  // attacker-chosen input. A transfer to an UNLABELED address that calls
  // something named depositETH is still just a flagged send.
  const row = only([
    leg({ to_address: OTHER, method_id: '0xe9e05c42', method_name: 'depositTransaction(address,uint256)' }),
    gasLeg({ to_address: OTHER }),
  ], bridging());

  assert.equal(row.category, 'send');
  assert.equal(row.method_name, 'depositTransaction(address,uint256)', 'still copied, for display');
});

test('an ignored spam token cannot manufacture a bridge leg', () => {
  const row = only([
    leg({
      transfer_type: 'token', token_standard: 'erc20', token_contract: USDC,
      token_symbol: 'SPAM', from_address: BRIDGE, to_address: WALLET,
    }),
    gasLeg({ to_address: BRIDGE }),
  ], bridging({ ignoredContracts: new Set([USDC]) }));

  assert.equal(row.category, 'contract_interaction');
  assert.equal(row.needs_review, false);
});

// --- label precedence, resolved in SQL -------------------------------------

test("a user's 'external' verdict shadows a builtin bridge label", async () => {
  db.labels = [{ user_id: null, address: BRIDGE, name: 'Arbitrum: Delayed Inbox', kind: 'bridge' }];
  assert.deepEqual([...await EthActivityService._bridgeAddressesForUser(OWNER_ID)], [BRIDGE]);

  // The correction is a separate user row; the builtin is untouched (deleting
  // it would only be undone by the next boot's seed).
  db.labels.push({ user_id: OWNER_ID, address: BRIDGE, name: 'Not a bridge', kind: 'external' });
  assert.deepEqual([...await EthActivityService._bridgeAddressesForUser(OWNER_ID)], [],
    'a user row must be able to overrule a seeded bridge');

  // ...and another user is unaffected by that correction.
  assert.deepEqual([...await EthActivityService._bridgeAddressesForUser(2)], [BRIDGE]);
});

test('the bridge-set query filters kind OUTSIDE the DISTINCT ON', async () => {
  // The trap this codebase has hit before (reclassifyCounterparties' second
  // UPDATE): narrowing the candidate set on `kind` before precedence resolves
  // drops the user's override and lets the builtin resurface underneath it.
  const seen = [];
  const original = require('../src/config/database').query;
  require('../src/config/database').query = async (text, params) => {
    seen.push(String(text).replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim());
    return original(text, params);
  };
  await EthActivityService._bridgeAddressesForUser(OWNER_ID);
  require('../src/config/database').query = original;

  const sql = seen[0];
  const inner = sql.slice(sql.indexOf('SELECT DISTINCT ON'), sql.indexOf(') resolved'));
  assert.doesNotMatch(inner, /kind =/);
  assert.match(inner, /ORDER BY address, user_id NULLS LAST/);
  // The kind is bound rather than interpolated since 046 generalized this to
  // serve every kind, but it must still be tested AFTER precedence resolves.
  assert.match(sql, /\) resolved WHERE kind = \$2/);
});

test('the service set is fetched by the same precedence-resolving query as bridge', async () => {
  // 046 shares one query between the two kinds precisely so a second kind
  // cannot grow its own precedence rules. If these ever diverge, a user's
  // 'external' override would stop suppressing a builtin on one of them.
  const seen = [];
  const original = require('../src/config/database').query;
  require('../src/config/database').query = async (text, params) => {
    seen.push({ text: String(text).replace(/\s+/g, ' ').trim(), params });
    return original(text, params);
  };
  await EthActivityService._bridgeAddressesForUser(OWNER_ID);
  await EthActivityService._serviceAddressesForUser(OWNER_ID);
  require('../src/config/database').query = original;

  assert.equal(seen[0].text, seen[1].text, 'both kinds must use the identical query');
  assert.deepEqual(seen[0].params, [OWNER_ID, 'bridge']);
  assert.deepEqual(seen[1].params, [OWNER_ID, 'service']);
});

test('any label kind drains the counterparty triage queue, bridge and service included', () => {
  // The queue's population is "no label row of ANY kind", so a new kind needs
  // no change there -- but that has to stay true, and a kind predicate creeping
  // into the CTE is exactly how it would stop being. This is what lets 046's
  // 'service' verdict clear the queue with no query change at all.
  const cte = EthTransfer.UNREVIEWED_COUNTERPARTIES_CTE
    || fs.readFileSync(path.join(__dirname, '../src/models/EthTransfer.js'), 'utf-8')
      .split('const UNREVIEWED_COUNTERPARTIES_CTE = `')[1]
      .split('`')[0];
  const unlabeled = cte.slice(cte.indexOf('unlabeled AS'), cte.indexOf('grouped AS'));
  assert.match(unlabeled, /FROM eth_address_labels lab/);
  assert.doesNotMatch(unlabeled.replace(/--[^\n]*/g, ''), /lab\.kind/);
});

// --- the pairing policy (pure) ---------------------------------------------

const scaled = (text) => {
  const [whole, frac = ''] = String(text).split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(`${frac}${'0'.repeat(18)}`.slice(0, 18));
};
const candidate = (id, chainId, asset, amount, time) => ({
  id, chain_id: chainId, asset, amount: scaled(amount), rawAmount: String(amount), time,
});

const T0 = Date.parse('2026-03-01T00:00:00.000Z');

test('a canonical L1 -> L2 deposit pairs into one movement, fee recorded', () => {
  const links = pairBridgeLegs(
    [candidate(1, 1, 'ETH', '1.5', T0)],
    [candidate(2, 42161, 'ETH', '1.5', T0 + 12 * 60 * 1000)]
  );

  assert.deepEqual(links, [{
    out_activity_id: 1, in_activity_id: 2, asset: 'ETH',
    out_amount: '1.5', in_amount: '1.5', fee_amount: '0',
  }]);
});

test('a fast bridge that takes a cut still pairs, and the delta is the fee', () => {
  const links = pairBridgeLegs(
    [candidate(1, 1, 'ETH', '1', T0)],
    [candidate(2, 42161, 'ETH', '0.995', T0 + 30 * 1000)]
  );
  assert.equal(links.length, 1);
  assert.equal(links[0].fee_amount, '0.005');
});

test('a cut wider than the tolerance is left unpaired, not forced', () => {
  // 5% is not a bridge fee. Pairing it would fuse two unrelated transfers into
  // one self-transfer and delete a real send from the ledger; leaving it
  // flagged only costs a review.
  assert.deepEqual(pairBridgeLegs(
    [candidate(1, 1, 'ETH', '1', T0)],
    [candidate(2, 42161, 'ETH', '0.95', T0 + HOUR)]
  ), []);
});

test('the far side can never be larger than what left', () => {
  assert.deepEqual(pairBridgeLegs(
    [candidate(1, 1, 'ETH', '1', T0)],
    [candidate(2, 42161, 'ETH', '1.0001', T0 + HOUR)]
  ), []);
});

test('money cannot arrive before it left, and never on the chain it left from', () => {
  assert.deepEqual(pairBridgeLegs(
    [candidate(1, 1, 'ETH', '1', T0)],
    [candidate(2, 42161, 'ETH', '1', T0 - 60 * 1000)]
  ), [], 'the in leg predates the out leg');

  assert.deepEqual(pairBridgeLegs(
    [candidate(1, 1, 'ETH', '1', T0)],
    [candidate(2, 1, 'ETH', '1', T0 + HOUR)]
  ), [], 'same chain is a send and a receive, not a bridge');
});

test('the window depends on the chain the money LEFT', () => {
  // L1 -> L2 lands in minutes. L2 -> L1 waits out the 7-day challenge period,
  // so a three-day gap is normal in one direction and nonsense in the other.
  const threeDays = 3 * DAY;
  assert.equal(pairBridgeLegs(
    [candidate(1, 42161, 'ETH', '1', T0)],
    [candidate(2, 1, 'ETH', '1', T0 + threeDays)]
  ).length, 1);

  assert.deepEqual(pairBridgeLegs(
    [candidate(1, 1, 'ETH', '1', T0)],
    [candidate(2, 42161, 'ETH', '1', T0 + threeDays)]
  ), []);

  assert.equal(BRIDGE_DEPOSIT_WINDOW_MS, DAY);
  assert.equal(BRIDGE_WITHDRAWAL_WINDOW_MS, 8 * DAY);

  // The withdrawal window has an end too.
  assert.deepEqual(pairBridgeLegs(
    [candidate(1, 42161, 'ETH', '1', T0)],
    [candidate(2, 1, 'ETH', '1', T0 + 9 * DAY)]
  ), []);
});

test('two bridges in flight pair earliest to earliest, and each leg once', () => {
  const links = pairBridgeLegs(
    [candidate(1, 1, 'ETH', '1', T0), candidate(2, 1, 'ETH', '1', T0 + HOUR)],
    [candidate(3, 42161, 'ETH', '1', T0 + 10 * 60 * 1000),
      candidate(4, 42161, 'ETH', '1', T0 + 70 * 60 * 1000)]
  );

  assert.deepEqual(links.map((l) => [l.out_activity_id, l.in_activity_id]), [[1, 3], [2, 4]]);
});

test('one in leg cannot complete two out legs', () => {
  const links = pairBridgeLegs(
    [candidate(1, 1, 'ETH', '1', T0), candidate(2, 1, 'ETH', '1', T0 + 60 * 1000)],
    [candidate(3, 42161, 'ETH', '1', T0 + 10 * 60 * 1000)]
  );
  assert.equal(links.length, 1);
  assert.equal(links[0].out_activity_id, 1);
});

test('different assets never pair, but the two spellings of one asset do', () => {
  assert.deepEqual(pairBridgeLegs(
    [candidate(1, 1, 'ETH', '1', T0)],
    [candidate(2, 42161, 'USDC', '1', T0 + HOUR)]
  ), []);

  // WETH is ETH by construction, and the canonical bridge MINTS USDC.e for
  // USDC -- refusing those would leave every canonical ERC-20 deposit unpaired.
  assert.equal(bridgeAsset('WETH'), 'ETH');
  assert.equal(bridgeAsset('USDC.e'), 'USDC');
  assert.equal(bridgeAsset('usdc'), 'USDC');
  assert.equal(bridgeAsset(''), null);
  // Not over-normalized: these are different money.
  assert.notEqual(bridgeAsset('USDT'), bridgeAsset('USDC'));
  assert.equal(bridgeAsset('WBTC'), 'WBTC');
});

test('the two normalizations COMPOSE, in the order suffix-then-wrapper', () => {
  // A bridged wrapped ether is spelled WETH.e, so both rules apply to one
  // symbol. Testing WETH before stripping .e leaves it in a bucket of its own
  // that pairs with neither ETH nor WETH, and its deposit never matches.
  assert.equal(bridgeAsset('WETH.e'), 'ETH');
  assert.equal(bridgeAsset('weth.e'), 'ETH');
  // Both single-rule cases still hold either way round; only the composition
  // distinguishes the orders.
  assert.equal(bridgeAsset('WETH'), bridgeAsset('WETH.e'));
  assert.equal(bridgeAsset('ETH'), bridgeAsset('WETH.e'));

  assert.equal(pairBridgeLegs(
    [candidate(1, 1, bridgeAsset('WETH.e'), '1', T0)],
    [candidate(2, 42161, bridgeAsset('ETH'), '1', T0 + HOUR)]
  ).length, 1);

  // A symbol that is nothing BUT the suffix normalizes to nothing, not to '.E'.
  assert.equal(bridgeAsset('.e'), null);
});

// --- the stateful matching pass --------------------------------------------

async function seedBridgeActivity(rows) {
  db.activity = rows.map((row, i) => ({
    id: i + 1,
    wallet_id: OWNED_WALLET_ID,
    needs_review: true,
    review_reason: REVIEW_REASONS.unmatched_bridge,
    confidence: 'medium',
    tx_hash: TX,
    ...row,
  }));
  nextActivityId = db.activity.length + 1;
}

const ethLeg = (amount) => [{
  asset: 'ETH', contract: null, token_id: null, token_standard: null,
  direction: 'out', amount, amount_raw: '0',
}];
const ethLegIn = (amount) => [{ ...ethLeg(amount)[0], direction: 'in' }];

test('matching clears the review flag on both legs and records the fee', async () => {
  await seedBridgeActivity([
    { chain_id: 1, category: 'bridge_out', block_time: '2026-03-01T00:00:00.000Z', legs: ethLeg('2') },
    { chain_id: 42161, category: 'bridge_in', block_time: '2026-03-01T00:11:00.000Z', legs: ethLegIn('1.998') },
  ]);

  const result = await EthActivityService.matchBridgeTransfersForUser(OWNER_ID);

  assert.deepEqual(result, { matched: 1, unmatched: 0 });
  assert.deepEqual(db.links, [{
    out_activity_id: 1, in_activity_id: 2, asset: 'ETH',
    out_amount: '2', in_amount: '1.998', fee_amount: '0.002',
  }]);
  for (const row of db.activity) {
    assert.equal(row.needs_review, false);
    assert.equal(row.review_reason, null);
    assert.equal(row.confidence, 'high');
  }
});

test('an unmatched bridge_out stays in the review queue', async () => {
  await seedBridgeActivity([
    { chain_id: 1, category: 'bridge_out', block_time: '2026-03-01T00:00:00.000Z', legs: ethLeg('2') },
  ]);

  const result = await EthActivityService.matchBridgeTransfersForUser(OWNER_ID);

  assert.deepEqual(result, { matched: 0, unmatched: 1 });
  assert.equal(db.links.length, 0);
  assert.equal(db.activity[0].needs_review, true);
  assert.equal(db.activity[0].review_reason, REVIEW_REASONS.unmatched_bridge);
});

test('a leg whose partner disappears goes back to needs_review', async () => {
  await seedBridgeActivity([
    { chain_id: 1, category: 'bridge_out', block_time: '2026-03-01T00:00:00.000Z', legs: ethLeg('2') },
    { chain_id: 42161, category: 'bridge_in', block_time: '2026-03-01T00:11:00.000Z', legs: ethLegIn('2') },
  ]);
  await EthActivityService.matchBridgeTransfersForUser(OWNER_ID);
  assert.equal(db.activity[0].needs_review, false);

  // The far side is re-ingested and, this time, is not there (a wallet removed,
  // a chain disabled). Re-flagging is the half that is easy to forget, and the
  // one that decides whether the row lies.
  db.activity = db.activity.filter((r) => r.category !== 'bridge_in');
  db.links = [];
  const result = await EthActivityService.matchBridgeTransfersForUser(OWNER_ID);

  assert.deepEqual(result, { matched: 0, unmatched: 1 });
  assert.equal(db.activity[0].needs_review, true);
  assert.equal(db.activity[0].confidence, 'medium');
});

test('matching is idempotent: re-running writes the same single link', async () => {
  await seedBridgeActivity([
    { chain_id: 1, category: 'bridge_out', block_time: '2026-03-01T00:00:00.000Z', legs: ethLeg('1') },
    { chain_id: 42161, category: 'bridge_in', block_time: '2026-03-01T00:05:00.000Z', legs: ethLegIn('1') },
  ]);

  await EthActivityService.matchBridgeTransfersForUser(OWNER_ID);
  await EthActivityService.matchBridgeTransfersForUser(OWNER_ID);
  await EthActivityService.matchBridgeTransfersForUser(OWNER_ID);

  // Three runs, one link -- the delete-then-insert has to clear the previous
  // derivation or the UNIQUE constraints would throw on run two.
  assert.equal(db.links.length, 1);
});

test('a multi-asset bridge transaction is left unpaired rather than guessed', async () => {
  await seedBridgeActivity([
    {
      chain_id: 1,
      category: 'bridge_out',
      block_time: '2026-03-01T00:00:00.000Z',
      legs: [...ethLeg('1'), { ...ethLeg('500')[0], asset: 'USDC' }],
    },
    { chain_id: 42161, category: 'bridge_in', block_time: '2026-03-01T00:05:00.000Z', legs: ethLegIn('1') },
  ]);

  const result = await EthActivityService.matchBridgeTransfersForUser(OWNER_ID);
  assert.equal(result.matched, 0);
  assert.equal(db.activity[0].needs_review, true);
});

test('two DIFFERENT unnamed ERC-20s are never fused into one movement', async () => {
  // `asset` is a display string and 'TOKEN' is the placeholder for an ERC-20 the
  // feed never named -- so without a readability flag, two unrelated unnamed
  // tokens of the same size compare equal and pair, un-flagging both sides of a
  // movement that never happened. A leg we cannot read is a leg we do not pair.
  const UNNAMED_A = '0xaaa0000000000000000000000000000000000001';
  const UNNAMED_B = '0xbbb0000000000000000000000000000000000002';
  const unnamed = (contract, overrides) => leg({
    transfer_type: 'token', token_standard: 'erc20', token_decimals: 18,
    token_contract: contract, token_symbol: null, value_wei: '1000000000000000000',
    ...overrides,
  });

  const out = only([unnamed(UNNAMED_A, { to_address: BRIDGE })], bridging());
  const back = only([unnamed(UNNAMED_B, {
    from_address: BRIDGE_L2, to_address: WALLET, chain_id: 42161, tx_hash: TX2,
  })], bridging());

  assert.equal(out.category, 'bridge_out');
  assert.equal(back.category, 'bridge_in');
  // The placeholder is still what renders; the flag is what says not to trust it.
  assert.equal(out.legs[0].asset, 'TOKEN');
  assert.equal(out.legs[0].symbol_known, false);
  assert.equal(back.legs[0].symbol_known, false);

  await seedBridgeActivity([
    { chain_id: 1, tx_hash: TX, category: 'bridge_out', block_time: '2026-03-01T00:00:00.000Z', legs: out.legs },
    { chain_id: 42161, tx_hash: TX2, category: 'bridge_in', block_time: '2026-03-01T00:05:00.000Z', legs: back.legs },
  ]);

  const result = await EthActivityService.matchBridgeTransfersForUser(OWNER_ID);
  assert.deepEqual(result, { matched: 0, unmatched: 2 });
  assert.equal(db.links.length, 0);
  for (const row of db.activity) assert.equal(row.needs_review, true);
});

test('a NAMED token leg carries no flag and pairs as before', async () => {
  // The control for the test above: the refusal has to come from the missing
  // symbol, not from tokens being unpairable in general.
  const named = (overrides) => leg({
    transfer_type: 'token', token_standard: 'erc20', token_decimals: 6,
    token_contract: USDC, token_symbol: 'USDC', value_wei: '250000000', ...overrides,
  });

  const out = only([named({ to_address: BRIDGE })], bridging());
  const back = only([named({
    from_address: BRIDGE_L2, to_address: WALLET, chain_id: 42161, tx_hash: TX2,
    token_symbol: 'USDC.e',
  })], bridging());

  assert.equal(Object.hasOwn(out.legs[0], 'symbol_known'), false,
    'the flag is emitted only when the symbol is a placeholder');

  await seedBridgeActivity([
    { chain_id: 1, tx_hash: TX, category: 'bridge_out', block_time: '2026-03-01T00:00:00.000Z', legs: out.legs },
    { chain_id: 42161, tx_hash: TX2, category: 'bridge_in', block_time: '2026-03-01T00:05:00.000Z', legs: back.legs },
  ]);

  assert.deepEqual(await EthActivityService.matchBridgeTransfersForUser(OWNER_ID),
    { matched: 1, unmatched: 0 });
});

test('a later leg naming the same contract upgrades the placeholder', () => {
  // Same upgrade rule as decimals_known: the first NON-EMPTY symbol wins, so a
  // multi-leg transaction where only one leg carried the symbol is readable.
  const row = only([
    leg({
      transfer_type: 'token', token_standard: 'erc20', token_decimals: 18,
      token_contract: USDC, token_symbol: null, to_address: BRIDGE,
      value_wei: '3000000000000000000',
    }),
    leg({
      transfer_type: 'token', token_standard: 'erc20', token_decimals: 18,
      token_contract: USDC, token_symbol: 'DAI', from_address: BRIDGE, to_address: WALLET,
      value_wei: '1000000000000000000',
    }),
  ], bridging());

  assert.equal(row.legs.length, 1);
  assert.equal(row.legs[0].asset, 'DAI');
  assert.equal(Object.hasOwn(row.legs[0], 'symbol_known'), false);
});

test('an overridden bridge leg gets no link, and its far side goes back to flagged', async () => {
  // Every other reader COALESCEs eth_activity_overrides over the derived
  // category. A matcher that read the derived one would keep pairing a
  // transaction the user explicitly re-categorized as a plain send -- and, worse
  // than the stale link itself, would un-flag the far side on the strength of a
  // verdict the user withdrew.
  await seedBridgeActivity([
    { chain_id: 1, tx_hash: TX, category: 'bridge_out', block_time: '2026-03-01T00:00:00.000Z', legs: ethLeg('2') },
    { chain_id: 42161, tx_hash: TX2, category: 'bridge_in', block_time: '2026-03-01T00:11:00.000Z', legs: ethLegIn('2') },
  ]);

  // Baseline: derived on both sides, so they pair and both clear.
  assert.deepEqual(await EthActivityService.matchBridgeTransfersForUser(OWNER_ID),
    { matched: 1, unmatched: 0 });

  // The user disagrees: that outflow was a send, not a bridge deposit.
  db.overrides = [{ wallet_id: OWNED_WALLET_ID, chain_id: 1, tx_hash: TX, category: 'send' }];
  const result = await EthActivityService.matchBridgeTransfersForUser(OWNER_ID);

  assert.deepEqual(result, { matched: 0, unmatched: 1 });
  assert.equal(db.links.length, 0);

  const far = db.activity.find((r) => r.category === 'bridge_in');
  assert.equal(far.needs_review, true, 'the far side must not stay silently completed');
  assert.equal(far.review_reason, REVIEW_REASONS.unmatched_bridge);

  // The overridden row is out of scope for this pass entirely: an override IS a
  // review, and the readers already report it as such.
  const overridden = db.activity.find((r) => r.tx_hash === TX);
  assert.equal(overridden.needs_review, false);
});

test('a row overridden INTO a bridge leg becomes matchable', async () => {
  // The same rule read the other way: resolution is COALESCE, not "ignore
  // overrides that disagree".
  await seedBridgeActivity([
    { chain_id: 1, tx_hash: TX, category: 'send', block_time: '2026-03-01T00:00:00.000Z', legs: ethLeg('2') },
    { chain_id: 42161, tx_hash: TX2, category: 'bridge_in', block_time: '2026-03-01T00:11:00.000Z', legs: ethLegIn('2') },
  ]);

  assert.deepEqual(await EthActivityService.matchBridgeTransfersForUser(OWNER_ID),
    { matched: 0, unmatched: 1 });

  db.overrides = [{ wallet_id: OWNED_WALLET_ID, chain_id: 1, tx_hash: TX, category: 'bridge_out' }];
  assert.deepEqual(await EthActivityService.matchBridgeTransfersForUser(OWNER_ID),
    { matched: 1, unmatched: 0 });
  assert.deepEqual(db.links.map((l) => [l.out_activity_id, l.in_activity_id]), [[1, 2]]);
});

test('the matcher refuses to run unscoped', async () => {
  await assert.rejects(() => EthActivityService.matchBridgeTransfersForUser(null), /requires a userId/);
});

test('the activity feed exposes the pairing so the two legs render as one', () => {
  // A matched pair IS one movement; each leg has to be able to point at the
  // other, or the UI can only ever show two halves.
  const sql = String(EthActivity.RESOLVED_COLUMNS || '');
  const source = fs.readFileSync(path.join(__dirname, '../src/models/EthActivity.js'), 'utf-8');
  const columns = sql || source.split('const RESOLVED_COLUMNS = `')[1].split('`')[0];
  const from = source.split('const RESOLVED_FROM = `')[1].split('`')[0];

  for (const column of ['bridge_link_id', 'bridge_fee_amount',
    'bridge_counterpart_chain_id', 'bridge_counterpart_tx_hash']) {
    assert.match(columns, new RegExp(`AS ${column}`));
  }
  // Both joins, or a leg only sees the pairing from one side.
  assert.match(from, /LEFT JOIN eth_activity_links lo ON lo\.out_activity_id = a\.id/);
  assert.match(from, /LEFT JOIN eth_activity_links li ON li\.in_activity_id = a\.id/);
});

// --- the seeded bridge pack ------------------------------------------------

const MIGRATION_PATH = path.join(__dirname, '../migrations/044_bridge_labels.sql');
const SEED_SQL = fs.readFileSync(MIGRATION_PATH, 'utf-8');
const PACK = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/builtin-bridge-labels.json'), 'utf-8'));
const ETH_LABELS_PACK = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../data/builtin-address-labels.json'), 'utf-8')
);
const { buildSql, preambleOf } = require('../scripts/generate-bridge-seed');

const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');
const SEED_ROW = /^ {2}\(NULL, '(0x[0-9a-f]{40})', '(.*)', 'builtin-bridge', 'bridge', 'high', '(.*)'\),?$/;

function parseSeededRows() {
  return SEED_SQL.split('\n').filter((line) => line.startsWith('  (')).map((line) => {
    const match = line.match(SEED_ROW);
    assert.ok(match, `seeded row does not match the expected shape: ${line}`);
    return { address: match[1], name: match[2].replace(/''/g, "'"), note: match[3].replace(/''/g, "'") };
  });
}

test('every seeded bridge carries a cited official source URL', () => {
  const seeded = parseSeededRows();
  assert.equal(seeded.length, PACK.labels.length);
  assert.ok(seeded.length >= 20, 'the pack should cover the registry chains, not a token sample');

  const byAddress = new Map(PACK.labels.map((l) => [l.address, l]));
  for (const row of seeded) {
    const entry = byAddress.get(row.address);
    assert.ok(entry, `seeded address is not in the JSON pack: ${row.address}`);
    assert.equal(row.name, entry.name);
    // The provenance travels IN the row (note renders as the label's tooltip),
    // not only in a file nobody opens.
    const url = PACK.sources[entry.protocol];
    assert.ok(url, `no source URL for protocol ${entry.protocol}`);
    assert.equal(row.note, `Cross-chain bridge on chain ${entry.chain_id}. Source: ${url}`);
    assert.match(url, /^https:\/\//);
  }
});

test('every source is a first-party domain, never an aggregator', () => {
  const ALLOWED = [
    /^https:\/\/docs\.arbitrum\.io\//,
    /^https:\/\/docs\.linea\.build\//,
    /^https:\/\/docs\.base\.org\//,
    /^https:\/\/docs\.across\.to\//,
    // Optimism's docs page renders its L1 table client-side from this exact
    // first-party registry file; no static docs.optimism.io page prints them.
    /^https:\/\/raw\.githubusercontent\.com\/ethereum-optimism\/superchain-registry\//,
    // Polygon's own static network registry, in its own GitHub org -- the file
    // its SDKs resolve mainnet addresses from.
    /^https:\/\/raw\.githubusercontent\.com\/maticnetwork\/static\//,
  ];
  for (const [protocol, url] of Object.entries(PACK.sources)) {
    assert.ok(ALLOWED.some((re) => re.test(url)), `${protocol} cites a non-first-party source: ${url}`);
  }
});

test('every seeded row is a storable builtin on a chain this app knows', () => {
  const { allChains } = require('../src/config/chains');
  const known = new Set(allChains().map((chain) => chain.id));
  const seen = new Set();

  const columns = SEED_SQL.match(/INSERT INTO eth_address_labels \(([^)]+)\) VALUES/);
  assert.deepEqual(columns[1].split(', '),
    ['user_id', 'address', 'name', 'source', 'kind', 'confidence', 'note']);

  for (const label of PACK.labels) {
    assert.match(label.address, /^0x[0-9a-f]{40}$/);
    assert.ok(label.name.length > 0 && label.name.length <= 64, `bad name: ${label.name}`);
    assert.doesNotMatch(label.name, /[\r\n\\]/);
    assert.ok(!seen.has(label.address), `duplicate address: ${label.address}`);
    seen.add(label.address);
    // A bridge on a chain that is not in the registry could never be seen, and
    // 044's whole justification is the chains #58 actually syncs.
    assert.ok(known.has(label.chain_id), `chain ${label.chain_id} is not in config/chains.js`);
  }
});

test('the scraped pack cannot swallow a bridge address', () => {
  // 036 runs FIRST every boot and 044's conflict arm is DO NOTHING, so an
  // address in both packs would keep the scraped 'exchange' verdict and the
  // bridge label would never exist -- silently, and only on a fresh database.
  const scraped = new Set(ETH_LABELS_PACK.labels.map((l) => l.address));
  const collisions = PACK.labels.filter((l) => scraped.has(l.address)).map((l) => l.address);
  assert.deepEqual(collisions, []);
});

test('re-running the seed can never re-vote an existing verdict', () => {
  const seedStatement = stripComments(SEED_SQL)
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('INSERT INTO eth_address_labels'));

  assert.ok(seedStatement);
  // Migrations re-run on EVERY boot. DO UPDATE would re-stamp a name, a kind or
  // a note the user had already corrected, every boot, forever.
  assert.doesNotMatch(stripComments(SEED_SQL), /DO UPDATE/i);
  // 029's partial unique index on (address) WHERE user_id IS NULL. Inferring
  // the per-user index instead would make each boot's insert collide with a
  // USER's row for the same address.
  assert.match(seedStatement, /ON CONFLICT \(address\) WHERE user_id IS NULL DO NOTHING$/);
});

test('both CHECK swaps are guarded on the DEFINITION, with a bumped sentinel', () => {
  // A name-only guard is satisfied by the constraint that already exists, so
  // the widening is skipped forever on every deployed database while looking
  // perfectly applied on a fresh one -- 032's kind CHECK is exactly that shape,
  // which is why this file has to drop and re-add rather than ALTER in place.
  assert.match(SEED_SQL, /conname = 'eth_address_labels_kind_check'\s*\n\s*AND pg_get_constraintdef\(oid\) LIKE '%bridge%'/);
  // The UNION of every kind, 046's 'service' included -- the same rule the
  // source CHECK below follows, applied to the kind CHECK so a reader never has
  // to work out which sentinel happens to survive which widening.
  assert.match(SEED_SQL, /CHECK \(kind IN \('exchange', 'external', 'own', 'bridge', 'service'\)\)/);
  const serviceSql = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '046_service_label_kind.sql'), 'utf8'
  );
  assert.match(serviceSql, /conname = 'eth_address_labels_kind_check'\s*\n\s*AND pg_get_constraintdef\(oid\) LIKE '%service%'/);
  assert.match(serviceSql, /CHECK \(kind IN \('exchange', 'external', 'own', 'bridge', 'service'\)\)/);
  // 'exchange_trade' has been in 038's category CHECK since 038; 046 adds no
  // category and must not touch that constraint.
  assert.doesNotMatch(serviceSql, /eth_activity_category_check/);
  assert.match(SEED_SQL, /conname = 'eth_address_labels_source_check'\s*\n\s*AND pg_get_constraintdef\(oid\) LIKE '%builtin-bridge%'/);
  // The UNION of every source, 041's 'auto-match' included. 041 owns this same
  // constraint under its own sentinel, so two narrower lists take turns
  // dropping and re-adding each other's -- and once the bridge rows exist,
  // 041's re-add fails the CHECK, which broke the SECOND boot of every
  // database while a fresh one looked perfectly applied.
  assert.match(SEED_SQL, /CHECK \(source IN \('user', 'builtin', 'eth-labels', 'auto-match', 'builtin-bridge'\)\)/);
  const matchesSql = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '041_exchange_matches.sql'), 'utf8'
  );
  assert.match(matchesSql, /CHECK \(source IN \('user', 'builtin', 'eth-labels', 'auto-match', 'builtin-bridge'\)\)/);

  // 038 already carries bridge_out/bridge_in in the category CHECK, so this
  // migration must NOT touch it.
  assert.doesNotMatch(SEED_SQL, /eth_activity_category_check/);
});

test('the links table cannot let one leg be claimed twice', () => {
  assert.match(SEED_SQL, /CONSTRAINT eth_activity_links_out_unique UNIQUE \(out_activity_id\)/);
  assert.match(SEED_SQL, /CONSTRAINT eth_activity_links_in_unique UNIQUE \(in_activity_id\)/);
  assert.match(SEED_SQL, /out_activity_id BIGINT NOT NULL REFERENCES eth_activity\(id\) ON DELETE CASCADE/);
  assert.match(SEED_SQL, /in_activity_id BIGINT NOT NULL REFERENCES eth_activity\(id\) ON DELETE CASCADE/);
  // No user_id column: ownership lives on eth_wallets and is inherited through
  // eth_activity, like every other child table.
  assert.doesNotMatch(SEED_SQL.split('CREATE TABLE IF NOT EXISTS eth_activity_links')[1].split(');')[0], /user_id/);
  // A declared scale would ROUND on insert, in the columns that record how much
  // money moved.
  assert.match(SEED_SQL, /out_amount NUMERIC NOT NULL/);
  assert.doesNotMatch(SEED_SQL, /NUMERIC\(\d+, ?\d+\)/);
});

test('the committed migration is a regeneration of the committed JSON pack', () => {
  // The generator is the only sanctioned way to edit the seed; a hand-typed
  // address in the SQL would otherwise ship with nothing to compare it against.
  assert.equal(buildSql(PACK, preambleOf(SEED_SQL)), SEED_SQL);
});
