'use strict';

const {
  UNKNOWN_RECORD_TYPE,
  cleanAmount,
  parseTimestamp,
  contentId,
  makeDupCounter,
  finalizeRecord,
  pickBaseQuote,
  combineFees,
  ImportFormatError,
} = require('./shared');
const { isBlankRow } = require('../../utils/csv');

const FORMAT = 'coinbase_pro';

const COLUMNS = {
  portfolio: ['portfolio'],
  type: ['type'],
  time: ['time'],
  amount: ['amount'],
  balance: ['balance'],
  unit: ['amount/balance unit'],
  transferId: ['transfer id'],
  tradeId: ['trade id'],
  orderId: ['order id'],
};

// 'amount/balance unit' with a 'trade id' is unique to the Coinbase Pro /
// Exchange account statement; nothing else this app reads shares it.
const REQUIRED = ['type', 'time', 'amount', 'unit', 'tradeId'];

// Rows that are not part of a fill map one-to-one.
const TYPE_MAP = {
  deposit: 'deposit',
  withdrawal: 'withdrawal',
  conversion: 'conversion',
  rebate: 'reward',
  interest: 'reward',
  fee: 'fee',
};

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

function rawOf(header, row, line) {
  const raw = { _format: FORMAT, _source_line: line };
  header.forEach((name, col) => {
    const value = String(row[col] ?? '').trim();
    if (value) raw[String(name).trim()] = value;
  });
  return raw;
}

function parse(rows) {
  const found = findHeader(rows);
  if (!found) {
    throw new ImportFormatError('Not a Coinbase Pro account statement.');
  }
  const { index: headerIndex, columns, header } = found;
  const cellOf = (row, key) => (columns[key] === undefined ? '' : String(row[columns[key]] ?? '').trim());

  const parsedRows = [];
  let headerRowsSkipped = 0;

  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const line = i + 1;
    if (isBlankRow(row)) continue;
    if (cellOf(row, 'type').toLowerCase() === 'type' && cellOf(row, 'time').toLowerCase() === 'time') {
      headerRowsSkipped += 1;
      continue;
    }

    const occurredAt = parseTimestamp(cellOf(row, 'time'));
    if (!occurredAt) {
      throw new ImportFormatError(`Line ${line}: could not read the time column ("${cellOf(row, 'time')}")`);
    }

    parsedRows.push({
      line,
      type: cellOf(row, 'type').toLowerCase(),
      occurredAt,
      amount: cleanAmount(cellOf(row, 'amount')),
      asset: cellOf(row, 'unit'),
      portfolio: cellOf(row, 'portfolio'),
      transferId: cellOf(row, 'transferId'),
      tradeId: cellOf(row, 'tradeId'),
      orderId: cellOf(row, 'orderId'),
      raw: rawOf(header, row, line),
    });
  }

  // A fill is spread over three lines: two 'match' legs (what left, what
  // arrived) and, when the taker paid one, a 'fee' line. They share a trade id,
  // and only together do they describe one trade.
  const groups = new Map();
  const singles = [];
  for (const row of parsedRows) {
    if ((row.type === 'match' || row.type === 'fee') && row.tradeId) {
      // Trade ids are only unique within a product, so the order id (a uuid)
      // carries the grouping and the trade id separates partial fills of it.
      const key = `${row.portfolio}|${row.orderId}|${row.tradeId}`;
      if (!groups.has(key)) groups.set(key, { key, order: row.line, rows: [] });
      groups.get(key).rows.push(row);
    } else {
      singles.push(row);
    }
  }

  const dupIndexFor = makeDupCounter();
  const emitted = [];
  let unknownTypes = 0;

  for (const group of groups.values()) {
    const legs = group.rows.filter((row) => row.type === 'match');
    const fees = group.rows.filter((row) => row.type === 'fee');
    const first = group.rows[0];

    let baseLeg = legs[0] ?? first;
    let quoteLeg = null;
    // Exactly two legs is what a fill looks like. Anything else (a one-sided
    // group from a truncated export) still imports, flagged, rather than being
    // reshaped into a trade the exchange never made.
    let needsReview = legs.length !== 2;
    if (legs.length === 2) {
      const picked = pickBaseQuote(legs);
      baseLeg = picked.base;
      quoteLeg = picked.quote;
      needsReview = picked.ambiguous;
    }

    const { asset: feeAsset, amount: feeAmount } = combineFees(
      fees.map((fee) => ({ asset: fee.asset, amount: fee.amount })),
      quoteLeg?.asset ?? null
    );

    const externalId = group.rows[0].orderId
      ? `cbp:trade:${group.rows[0].orderId}:${group.rows[0].tradeId}`
      : `cbp:trade:${group.rows[0].tradeId}`;

    emitted.push({
      order: group.order,
      record: finalizeRecord({
        record_type: 'trade',
        occurred_at: baseLeg.occurredAt,
        base_asset: baseLeg.asset,
        base_amount: baseLeg.amount,
        quote_asset: quoteLeg?.asset ?? null,
        quote_amount: quoteLeg?.amount ?? null,
        fee_asset: feeAmount && feeAmount !== '0' ? feeAsset : null,
        fee_amount: feeAmount && feeAmount !== '0' ? feeAmount : null,
        tx_hash: null,
        address: null,
        external_id: externalId,
        needs_review: needsReview,
        raw: { _format: FORMAT, rows: group.rows.map((row) => row.raw) },
      }, { line: first.line }),
    });
  }

  for (const row of singles) {
    const mapped = TYPE_MAP[row.type];
    const isUnknown = !mapped;
    if (isUnknown) unknownTypes += 1;

    // Transfers carry a uuid; conversions carry no id at all, which is exactly
    // what the content hash exists for.
    const externalId = row.transferId
      ? `cbp:transfer:${row.transferId}`
      : contentId('cbp', [row.occurredAt, row.type, row.asset, row.amount],
        dupIndexFor(`${row.occurredAt}|${row.type}|${row.asset}|${row.amount}`));

    emitted.push({
      order: row.line,
      record: finalizeRecord({
        record_type: mapped ?? UNKNOWN_RECORD_TYPE,
        occurred_at: row.occurredAt,
        base_asset: row.asset,
        base_amount: row.amount,
        quote_asset: null,
        quote_amount: null,
        fee_asset: null,
        fee_amount: null,
        tx_hash: null,
        address: null,
        external_id: externalId,
        needs_review: isUnknown,
        raw: row.raw,
      }, { line: row.line }),
    });
  }

  emitted.sort((a, b) => a.order - b.order);

  return {
    records: emitted.map((entry) => entry.record),
    stats: { headerRowsSkipped, noiseRowsSkipped: 0, unknownTypes },
  };
}

module.exports = { FORMAT, detect, parse, TYPE_MAP };
