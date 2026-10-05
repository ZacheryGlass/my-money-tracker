'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ExchangeReconciliationService = require('../src/services/ExchangeReconciliationService');
const {
  formatReport,
  mergeProvenance,
  planPairs,
  run,
} = require('../scripts/resolve-binanceus-trade-duplicates');

const NO_DEPENDENCIES = {
  'exchange_matches.exchange_record_id': 0,
  'exchange_record_dedupe_events.survivor_record_id': 0,
};

function candidate(overrides = {}) {
  return {
    api_id: '10',
    api_external_id: 'binanceus:trade:NANOUSD4:287471',
    symbol: 'NANOUSD4',
    order_id: '11356314',
    base_asset: 'NANO',
    base_amount: '-111.750000000000000000',
    api_quote_asset: 'USD4',
    api_quote_amount: '774.807400000000000000',
    api_fee_asset: 'USD4',
    api_fee_amount: '0.774800000000000000',
    api_needs_review: false,
    api_duplicate_candidate: false,
    api_rounding_disclosure: false,
    api_already_audited: false,
    csv_id: '20',
    csv_external_id: 'binanceus:trade:NANOUSD:129629973',
    csv_quote_asset: 'USD',
    csv_quote_amount: '774.807450000000000000',
    csv_fee_asset: 'USD',
    csv_fee_amount: '0.774800000000000000',
    csv_needs_review: false,
    csv_duplicate_candidate: false,
    csv_rounding_disclosure: false,
    quote_asset_compatible: true,
    fee_asset_compatible: true,
    fee_amount_equal: true,
    quote_within_rounding: true,
    ...overrides,
  };
}

function dependencies(entries) {
  return new Map(entries.map(([id, counts]) => [id, { ...NO_DEPENDENCIES, ...counts }]));
}

test('a fill with exactly one unclaimed CSV twin pairs one-to-one', () => {
  const plan = planPairs([candidate()], dependencies([['10', {}]]));
  assert.deepEqual(plan.pairs, [{
    api_id: '10',
    csv_id: '20',
    symbol: 'NANOUSD4',
    base_amount: '-111.75 NANO',
    api_quote: '774.8074',
    csv_quote: '774.80745',
  }]);
  assert.equal(plan.ambiguous.length, 0);
  assert.equal(plan.refused.length, 0);
});

test('a fill with two CSV twins is ambiguous and never paired', () => {
  const plan = planPairs([
    candidate({ csv_id: '20' }),
    candidate({ csv_id: '21' }),
  ], dependencies([['10', {}]]));
  assert.equal(plan.pairs.length, 0);
  assert.equal(plan.ambiguous.length, 1);
  assert.equal(plan.ambiguous[0].reason, 'group_counts_unequal');
  assert.deepEqual(plan.ambiguous[0].csv_candidate_ids, ['20', '21']);
});

test('two API fills sharing one CSV twin stay ambiguous; a fill with no twin is named', () => {
  const plan = planPairs([
    candidate({ api_id: '10', csv_id: '20' }),
    candidate({ api_id: '11', csv_id: '20' }),
    candidate({ api_id: '12', csv_id: null }),
  ], dependencies([['10', {}], ['11', {}], ['12', {}]]));
  assert.equal(plan.pairs.length, 0);
  assert.deepEqual(plan.ambiguous.map((item) => [item.api_id, item.reason]), [
    ['10', 'group_counts_unequal'],
    ['11', 'group_counts_unequal'],
    ['12', 'no_csv_twin'],
  ]);
  assert.deepEqual(plan.ambiguous[0].group_api_ids, ['10', '11']);
  assert.deepEqual(plan.ambiguous[0].group_csv_ids, ['20']);
});

// Every API x CSV edge of a k-by-k group, in a deliberately scrambled order.
function group(apiIds, csvIds, edit = () => ({})) {
  const rows = [];
  for (const csvId of [...csvIds].reverse()) {
    for (const apiId of apiIds) rows.push(candidate({ api_id: apiId, csv_id: csvId, ...edit(apiId, csvId) }));
  }
  return rows;
}

test('an identical 2+2 group pairs by ascending numeric id', () => {
  const plan = planPairs(group(['9', '10'], ['21', '20']), dependencies([['9', {}], ['10', {}]]));
  assert.equal(plan.ambiguous.length, 0);
  assert.equal(plan.refused.length, 0);
  assert.deepEqual(plan.pairs.map((pair) => [pair.api_id, pair.csv_id, pair.group]), [
    ['9', '20', 'api 9+10'],
    ['10', '21', 'api 9+10'],
  ]);
});

test('a 2+2 group with one differing fee stays ambiguous', () => {
  const plan = planPairs(
    group(['10', '11'], ['20', '21'], (apiId, csvId) => (csvId === '21'
      ? { csv_fee_amount: '0.800000000000000000', fee_amount_equal: false }
      : {})),
    dependencies([['10', {}], ['11', {}]])
  );
  assert.equal(plan.pairs.length, 0);
  assert.deepEqual(plan.ambiguous.map((item) => [item.api_id, item.reason]), [
    ['10', 'group_members_differ'],
    ['11', 'group_members_differ'],
  ]);
});

