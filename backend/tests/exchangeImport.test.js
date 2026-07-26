'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// The fixtures are SYNTHETIC. They copy the structure and the traps of the real
// Coinbase, Coinbase Pro and Kraken exports the importers were built against --
// the preamble and repeated headers, the $-prefixed amounts, the split trade
// legs, the legacy asset codes -- with invented ids, amounts and addresses.
// Real exports are personal financial history and never enter this repository.
const { parseExchangeCsv, ImportFormatError } = require('../src/services/exchangeImport');

const FIXTURES = path.join(__dirname, 'fixtures', 'exchanges');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const byId = (records) => new Map(records.map((record) => [record.external_id, record]));

// --- Coinbase retail -------------------------------------------------------

test('coinbase retail: detected past its preamble and mapped type by type', () => {
  const { format, records, stats } = parseExchangeCsv(fixture('coinbase-retail.csv'));

  assert.equal(format, 'coinbase_retail');
  const records_by_id = byId(records);
  const typeOf = (suffix) => records_by_id.get(`cb:aaaa0000000000000000${suffix}`)?.record_type;

  assert.equal(typeOf('00f1'), 'reward');        // Staking Income
  assert.equal(typeOf('00f2'), 'reward');        // Reward Income
  assert.equal(typeOf('00f3'), 'trade');         // Buy
  assert.equal(typeOf('00f4'), 'trade');         // Advanced Trade Sell
  assert.equal(typeOf('00f5'), 'trade');         // Sell
  assert.equal(typeOf('00f6'), 'conversion');    // Convert
  assert.equal(typeOf('00f7'), 'withdrawal');    // Send
  assert.equal(typeOf('00f8'), 'deposit');       // Receive
  assert.equal(typeOf('00f9'), 'withdrawal');    // Withdrawal
  assert.equal(typeOf('00fa'), 'withdrawal');    // Pro Withdrawal
  assert.equal(typeOf('00fb'), 'withdrawal');    // Exchange Withdrawal
  assert.equal(typeOf('00fc'), 'withdrawal');    // Vault Withdrawal
  assert.equal(typeOf('00fd'), 'deposit');       // Deposit
  assert.equal(typeOf('00fe'), 'deposit');       // Pro Deposit
  assert.equal(typeOf('00ff'), 'deposit');       // Exchange Deposit
  assert.equal(typeOf('0101'), 'transfer');      // Retail Staking Transfer
  assert.equal(typeOf('0102'), 'transfer');      // Retail Unstaking Transfer
  assert.equal(typeOf('0103'), 'transfer');      // Transfer
  assert.equal(typeOf('0104'), 'transfer');      // Retail Eth2 Deprecation

  assert.equal(stats.unknownTypes, 1);
  assert.equal(records.length, 20);
});

test('coinbase retail: repeated header lines are skipped, not imported as rows', () => {
  const { records, stats } = parseExchangeCsv(fixture('coinbase-retail.csv'));

  // Two full header lines and one repeated two-line preamble block sit inside
  // the data. Read as records they would each become a transaction dated
  // "Timestamp" -- or abort the import.
  assert.equal(stats.headerRowsSkipped, 2);
  assert.equal(stats.noiseRowsSkipped, 2);
  assert.equal(records.some((record) => record.base_asset === 'Asset'), false);
  assert.equal(records.some((record) => record.external_id.includes('ID')), false);
});

test('coinbase retail: $-prefixed amounts parse and a trade carries both legs plus fee', () => {
  const records = byId(parseExchangeCsv(fixture('coinbase-retail.csv')).records);

  const buy = records.get('cb:aaaa000000000000000000f3');
  assert.equal(buy.base_asset, 'BTC');
  assert.equal(buy.base_amount, '0.01');
  assert.equal(buy.quote_asset, 'USD');
  // Buying spends the quote currency, whatever sign the export printed.
  assert.equal(buy.quote_amount, '-400.00');
  assert.equal(buy.fee_asset, 'USD');
  assert.equal(buy.fee_amount, '10.00');

  // "-$625.00": the dollar sign sits inside the minus, and the export signs a
  // sale's subtotal the opposite way from a purchase's.
  const sell = records.get('cb:aaaa000000000000000000f4');
  assert.equal(sell.base_amount, '-0.25');
  assert.equal(sell.quote_amount, '625.00');
});

