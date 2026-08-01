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
const { cleanAmount, parseTimestamp } = require('../src/services/exchangeImport/shared');

const FIXTURES = path.join(__dirname, 'fixtures', 'exchanges');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const byId = (records) => new Map(records.map((record) => [record.external_id, record]));

// A file the user uploaded before the exchange's export covered everything:
// the same rows, minus the ones named here.
const withoutLines = (text, predicate) => text
  .split('\n')
  .filter((line, index) => index === 0 || !predicate(line))
  .join('\n');

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
  assert.equal(typeOf('00fd'), 'deposit');       // Deposit
  assert.equal(typeOf('0101'), 'transfer');      // Retail Staking Transfer
  assert.equal(typeOf('0102'), 'transfer');      // Retail Unstaking Transfer
  assert.equal(typeOf('0103'), 'transfer');      // Transfer
  assert.equal(typeOf('0104'), 'transfer');      // Retail Eth2 Deprecation

  assert.equal(stats.unknownTypes, 1);
  assert.equal(records.length, 23);
});

test('coinbase retail: the moves between Coinbase surfaces are transfers, whatever they are called', () => {
  const { records } = parseExchangeCsv(fixture('coinbase-retail.csv'));
  const records_by_id = byId(records);
  const recordOf = (suffix) => records_by_id.get(`cb:aaaa0000000000000000${suffix}`);

  // Coinbase names these from the DESTINATION's point of view and then signs
  // the row the other way: an "Exchange Deposit" is money LEAVING retail. Taken
  // at their word they book a withdrawal as a deposit and back again.
  for (const [suffix, label] of [
    ['00fa', 'Pro Withdrawal'], ['00fb', 'Exchange Withdrawal'], ['00fc', 'Vault Withdrawal'],
    ['00fe', 'Pro Deposit'], ['00ff', 'Exchange Deposit'],
  ]) {
    assert.equal(recordOf(suffix).record_type, 'transfer', `${label} must not claim a direction`);
    assert.equal(recordOf(suffix).needs_review, false, `${label} is understood, not a mystery`);
  }

  // The sign is what carries direction now, and it has to stay readable.
  assert.equal(recordOf('00fb').base_amount, '120');    // out of Pro, into retail
  assert.equal(recordOf('00ff').base_amount, '-300');   // out of retail, into Pro

  // The property that broke: nothing typed as a deposit may be negative, and
  // nothing typed as a withdrawal may be positive.
  for (const record of records) {
    if (record.record_type === 'deposit' && record.base_amount !== null) {
      assert.ok(!record.base_amount.startsWith('-'), `deposit ${record.external_id} is negative`);
    }
    if (record.record_type === 'withdrawal' && record.base_amount !== null) {
      assert.ok(record.base_amount.startsWith('-'), `withdrawal ${record.external_id} is positive`);
    }
  }
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

test('coinbase retail: a Convert\'s two ledger rows become one conversion', () => {
  const { records } = parseExchangeCsv(fixture('coinbase-retail.csv'));
  const convert = byId(records).get('cb:aaaa000000000000000000f6');

  assert.equal(convert.record_type, 'conversion');
  assert.equal(convert.base_asset, 'ETH');
  assert.equal(convert.base_amount, '-1.5');
  assert.equal(convert.quote_asset, 'ETH2');
  assert.equal(convert.quote_amount, '1.5');
  assert.equal(convert.needs_review, false);
  // The export bills whichever leg it feels like -- here the receiving one,
  // which used to be the row that got dropped, taking the fee with it.
  assert.equal(convert.fee_asset, 'USD');
  assert.equal(convert.fee_amount, '0.25');
  // The counter-leg's own id is kept: it is the only trace of that ledger line.
  assert.equal(convert.raw._paired_id, 'aaaa000000000000000000e6');

  // The bug this replaces: the note was applied to BOTH rows, so the second one
  // became a conversion of an asset into itself.
  assert.equal(records.filter((record) => record.external_id === 'cb:aaaa000000000000000000e6').length, 0);
  for (const record of records) {
    assert.ok(
      !(record.base_asset && record.base_asset === record.quote_asset),
      `${record.external_id} converts ${record.base_asset} into itself`
    );
  }
});

test('coinbase retail: a Convert leg with no counter-leg imports alone, flagged', () => {
  const orphan = byId(parseExchangeCsv(fixture('coinbase-retail.csv')).records)
    .get('cb:aaaa00000000000000000106');

  assert.equal(orphan.record_type, 'conversion');
  assert.equal(orphan.base_asset, 'SOL');
  assert.equal(orphan.base_amount, '-2');
  // The note names an ETH leg that is nowhere in this file. Reading the note's
  // own numbers back as the counter-leg would invent a position.
  assert.equal(orphan.quote_asset, null);
  assert.equal(orphan.quote_amount, null);
  assert.equal(orphan.needs_review, true);
});

test('coinbase retail: an amount the importer cannot read is flagged, never zero', () => {
  const records = byId(parseExchangeCsv(fixture('coinbase-retail.csv')).records);

  // Dust written in scientific notation, expanded digit by digit: a float
  // round-trip would round it and a failed parse would silently store nothing.
  const dust = records.get('cb:aaaa00000000000000000107');
  assert.equal(dust.base_amount, '0.000000015');
  assert.equal(dust.needs_review, false);

  // "1,5" is 1.5 in half of Europe and 15 with a thousands separator. Neither
  // reading is safe, so the cell does not become a number at all.
  const ambiguous = records.get('cb:aaaa00000000000000000108');
  assert.equal(ambiguous.base_amount, null);
  assert.equal(ambiguous.needs_review, true);
  assert.equal(ambiguous.raw['Quantity Transacted'], '1,5');
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
  // The unknown type, the widowed Convert leg and the unreadable amount -- and
  // nothing else, so the review queue can still reach zero.
  assert.equal(records.filter((record) => record.needs_review).length, 3);
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

  // Three source lines, one record: no leftover leg, and the fee row did not
  // survive as a record of its own beside the trade it belongs to.
  assert.equal(records.filter((record) => record.raw?.rows?.some((row) => row['trade id'] === '900001')).length, 1);
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

test('coinbase pro: the two legs of an id-less conversion become one record', () => {
  const { records } = parseExchangeCsv(fixture('coinbase-pro.csv'));
  const conversions = records.filter((record) => record.record_type === 'conversion');

  // Two rows, no id on either, same portfolio and instant, opposite signs.
  // Apart they each lose the only thing that says what the balance became.
  assert.equal(conversions.length, 1);
  const [conversion] = conversions;
  assert.match(conversion.external_id, /^cbp:h:[0-9a-f]{40}$/);
  assert.equal(conversion.base_asset, 'USDC');
  assert.equal(conversion.base_amount, '-100.0000000000000000');
  assert.equal(conversion.quote_asset, 'USD');
  assert.equal(conversion.quote_amount, '100.0000000000000000');
  assert.equal(conversion.needs_review, false);
});

test('coinbase pro: a widowed conversion leg keys the same id the pair will', () => {
  const full = fixture('coinbase-pro.csv');
  // The export the user pulled first stopped before the incoming leg.
  const partial = withoutLines(full, (line) => /^default,conversion,.*,USD,/.test(line));

  const widowed = parseExchangeCsv(partial).records.filter((record) => record.record_type === 'conversion');
  const complete = parseExchangeCsv(full).records.filter((record) => record.record_type === 'conversion');

  assert.equal(widowed.length, 1);
  assert.equal(widowed[0].needs_review, true, 'half a conversion is not a conversion');
  assert.equal(widowed[0].quote_asset, null);
  // Same event, same id -- the upgrade in ExchangeRecord depends on it.
  assert.equal(widowed[0].external_id, complete[0].external_id);
});

test('coinbase pro: a group of nothing but fee rows is a fee, not a trade', () => {
  const { records } = parseExchangeCsv(fixture('coinbase-pro.csv'));
  // A fee row whose order id is blank forms a group of its own. Shaped into a
  // trade it claimed a fill that appears nowhere in the file, unflagged.
  const orphanFee = byId(records).get('cbp:trade:default:900003');

  assert.equal(orphanFee.record_type, 'fee');
  assert.equal(orphanFee.needs_review, true);
  assert.equal(orphanFee.fee_asset, 'USD');
  assert.equal(orphanFee.fee_amount, '0.5000000000000000');
  assert.equal(orphanFee.quote_asset, null);
});

test('coinbase pro: a widowed match leg keys the same id the whole fill will', () => {
  const full = fixture('coinbase-pro.csv');
  // Trade 900001's USD leg is missing from the shorter export.
  const partial = withoutLines(full, (line) => /^default,match,.*,-500\.0+,/.test(line));

  const widowed = byId(parseExchangeCsv(partial).records)
    .get('cbp:trade:22222222-2222-2222-2222-222222222222:900001');
  const complete = byId(parseExchangeCsv(full).records)
    .get('cbp:trade:22222222-2222-2222-2222-222222222222:900001');

  assert.ok(widowed, 'the surviving leg still imports');
  assert.equal(widowed.needs_review, true);
  assert.equal(widowed.quote_asset, null);
  assert.equal(complete.needs_review, false);
  assert.equal(complete.quote_asset, 'USD');
});

test('coinbase pro: an unknown row type is flagged, a rebate is income', () => {
  const { records, stats } = parseExchangeCsv(fixture('coinbase-pro.csv'));
  const flagged = records.filter((record) => record.needs_review);

  assert.equal(stats.unknownTypes, 1);
  // The unknown type and the orphaned fee row.
  assert.equal(flagged.length, 2);
  assert.ok(flagged.some((record) => record.raw.type === 'quantumsettlement'));
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

  // 13 ledger lines, 11 events: the trade pair and the spend/receive pair each
  // describe one thing that happened.
  assert.equal(records.length, 11);
});

test('kraken: a widowed trade leg keys the refid, the same id the pair will', () => {
  const full = fixture('kraken-ledgers.csv');
  const records = byId(parseExchangeCsv(full).records);

  // The counter-leg of TTRD99 is outside this export's date range.
  const widowed = records.get('kraken:TTRD99-99999-WWWWWW');
  assert.ok(widowed, 'a lone leg is kept -- the money did move');
  assert.equal(widowed.record_type, 'trade');
  assert.equal(widowed.needs_review, true);
  assert.equal(widowed.quote_asset, null);
  // Keyed on its txid instead, the fuller export's paired record -- keyed on
  // the refid -- would land beside it and the trade would be counted twice.
  assert.equal(records.has('kraken:LMMMMM-33333-MMMMMM'), false);

  // The same holds for a pair whose second leg this file happens to hold: the
  // id does not change when the counter-leg shows up.
  const partial = withoutLines(full, (line) => line.includes('"LCCCCC-33333-CCCCCC"'));
  const half = byId(parseExchangeCsv(partial).records).get('kraken:TTRD00-11111-TTTTTT');
  assert.equal(half.needs_review, true);
  assert.equal(half.quote_asset, null);
  assert.equal(records.get('kraken:TTRD00-11111-TTTTTT').needs_review, false);
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
  // The unknown type and the widowed trade leg.
  assert.equal(records.filter((record) => record.needs_review).length, 2);
});

// --- Binance.US account activity ------------------------------------------

test('Binance.US: account activity export uses realized amount columns and maps each row', () => {
  const { format, records, stats } = parseExchangeCsv(fixture('binance-us.csv'));
  assert.equal(format, 'binance_us');
  assert.equal(records.length, 6);
  assert.equal(stats.unknownTypes, 1);

  const recordsById = byId(records);
  const deposit = recordsById.get('binanceus:deposit:100000001');
  assert.equal(deposit.record_type, 'deposit');
  assert.equal(deposit.base_asset, 'ETH');
  assert.equal(deposit.base_amount, '1.25');

  const buy = recordsById.get('binanceus:trade:SOLUSD:100000002');
  assert.equal(buy.record_type, 'trade');
  assert.equal(buy.base_amount, '2.5');
  assert.equal(buy.quote_asset, 'USD');
  assert.equal(buy.quote_amount, '-350');
  assert.equal(buy.fee_asset, 'SOL');
  assert.equal(buy.fee_amount, '0.002');

  const sell = recordsById.get('binanceus:trade:SOLUSD:100000003');
  assert.equal(sell.base_amount, '-1.5');
  assert.equal(sell.quote_amount, '225');
  assert.equal(sell.fee_asset, 'USD');

  const reward = recordsById.get('binanceus:distribution:100000004');
  assert.equal(reward.record_type, 'reward');
  assert.equal(reward.base_amount, '0.01');

  const withdrawal = recordsById.get('binanceus:withdrawal:100000005');
  assert.equal(withdrawal.record_type, 'withdrawal');
  assert.equal(withdrawal.base_amount, '-0.75');
  assert.equal(withdrawal.fee_asset, 'ETH');
  assert.equal(withdrawal.fee_amount, '0.001');

  const unknown = recordsById.get('binanceus:csv:100000006');
  assert.equal(unknown.record_type, 'transfer');
  assert.equal(unknown.needs_review, true);
  assert.equal(unknown.base_asset, 'USDT');
  assert.equal(unknown.base_amount, '10');
});

test('Binance.US: account activity export is idempotent and preserves raw source cells', () => {
  const text = fixture('binance-us.csv');
  const first = parseExchangeCsv(text).records;
  const second = parseExchangeCsv(text).records;
  assert.deepEqual(
    second.map((record) => record.external_id),
    first.map((record) => record.external_id)
  );
  assert.equal(new Set(first.map((record) => record.external_id)).size, first.length);
  assert.equal(first[1].raw['Realized Amount For Base Asset'], '2.5');
  assert.equal(first[1].raw['Realized Amount for Quote Asset'], '350');
  assert.equal(first[1].raw._source, 'csv');
});

// --- Amounts and timestamps ------------------------------------------------

test('amounts are read exactly, or not at all', () => {
  // Scientific notation, expanded by moving the point through the digits.
  assert.equal(cleanAmount('1.5e-8'), '0.000000015');
  assert.equal(cleanAmount('1.5E8'), '150000000');
  assert.equal(cleanAmount('-2.5e-3'), '-0.0025');
  assert.equal(cleanAmount('1e-18'), '0.000000000000000001');

  // Past a float's 15 significant digits, which is the whole point: Number()
  // would round this and the stored balance would be wrong.
  assert.equal(cleanAmount('1234567890123456789e-6'), '1234567890123.456789');
  assert.equal(cleanAmount('9.999999999999999999e-1'), '0.9999999999999999999');

  // A comma with no point could be either separator; neither guess is safe.
  assert.equal(cleanAmount('1,5'), null);
  assert.equal(cleanAmount('1,234'), null);
  // With a decimal point the comma can only be grouping.
  assert.equal(cleanAmount('$1,234.56'), '1234.56');

  assert.equal(cleanAmount(''), null);
  assert.equal(cleanAmount('n/a'), null);
  assert.equal(cleanAmount('1e'), null);
});

test('a timestamp with no zone is UTC, whatever the host thinks', () => {
  // ISO with an explicit zone is taken at its word.
  assert.equal(parseTimestamp('2024-02-02T12:00:00.000Z'), '2024-02-02T12:00:00.000Z');
  assert.equal(parseTimestamp('2026-07-24 20:13:04 UTC'), '2026-07-24T20:13:04.000Z');
  assert.equal(parseTimestamp('2020-03-04 03:58:53'), '2020-03-04T03:58:53.000Z');

  // The formats that fall through to the Date constructor used to be read as
  // server-local. occurred_at feeds the content hash that ids rows the exchange
  // left unidentified, so the same file produced different ids in different
  // time zones -- and, re-imported, a second copy of every one of them.
  assert.equal(parseTimestamp('03/04/2020 03:58:53'), '2020-03-04T03:58:53.000Z');
  assert.equal(parseTimestamp('Mar 4, 2020 03:58:53'), '2020-03-04T03:58:53.000Z');
  // A date with no clock at all is still midnight UTC.
  assert.equal(parseTimestamp('2020-03-04'), '2020-03-04T00:00:00.000Z');
  // An explicit offset still wins.
  assert.equal(parseTimestamp('2020-03-04T03:58:53+02:00'), '2020-03-04T01:58:53.000Z');

  assert.equal(parseTimestamp('not a date'), null);
  assert.equal(parseTimestamp(''), null);
});

test('addresses are stored one way, so a withdrawal can find its on-chain deposit', () => {
  const csv = [
    'time,type,asset,amount,address',
    '2024-05-01T00:00:00Z,withdrawal,ETH,-1,0xAABBCCDDEEFF00112233445566778899AABBCCDD',
    '2024-05-02T00:00:00Z,withdrawal,ETH,-2,aabbccddeeff00112233445566778899aabbccdd',
    '2024-05-03T00:00:00Z,withdrawal,BTC,-3,bc1qSyntheticFixtureAddress',
  ].join('\n');

  const [checksummed, bare, notHex] = parseExchangeCsv(csv).records;
  // eth_transfers holds lowercase 0x-prefixed addresses; anything else joins to
  // nothing, which reads as "this withdrawal never arrived anywhere".
  assert.equal(checksummed.address, '0xaabbccddeeff00112233445566778899aabbccdd');
  assert.equal(bare.address, '0xaabbccddeeff00112233445566778899aabbccdd');
  // A venue name or a bech32 address is left exactly as the exchange wrote it.
  assert.equal(notHex.address, 'bc1qSyntheticFixtureAddress');
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
