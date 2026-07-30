'use strict';

const {
  UNKNOWN_RECORD_TYPE,
  absAmount,
  contentId,
  makeDupCounter,
  finalizeRecord,
  pickBaseQuote,
  combineFees,
} = require('./shared');

// The Kraken ledger IS the same ledger whether it arrives as a CSV export or
// over POST /0/private/Ledgers -- same entry ids, same refids, same double
// entry. So both readers normalize their rows into one shape and hand them
// here, and the records that come out are byte-identical between the two
// sources.
//
// That is not tidiness, it is the dedupe contract: exchange_records is keyed
// UNIQUE (exchange_account_id, external_id), so an API backfill followed by a
// CSV upload of the same period only stays duplicate-free while both paths
// build external_id the same way. Two copies of this logic would drift, and
// the first sign of it would be a doubled balance.
//
// A normalized row:
//   { line, txid, refid, occurredAt, type, subtype, asset,
//     amountCell, amount, fee, raw, txHash?, address? }
// where `txid` is the LEDGER ENTRY id (the CSV's txid column; the map key in
// the REST response) and `refid` is the parent transaction's id.

// Kraken's legacy asset codes. ETH2 was the pre-merge staked-ETH ticker and is
// the same asset today; leaving it distinct would split one ETH position in
// two. Undocumented but empirically stable -- Kraken's own Balance example
// (https://docs.kraken.com/api/docs/rest-api/get-account-balance) shows XETH,
// ETH2 and ETH2.S side by side in one response.
const ASSET_MAP = {
  XETH: 'ETH',
  XXBT: 'BTC',
  XBT: 'BTC',
  ZUSD: 'USD',
  ETH2: 'ETH',
  XXDG: 'DOGE',
  XDG: 'DOGE',
};

// .S staked, .M opt-in rewards, .P parachain are documented
// (https://support.kraken.com/articles/360039879471-what-is-asset-s-and-asset-m-);
// .F (Kraken Rewards) and .B (bonded) are not, which is exactly why this
// strips ANY single-letter suffix rather than an allowlist. A suffix Kraken
// adds next year must not silently split a position in two.
const SUFFIX = /\.[A-Z]$/;

// 'allocation'/'autoallocation' move a balance between the spot and earn
// wallets. They are NOT income: they are signed both ways and cancel out, so
// counting them as rewards would inflate income by the whole allocated
// principal. Only the payout rows are rewards.
const EARN_MOVEMENT_SUBTYPES = new Set(['allocation', 'autoallocation', 'deallocation', 'migration']);

// The ledger row types that describe half of a two-legged event and are paired
// by refid. Their record's identity is the refid, whether or not the source
// happens to hold both legs.
//
// Deliberately narrow. The REST response enum also carries nfttrade and sale,
// whose leg structure is not documented anywhere Kraken publishes; pairing
// them on a guess would fuse two unrelated rows into one trade. They fall
// through to the single-row path and are flagged instead.
const PAIRED_ROW_TYPES = new Set(['trade', 'spend', 'receive']);

function normalizeAsset(raw) {
  let asset = String(raw ?? '').trim().toUpperCase();
  if (!asset) return null;
  asset = asset.replace(SUFFIX, '');
  if (ASSET_MAP[asset]) return ASSET_MAP[asset];
  // Legacy four-character codes: X<crypto>, Z<fiat> (XLTC, ZEUR). Three-letter
  // tickers are left alone, so ADA and DOT are untouched.
  if (/^[XZ][A-Z]{3}$/.test(asset)) return asset.slice(1);
  return asset;
}

// Row type -> record type for rows that stand alone. Paired rows (trade legs,
// spend/receive) never reach this.
//
// The two sources speak DIFFERENT vocabularies for the same ledger, which is
// the single nastiest thing about this integration:
//   - the CSV export writes `earn` with subtype allocation/autoallocation/
//     reward; `earn` does not exist in the REST API at all.
//   - the REST response writes `staking`, `reward`, `transfer` (with subtypes
//     spottostaking / stakingfromspot / ...), plus seven types that cannot
//     even be requested as a filter: spend, receive, reward, conversion,
//     nfttrade, nftcreatorfee, custodytransfer.
// Both vocabularies are handled here so one table covers both readers. Types
// enumerated from
// https://docs.kraken.com/api/docs/rest-api/get-ledgers-info and
// https://support.kraken.com/articles/360001169383-how-to-interpret-ledger-history-fields
function mapRowType(type, subtype) {
  switch (type) {
    case 'deposit': return 'deposit';
    case 'withdrawal': return 'withdrawal';
    case 'transfer': return 'transfer';
    case 'staking': return 'reward';
    case 'reward': return 'reward';
    case 'dividend': return 'reward';
    // Creator royalties and rebates are received income, not a position change.
    case 'nftrebate': case 'nftcreatorfee': return 'reward';
    // CSV-only spelling. Its allocation subtypes are wallet moves, not income.
    case 'earn': return EARN_MOVEMENT_SUBTYPES.has(subtype) ? 'transfer' : 'reward';
    case 'trade': return 'trade';
    case 'spend': case 'receive': return 'conversion';
    // REST-only: Kraken's own instant-convert product.
    case 'conversion': return 'conversion';
    case 'adjustment': case 'rollover': case 'settled': case 'margin': return 'transfer';
    // REST-only. credit is a Kraken credit line movement and custodytransfer a
    // move between custody surfaces; both move value without changing what is
    // owned, which is what 'transfer' already means here.
    case 'credit': case 'custodytransfer': return 'transfer';
    // 'none' is literally the absence of a type. Naming it would be inventing
    // meaning, so it goes to the review queue with everything else unknown.
    default: return null;
  }
}