test('coinbase retail: addresses follow the direction of the transfer', () => {
  const records = byId(parseExchangeCsv(fixture('coinbase-retail.csv')).records);

  assert.equal(records.get('cb:aaaa000000000000000000f7').address, '0x00000000000000000000000000000000000000ff');
  assert.equal(records.get('cb:aaaa000000000000000000f8').address, '0x00000000000000000000000000000000000000ee');
  // Some rows name a venue rather than an address; the column is loose enough.
  assert.equal(records.get('cb:aaaa000000000000000000ff').address, 'GDAX');
});

test('coinbase retail: a Convert takes its second leg from the note', () => {
  const convert = byId(parseExchangeCsv(fixture('coinbase-retail.csv')).records)
    .get('cb:aaaa000000000000000000f6');

  assert.equal(convert.record_type, 'conversion');
  assert.equal(convert.base_asset, 'ETH');
  assert.equal(convert.base_amount, '-1.5');
  assert.equal(convert.quote_asset, 'ETH2');
  assert.equal(convert.quote_amount, '1.5');
  assert.equal(convert.needs_review, false);
});

test('an unrecognized row type imports flagged rather than being dropped', () => {
  const { records } = parseExchangeCsv(fixture('coinbase-retail.csv'));
  const unknown = byId(records).get('cb:aaaa00000000000000000105');

  assert.ok(unknown, 'the unknown-type row must still produce a record');
  assert.equal(unknown.needs_review, true);
  assert.equal(unknown.record_type, 'transfer');
  assert.equal(unknown.base_asset, 'ZZZ');
  assert.equal(unknown.base_amount, '12.5');
  // The original wording survives for whoever reviews it.
  assert.equal(unknown.raw['Transaction Type'], 'Quantum Airdrop');
  // Everything else imported clean, so the review queue can reach zero.
  assert.equal(records.filter((record) => record.needs_review).length, 1);
});

// --- Coinbase Pro ----------------------------------------------------------

test('coinbase pro: two match legs and a fee row collapse into one trade', () => {
  const { format, records } = parseExchangeCsv(fixture('coinbase-pro.csv'));
  assert.equal(format, 'coinbase_pro');

  const trade = byId(records).get('cbp:trade:22222222-2222-2222-2222-222222222222:900001');
  assert.equal(trade.record_type, 'trade');
  assert.equal(trade.base_asset, 'ETH');
  assert.equal(trade.base_amount, '0.2500000000000000');
  assert.equal(trade.quote_asset, 'USD');
  assert.equal(trade.quote_amount, '-500.0000000000000000');
  assert.equal(trade.fee_asset, 'USD');
  // Amounts keep the precision the exchange wrote; NUMERIC(38,18) stores
  // '2.50' and '2.5' identically.
  assert.equal(trade.fee_amount, '2.5000000000000000');
  assert.equal(trade.needs_review, false);

  // Three source lines, one record: no leftover leg and no standalone fee.
  assert.equal(records.filter((record) => record.record_type === 'fee').length, 0);
  assert.equal(records.length, 8);
});

test('coinbase pro: a fee-free fill still pairs, and non-fill rows map directly', () => {
  const records = byId(parseExchangeCsv(fixture('coinbase-pro.csv')).records);

  const trade = records.get('cbp:trade:33333333-3333-3333-3333-333333333333:900002');
  assert.equal(trade.base_amount, '-0.1000000000000000');
  assert.equal(trade.quote_amount, '220.0000000000000000');
  assert.equal(trade.fee_amount, null);

  assert.equal(records.get('cbp:transfer:11111111-1111-1111-1111-111111111111').record_type, 'deposit');
  assert.equal(records.get('cbp:transfer:44444444-4444-4444-4444-444444444444').record_type, 'withdrawal');
});

test('coinbase pro: id-less conversion rows get distinct content hashes', () => {
  const { records } = parseExchangeCsv(fixture('coinbase-pro.csv'));
  const conversions = records.filter((record) => record.record_type === 'conversion');

  assert.equal(conversions.length, 2);
  for (const conversion of conversions) {
    assert.match(conversion.external_id, /^cbp:h:[0-9a-f]{40}$/);
  }
  assert.notEqual(conversions[0].external_id, conversions[1].external_id);
});