test('a 2+2 group with a dependency on one member stays ambiguous', () => {
  const plan = planPairs(
    group(['10', '11'], ['20', '21']),
    dependencies([['10', {}], ['11', { 'exchange_matches.exchange_record_id': 1 }]])
  );
  assert.equal(plan.pairs.length, 0);
  assert.equal(plan.ambiguous[0].reason, 'group_member_refused');
  assert.deepEqual(plan.ambiguous[0].member_reasons, ['api_referenced_by:exchange_matches.exchange_record_id']);
});

test('an API fill with any dependency is refused, as is one never checked', () => {
  const plan = planPairs([
    candidate({ api_id: '10', csv_id: '20' }),
    candidate({ api_id: '11', csv_id: '21' }),
  ], dependencies([['10', { 'exchange_matches.exchange_record_id': 1 }]]));
  assert.equal(plan.pairs.length, 0);
  assert.deepEqual(plan.refused.map((item) => item.reasons), [
    ['api_referenced_by:exchange_matches.exchange_record_id'],
    ['dependencies_unchecked'],
  ]);
});

test('review flags and legs outside the pair rule refuse the pair', () => {
  const plan = planPairs([
    candidate({ api_id: '10', csv_id: '20', csv_needs_review: true }),
    candidate({ api_id: '11', csv_id: '21', api_duplicate_candidate: true }),
    candidate({ api_id: '12', csv_id: '22', quote_within_rounding: false }),
    candidate({ api_id: '13', csv_id: '23', fee_asset_compatible: false, fee_amount_equal: false }),
    candidate({ api_id: '14', csv_id: '24', api_already_audited: true }),
  ], dependencies(['10', '11', '12', '13', '14'].map((id) => [id, {}])));
  assert.equal(plan.pairs.length, 0);
  assert.deepEqual(plan.refused.map((item) => item.reasons), [
    ['needs_review'],
    ['duplicate_candidate'],
    ['quote_amount_beyond_api_rounding'],
    ['fee_asset_differs', 'fee_amount_differs'],
    ['api_external_id_already_audited'],
  ]);
});

test('provenance seeds an empty survivor with its own snapshot first', () => {
  const csv = { source: 'csv', external_id: 'csv-1', raw: { _source: 'csv' }, base_asset: 'NANO', quote_asset: 'USD', fee_asset: 'USD', dedupe_provenance: null };
  const api = { source: 'api', external_id: 'api-1', raw: { _source: 'api' }, base_asset: 'NANO', quote_asset: 'USD4', fee_asset: 'USD4' };
  const merged = mergeProvenance(csv, api);
  assert.deepEqual(merged.map((entry) => entry.external_id), ['csv-1', 'api-1']);
  assert.equal(merged[1].original_assets.quote_asset, 'USD4');
  const again = mergeProvenance({ ...csv, dedupe_provenance: [{ external_id: 'prior' }] }, api);
  assert.deepEqual(again.map((entry) => entry.external_id), ['prior', 'api-1']);
});

test('the report prints one parseable line per pair', () => {
  const text = formatReport({
    apply: false,
    counts: { pairs: 1 },
    pairs: [{ api_id: '10', csv_id: '20' }],
    ambiguous: [],
    refused: [],
  });
  assert.match(text, /\n {4}\{"api_id":"10","csv_id":"20"\}\n/);
  assert.deepEqual(JSON.parse(text).pairs, [{ api_id: '10', csv_id: '20' }]);
});

// A scripted client: each statement is answered by the first matching rule
// and recorded, so a test can assert exactly what was (not) sent.
function fakeDatabase({ candidates, groupRows = candidates, account = { id: 3, user_id: 1, name: 'Binance US API', exchange: 'binance_us', sync_in_progress: false } }) {
  const statements = [];
  const rows = {
    10: { id: '10', exchange_account_id: 3, source: 'api', external_id: 'binanceus:trade:NANOUSD4:287471', raw: { orderId: 11356314 }, base_asset: 'NANO', quote_asset: 'USD4', fee_asset: 'USD4', fingerprint: 'f'.repeat(64), fingerprint_version: 1, dedupe_provenance: null },
    20: { id: '20', exchange_account_id: 3, source: 'csv', external_id: 'binanceus:trade:NANOUSD:129629973', raw: { 'Order ID': '11356314' }, base_asset: 'NANO', quote_asset: 'USD', fee_asset: 'USD', fingerprint: null, fingerprint_version: null, dedupe_provenance: null },
  };
  const rules = [
    [/^(BEGIN|COMMIT|ROLLBACK)/, () => ({ rows: [] })],
    [/FROM exchange_accounts/, () => ({ rows: [account] })],
    [/FROM pg_constraint/, () => ({ rows: [
      { table_name: 'exchange_matches', column_name: 'exchange_record_id', width: 1 },
      { table_name: 'exchange_record_dedupe_events', column_name: 'survivor_record_id', width: 1 },
    ] })],
    [/unnest/, (params) => ({ rows: params[0].map((id) => ({ id, d0: '0', d1: '0' })) })],
    [/AS api_candidates/, () => ({ rows: [{ ...candidates[0], api_candidates: '1', csv_claims: '1' }] })],
    [/OR csv\.id = ANY/, () => ({ rows: groupRows })],
    [/LEFT JOIN exchange_records csv/, () => ({ rows: candidates })],
    [/COUNT\(\*\) AS count FROM exchange_records csv/, () => ({ rows: [{ count: '1' }] })],
    [/WHERE er\.id = ANY/, (params) => ({ rows: params[0].map((id) => rows[id] || { id: String(id), exchange_account_id: 3 }) })],
    [/^SELECT id FROM exchange_records/, () => ({ rows: [] })],
    [/^(UPDATE|INSERT|DELETE)/, () => ({ rows: [], rowCount: 1 })],
  ];
  const client = {
    async query(sql, params = []) {
      const text = sql.trim();
      statements.push({ sql: text, params });
      const rule = rules.find(([pattern]) => pattern.test(text));
      if (!rule) throw new Error(`unscripted statement: ${text.slice(0, 80)}`);
      return rule[1](params);
    },
    release() {},
  };
  return { database: { connect: async () => client }, statements };
}