/**
 * Normalized ledger rows -> exchange_records rows.
 *
 * @param {Array<object>} parsedRows rows in the shape described above
 * @returns {{records: Array<object>, unknownTypes: number}}
 */
function buildRecords(parsedRows) {
  // The ledger is double entry: a trade is two rows (asset out, asset in)
  // sharing a refid, and a Kraken "convert" is a spend row plus a receive row
  // sharing one. Read row-by-row, a single trade would become two unrelated
  // transfers and its direction would be lost.
  const groups = new Map();
  for (const row of parsedRows) {
    const key = row.refid || `__solo__${row.line}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const dupIndexFor = makeDupCounter();
  const emitted = [];
  let unknownTypes = 0;

  const hashIdFor = (row) => contentId(
    'kraken', [row.occurredAt, row.type, row.asset, row.amount],
    dupIndexFor(`${row.occurredAt}|${row.type}|${row.asset}|${row.amount}`)
  );

  // A row that stands alone is identified by its own ledger entry id. A
  // widowed leg of a two-legged event is NOT: it is identified by the refid,
  // the same key the complete pair will carry. Keying the half record on its
  // entry id and the whole one on the refid is what let a date-limited export
  // and a full one both land, counting the same trade twice.
  //
  // `solo` says the widowed leg is the only paired-type row under that refid.
  // In the degenerate case where several are (a shape Kraken does not write),
  // the entry id goes back into the key so the rows cannot collide.
  const externalIdFor = (row, { solo = false } = {}) => {
    if (PAIRED_ROW_TYPES.has(row.type) && row.refid) {
      return solo ? `kraken:${row.refid}` : `kraken:${row.refid}:${row.txid || row.line}`;
    }
    return row.txid ? `kraken:${row.txid}` : hashIdFor(row);
  };

  const emitSingle = (row, { solo = false } = {}) => {
    const mapped = mapRowType(row.type, row.subtype);
    if (!mapped) unknownTypes += 1;
    // An unpaired trade or spend/receive leg is half an event: the record is
    // kept (the money moved) but flagged, because its counter-leg is missing.
    const unpaired = PAIRED_ROW_TYPES.has(row.type);
    emitted.push({
      order: row.line,
      record: finalizeRecord({
        record_type: mapped ?? UNKNOWN_RECORD_TYPE,
        occurred_at: row.occurredAt,
        base_asset: row.asset,
        base_amount: row.amount,
        quote_asset: null,
        quote_amount: null,
        fee_asset: row.fee && row.fee !== '0' ? row.asset : null,
        fee_amount: row.fee && row.fee !== '0' ? absAmount(row.fee) : null,
        // Only ever set by the API reader: the CSV ledgers export carries no
        // network id or destination at all. Both stay null on the CSV path.
        tx_hash: row.txHash ?? null,
        address: row.address ?? null,
        network: row.network ?? null,
        chain_id: null,
        external_id: externalIdFor(row, { solo }),
        needs_review: !mapped || unpaired,
        raw: row.raw,
      }, { line: row.line, amountCell: row.amountCell }),
    });
  };

  const emitPaired = (recordType, legs) => {
    const picked = pickBaseQuote(legs);
    const { base, quote } = picked;
    const needsReview = picked.ambiguous;

    const { asset: feeAsset, amount: feeAmount } = combineFees(
      legs.map((leg) => ({ asset: leg.asset, amount: leg.fee })),
      quote.asset
    );

    const first = legs.reduce((earliest, leg) => (leg.line < earliest.line ? leg : earliest), legs[0]);
    emitted.push({
      order: first.line,
      record: finalizeRecord({
        record_type: recordType,
        occurred_at: first.occurredAt,
        base_asset: base.asset,
        base_amount: base.amount,
        quote_asset: quote.asset,
        quote_amount: quote.amount,
        fee_asset: feeAsset,
        fee_amount: feeAmount,
        tx_hash: null,
        address: null,
        network: null,
        chain_id: null,
        external_id: `kraken:${first.refid}`,
        needs_review: needsReview,
        raw: { _format: 'kraken', rows: legs.map((leg) => leg.raw) },
      }, { line: first.line, amountCell: legs.map((leg) => leg.amountCell) }),
    });
  };

  for (const group of groups.values()) {
    const types = new Set(group.map((row) => row.type));
    if (group.length === 2 && types.size === 1 && types.has('trade')) {
      emitPaired('trade', group);
    } else if (group.length === 2 && types.size === 2 && types.has('spend') && types.has('receive')) {
      // Base/quote are picked by asset the same way a trade's are, so a
      // convert and the equivalent trade describe the position identically.
      const spend = group.find((row) => row.type === 'spend');
      const receive = group.find((row) => row.type === 'receive');
      emitPaired('conversion', [spend, receive]);
    } else {
      const paired = group.filter((row) => PAIRED_ROW_TYPES.has(row.type));
      for (const row of group) emitSingle(row, { solo: paired.length === 1 });
    }
  }

  emitted.sort((a, b) => a.order - b.order);

  return { records: emitted.map((entry) => entry.record), unknownTypes };
}

module.exports = {
  ASSET_MAP,
  EARN_MOVEMENT_SUBTYPES,
  PAIRED_ROW_TYPES,
  normalizeAsset,
  mapRowType,
  buildRecords,
};