test('coinbase pro: an unknown row type is flagged, a rebate is income', () => {
  const { records, stats } = parseExchangeCsv(fixture('coinbase-pro.csv'));
  const flagged = records.filter((record) => record.needs_review);

  assert.equal(stats.unknownTypes, 1);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].raw.type, 'quantumsettlement');
  assert.equal(records.filter((record) => record.record_type === 'reward').length, 1);
});

// --- Kraken ----------------------------------------------------------------

test('kraken: the two ledger legs of a trade pair by refid into one record', () => {
  const { format, records } = parseExchangeCsv(fixture('kraken-ledgers.csv'));
  assert.equal(format, 'kraken');

  const trade = byId(records).get('kraken:TTRD00-11111-TTTTTT');
  assert.equal(trade.record_type, 'trade');
  assert.equal(trade.base_asset, 'ETH');
  assert.equal(trade.base_amount, '0.2000000000');
  assert.equal(trade.quote_asset, 'USD');
  assert.equal(trade.quote_amount, '-500.0000');
  // Kraken bills the quote side; the crumb on the ETH leg stays in raw.
  assert.equal(trade.fee_asset, 'USD');
  assert.equal(trade.fee_amount, '1.2500');
  assert.equal(trade.raw.rows.length, 2);

  // 12 ledger lines, 10 events: the trade pair and the spend/receive pair each
  // describe one thing that happened.
  assert.equal(records.length, 10);
});

test('kraken: a staking payout is income, not a deposit', () => {
  const records = byId(parseExchangeCsv(fixture('kraken-ledgers.csv')).records);

  const payout = records.get('kraken:LDDDDD-44444-DDDDDD');
  assert.equal(payout.record_type, 'reward');
  assert.equal(payout.base_asset, 'ETH');
  assert.equal(payout.base_amount, '0.0100000000');

  const earnReward = records.get('kraken:LEEEEE-55555-EEEEEE');
  assert.equal(earnReward.record_type, 'reward');
  assert.equal(earnReward.base_asset, 'ADA');
});

test('kraken: moving a balance into the earn wallet is a transfer, not income', () => {
  const records = byId(parseExchangeCsv(fixture('kraken-ledgers.csv')).records);

  // The pair nets to zero. Counted as rewards they would book the entire
  // allocated principal as income -- twice, once each way.
  assert.equal(records.get('kraken:LFFFFF-66666-FFFFFF').record_type, 'transfer');
  assert.equal(records.get('kraken:LGGGGG-77777-GGGGGG').record_type, 'transfer');
  assert.equal(records.get('kraken:LHHHHH-88888-HHHHHH').record_type, 'transfer');
});

test('kraken: spend and receive sharing a refid become one conversion', () => {
  const conversion = byId(parseExchangeCsv(fixture('kraken-ledgers.csv')).records)
    .get('kraken:TCNV00-55555-CCCCCC');

  assert.equal(conversion.record_type, 'conversion');
  assert.equal(conversion.base_asset, 'SOL');
  assert.equal(conversion.base_amount, '-5.0000000000');
  assert.equal(conversion.quote_asset, 'USD');
  assert.equal(conversion.quote_amount, '500.0000');
  assert.equal(conversion.fee_amount, '1.5000');
});

test('kraken: legacy asset codes and wallet suffixes normalize to one ticker', () => {
  const { records } = parseExchangeCsv(fixture('kraken-ledgers.csv'));
  const assets = new Set(records.map((record) => record.base_asset));

  // ZUSD, XETH, ETH2, ADA.S, XXBT, XDG in the file.
  assert.ok(assets.has('USD'));
  assert.ok(assets.has('ETH'));
  assert.ok(assets.has('ADA'));
  assert.ok(assets.has('BTC'));
  assert.ok(assets.has('DOGE'));
  for (const code of ['ZUSD', 'XETH', 'ETH2', 'ADA.S', 'XXBT', 'XDG']) {
    assert.equal(assets.has(code), false, `${code} should have been normalized`);
  }

  const withdrawal = byId(records).get('kraken:LKKKKK-11111-KKKKKK');
  assert.equal(withdrawal.record_type, 'withdrawal');
  assert.equal(withdrawal.base_asset, 'BTC');
  assert.equal(withdrawal.fee_asset, 'BTC');
  assert.equal(withdrawal.fee_amount, '0.0001000000');
  // amountusd is a valuation, not a leg: it stays in raw rather than becoming a
  // quote amount the exchange never traded.
  assert.equal(withdrawal.quote_amount, null);
  assert.equal(withdrawal.raw.amountusd, '-200.00');
});