test('a dry run is read-only and sends no write or lock', async () => {
  const { database, statements } = fakeDatabase({ candidates: [candidate()] });
  const report = await run({ userId: 1, accountId: 3, apply: false }, { database });
  assert.equal(report.counts.pairs, 1);
  assert.equal(report.counts.applied, 0);
  assert.match(statements[0].sql, /READ ONLY/);
  assert.equal(statements.at(-1).sql, 'ROLLBACK');
  for (const { sql } of statements) {
    assert.doesNotMatch(sql, /^(UPDATE|INSERT|DELETE)|FOR UPDATE/);
  }
});

test('apply keeps the CSV row, audits the API id and deletes only the API row', async (t) => {
  const recomputed = [];
  t.mock.method(ExchangeReconciliationService, 'recomputeForAccount', async (...args) => {
    recomputed.push(args);
    return { status: 'current' };
  });
  const { database, statements } = fakeDatabase({ candidates: [candidate()] });
  const report = await run({ userId: 1, accountId: 3, apply: true }, { database });
  assert.equal(report.counts.applied, 1);
  assert.equal(report.reconciliation_status, 'current');

  const writes = statements.filter(({ sql }) => /^(UPDATE|INSERT|DELETE)/.test(sql));
  assert.equal(writes.length, 3);
  const [update, insert, remove] = writes;
  assert.match(update.sql, /SET dedupe_provenance = \$2::jsonb\s+WHERE id = \$1 AND exchange_account_id = \$3 AND source = 'csv'/);
  assert.equal(update.params[0], '20');
  assert.deepEqual(JSON.parse(update.params[1]).map((entry) => entry.external_id), [
    'binanceus:trade:NANOUSD:129629973',
    'binanceus:trade:NANOUSD4:287471',
  ]);
  assert.match(insert.sql, /INSERT INTO exchange_record_dedupe_events/);
  assert.deepEqual(insert.params.slice(0, 5), [3, '20', 'binanceus:trade:NANOUSD4:287471', 'f'.repeat(64), 1]);
  assert.equal(JSON.parse(insert.params[5]).source, 'api');
  assert.match(remove.sql, /DELETE FROM exchange_records\s+WHERE id = \$1 AND exchange_account_id = \$2 AND source = 'api'/);
  assert.deepEqual(remove.params, ['10', 3]);
  assert.deepEqual(recomputed.map(([userId, accountId]) => [userId, accountId]), [[1, 3]]);
  assert.equal(statements.at(-1).sql, 'COMMIT');
});

test('apply refuses an account that is not Binance.US before reading records', async () => {
  const { database, statements } = fakeDatabase({
    candidates: [candidate()],
    account: { id: 3, user_id: 1, name: 'Kraken', exchange: 'kraken', sync_in_progress: false },
  });
  await assert.rejects(run({ userId: 1, accountId: 3, apply: true }, { database }), /not binance_us/);
  assert.equal(statements.filter(({ sql }) => /exchange_records/.test(sql)).length, 0);
  assert.equal(statements.at(-1).sql, 'ROLLBACK');
});

test('apply revalidates a group under lock and aborts if a fill joined it', async () => {
  const planned = group(['10', '11'], ['20', '21']);
  const { database, statements } = fakeDatabase({
    candidates: planned,
    groupRows: [...planned, candidate({ api_id: '12', csv_id: '20' })],
  });
  await assert.rejects(run({ userId: 1, accountId: 3, apply: true }, { database }), /Group api 10\+11 failed revalidation/);
  assert.equal(statements.filter(({ sql }) => /^(UPDATE|INSERT|DELETE)/.test(sql)).length, 0);
  assert.equal(statements.at(-1).sql, 'ROLLBACK');
});
