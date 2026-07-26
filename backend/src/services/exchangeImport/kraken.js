'use strict';

const {
  UNKNOWN_RECORD_TYPE,
  cleanAmount,
  absAmount,
  parseTimestamp,
  contentId,
  makeDupCounter,
  finalizeRecord,
  pickBaseQuote,
  combineFees,
  ImportFormatError,
} = require('./shared');
const { isBlankRow } = require('../../utils/csv');

const FORMAT = 'kraken';

const COLUMNS = {
  txid: ['txid'],
  refid: ['refid'],
  time: ['time'],
  type: ['type'],
  subtype: ['subtype'],
  aclass: ['aclass'],
  subclass: ['subclass'],
  asset: ['asset'],
  wallet: ['wallet'],
  amount: ['amount'],
  fee: ['fee'],
  balance: ['balance'],
  amountusd: ['amountusd'],
};

const REQUIRED = ['txid', 'refid', 'time', 'type', 'asset', 'amount'];

// Kraken's legacy asset codes. ETH2 was the pre-merge staked-ETH ticker and is
// the same asset today; leaving it distinct would split one ETH position in two.
const ASSET_MAP = {
  XETH: 'ETH',
  XXBT: 'BTC',
  XBT: 'BTC',
  ZUSD: 'USD',
  ETH2: 'ETH',
  XXDG: 'DOGE',
  XDG: 'DOGE',
};

// .S staked, .M opt-in rewards, .F Kraken Rewards, .B bonded, .P parachain.
// All of them are the same underlying asset in a different Kraken wallet.
const SUFFIX = /\.(S|M|F|B|P)$/;

// 'allocation'/'autoallocation' move a balance between the spot and earn
// wallets. They are NOT income: they are signed both ways and cancel out, so
// counting them as rewards would inflate income by the whole allocated
// principal. Only the payout rows are rewards.
const EARN_MOVEMENT_SUBTYPES = new Set(['allocation', 'autoallocation', 'deallocation', 'migration']);

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

function resolveColumns(header) {
  const index = new Map(header.map((cell, i) => [String(cell ?? '').trim().toLowerCase(), i]));
  const resolved = {};
  for (const [key, candidates] of Object.entries(COLUMNS)) {
    for (const candidate of candidates) {
      const found = index.get(candidate);
      if (found !== undefined) { resolved[key] = found; break; }
    }
  }
  return resolved;
}

function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i += 1) {
    if (isBlankRow(rows[i])) continue;
    const resolved = resolveColumns(rows[i]);
    if (REQUIRED.every((key) => resolved[key] !== undefined)) {
      return { index: i, columns: resolved, header: rows[i] };
    }
  }
  return null;
}

function detect(rows) {
  return findHeader(rows) !== null;
}

// Row type -> record type for rows that stand alone. Paired rows (trade legs,
// spend/receive) never reach this.
function mapRowType(type, subtype) {
  switch (type) {
    case 'deposit': return 'deposit';
    case 'withdrawal': return 'withdrawal';
    case 'transfer': return 'transfer';
    case 'staking': return 'reward';
    case 'earn': return EARN_MOVEMENT_SUBTYPES.has(subtype) ? 'transfer' : 'reward';
    case 'trade': return 'trade';
    case 'spend': case 'receive': return 'conversion';
    case 'adjustment': case 'rollover': case 'settled': case 'margin': return 'transfer';
    default: return null;
  }
}

function parse(rows) {
  const found = findHeader(rows);
  if (!found) {
    throw new ImportFormatError('Not a Kraken ledgers export.');
  }
  const { index: headerIndex, columns, header } = found;
  const cellOf = (row, key) => (columns[key] === undefined ? '' : String(row[columns[key]] ?? '').trim());

  const parsedRows = [];
  let headerRowsSkipped = 0;

  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const line = i + 1;
    if (isBlankRow(row)) continue;
    if (cellOf(row, 'txid').toLowerCase() === 'txid' && cellOf(row, 'refid').toLowerCase() === 'refid') {
      headerRowsSkipped += 1;
      continue;
    }

    const occurredAt = parseTimestamp(cellOf(row, 'time'));
    if (!occurredAt) {
      throw new ImportFormatError(`Line ${line}: could not read the time column ("${cellOf(row, 'time')}")`);
    }

    const raw = { _format: FORMAT, _source_line: line };
    header.forEach((name, col) => {
      const value = String(row[col] ?? '').trim();
      if (value) raw[String(name).trim()] = value;
    });

    parsedRows.push({
      line,
      txid: cellOf(row, 'txid'),
      refid: cellOf(row, 'refid'),
      occurredAt,
      type: cellOf(row, 'type').toLowerCase(),
      subtype: cellOf(row, 'subtype').toLowerCase(),
      asset: normalizeAsset(cellOf(row, 'asset')),
      amount: cleanAmount(cellOf(row, 'amount')),
      fee: cleanAmount(cellOf(row, 'fee')),
      raw,
    });
  }

  // The ledger is double entry: a trade is two rows (asset out, asset in)
  // sharing a refid, and a Kraken "convert" is a spend row plus a receive row
  // sharing one. Imported row-by-row, a single trade would read as two
  // unrelated transfers and its direction would be lost.
  const groups = new Map();
  for (const row of parsedRows) {
    const key = row.refid || `__solo__${row.line}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const dupIndexFor = makeDupCounter();
  const emitted = [];
  let unknownTypes = 0;

  const externalIdFor = (row) => (row.txid
    ? `kraken:${row.txid}`
    : contentId('kraken', [row.occurredAt, row.type, row.asset, row.amount],
      dupIndexFor(`${row.occurredAt}|${row.type}|${row.asset}|${row.amount}`)));

  const emitSingle = (row) => {
    const mapped = mapRowType(row.type, row.subtype);
    if (!mapped) unknownTypes += 1;
    // An unpaired trade or spend/receive leg is half an event: the record is
    // kept (the money moved) but flagged, because its counter-leg is missing.
    const unpaired = mapped === 'trade' || mapped === 'conversion';
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
        tx_hash: null,
        address: null,
        external_id: externalIdFor(row),
        needs_review: !mapped || unpaired,
        raw: row.raw,
      }, { line: row.line }),
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
        external_id: `kraken:${first.refid}`,
        needs_review: needsReview,
        raw: { _format: FORMAT, rows: legs.map((leg) => leg.raw) },
      }, { line: first.line }),
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
      for (const row of group) emitSingle(row);
    }
  }

  emitted.sort((a, b) => a.order - b.order);

  return {
    records: emitted.map((entry) => entry.record),
    stats: { headerRowsSkipped, noiseRowsSkipped: 0, unknownTypes },
  };
}

module.exports = { FORMAT, detect, parse, normalizeAsset };