test('kraken: an unknown ledger type imports flagged', () => {
  const { records, stats } = parseExchangeCsv(fixture('kraken-ledgers.csv'));
  const unknown = byId(records).get('kraken:LLLLLL-22222-LLLLLL');

  assert.equal(stats.unknownTypes, 1);
  assert.equal(unknown.needs_review, true);
  assert.equal(unknown.record_type, 'transfer');
  assert.equal(unknown.raw.type, 'quantumsettlement');
  assert.equal(records.filter((record) => record.needs_review).length, 1);
});

// --- Generic fallback ------------------------------------------------------

test('generic: an unknown layout with recognizable columns still imports', () => {
  const { format, records } = parseExchangeCsv(fixture('generic.csv'));
  assert.equal(format, 'generic');
  assert.equal(records.length, 6);

  const records_by_id = byId(records);
  const deposit = records_by_id.get('gen:gen-0001');
  assert.equal(deposit.record_type, 'deposit');
  assert.equal(deposit.base_asset, 'BTC');
  assert.equal(deposit.base_amount, '0.5');
  assert.equal(deposit.fee_asset, 'BTC');
  assert.equal(deposit.address, 'bc1qsyntheticfixtureaddress');
  assert.match(deposit.tx_hash, /^0x[0-9a-f]+$/);

  assert.equal(records_by_id.get('gen:gen-0002').record_type, 'reward');
  assert.equal(records_by_id.get('gen:gen-0003').record_type, 'trade');
  assert.equal(records_by_id.get('gen:gen-0003').quote_amount, '2500');
  assert.equal(records_by_id.get('gen:gen-0004').record_type, 'withdrawal');
  assert.equal(records_by_id.get('gen:gen-0005').needs_review, true);

  // The last row carries no id of its own.
  const hashed = records.filter((record) => record.external_id.startsWith('gen:h:'));
  assert.equal(hashed.length, 1);
});

test('an unreadable layout aborts the whole import with a clear error', () => {
  assert.throws(
    () => parseExchangeCsv(fixture('unrecognized.csv')),
    (error) => {
      assert.ok(error instanceof ImportFormatError);
      assert.equal(error.code, 'UNRECOGNIZED_CSV_FORMAT');
      // The message has to say what was wrong AND what the file looked like,
      // or the user has no way to pick a better export.
      assert.match(error.message, /Unrecognized CSV layout/);
      assert.match(error.message, /occurred_at or base_amount/);
      assert.match(error.message, /Ledger Note/);
      return true;
    }
  );
});

test('an empty upload is rejected rather than counted as an empty history', () => {
  assert.throws(() => parseExchangeCsv('   '), /empty/);
});

test('forcing the wrong format fails loudly instead of half-reading the file', () => {
  assert.throws(
    () => parseExchangeCsv(fixture('kraken-ledgers.csv'), { format: 'coinbase_pro' }),
    /Not a Coinbase Pro account statement/
  );
  assert.throws(
    () => parseExchangeCsv(fixture('generic.csv'), { format: 'no-such-format' }),
    /Unknown import format/
  );
});

// --- Idempotence -----------------------------------------------------------

for (const name of ['coinbase-retail.csv', 'coinbase-pro.csv', 'kraken-ledgers.csv', 'generic.csv']) {
  test(`${name}: re-parsing produces the same external ids, and they are unique`, () => {
    const first = parseExchangeCsv(fixture(name)).records.map((record) => record.external_id);
    const second = parseExchangeCsv(fixture(name)).records.map((record) => record.external_id);

    // Content-hashed ids must not drift between runs, or a re-import would
    // insert a second copy of every id-less row.
    assert.deepEqual(first, second);
    assert.equal(new Set(first).size, first.length, 'external ids collide within one file');
    for (const id of first) assert.ok(id.length <= 120, `external id too long: ${id}`);
  });
}

test('a longer re-export keeps the ids the earlier one produced', () => {
  const full = fixture('generic.csv');
  const lines = full.trim().split('\n');
  // What the user uploaded last month: the same file, minus its newest rows.
  const earlier = [lines[0], ...lines.slice(1, 4)].join('\n');

  const before = parseExchangeCsv(earlier).records.map((record) => record.external_id);
  const after = parseExchangeCsv(full).records.map((record) => record.external_id);

  assert.deepEqual(after.slice(0, before.length), before);
});
