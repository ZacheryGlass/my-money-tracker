'use strict';

const {
  UNKNOWN_RECORD_TYPE,
  cleanAmount,
  isNegativeAmount,
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
  // Present in some statement variants; used only to keep an id-less trade key
  // unique, so its absence costs nothing.
  product: ['product', 'product id'],
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

// The id of the FILL, not of the rows that happened to be in this file. A
// truncated export that holds one leg of a fill must key it exactly the way the
// complete export will, or the fuller import lands beside the half record
// instead of replacing it. Trade ids repeat across products, so the order id (a
// uuid) carries the grouping; when the statement leaves it blank, the portfolio
// and product are what stop two venues' trade #900001 from colliding.
function tradeKeyFor(row) {
  if (row.orderId) return `cbp:trade:${row.orderId}:${row.tradeId}`;
  const scope = [row.portfolio, row.product].filter(Boolean).join('.') || 'default';
  return `cbp:trade:${scope}:${row.tradeId}`;
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

    const amountCell = cellOf(row, 'amount');
    parsedRows.push({
      line,
      type: cellOf(row, 'type').toLowerCase(),
      occurredAt,
      amountCell,
      amount: cleanAmount(amountCell),
      asset: cellOf(row, 'unit'),
      portfolio: cellOf(row, 'portfolio'),
      product: cellOf(row, 'product'),
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
    const externalId = tradeKeyFor(first);

    // A group with no match line at all is a fee the export orphaned -- most
    // often a fee row whose order id is blank, which lands in a group of its
    // own. Shaped into a trade it would claim a fill that never appears
    // anywhere in the file, unflagged; it is a fee, and it is one to look at.
    if (legs.length === 0) {
      const { asset: feeAsset, amount: feeAmount } = combineFees(
        fees.map((fee) => ({ asset: fee.asset, amount: fee.amount })),
        null
      );
      emitted.push({
        order: group.order,
        record: finalizeRecord({
          record_type: 'fee',
          occurred_at: first.occurredAt,
          base_asset: first.asset,
          base_amount: first.amount,
          quote_asset: null,
          quote_amount: null,
          fee_asset: feeAmount && feeAmount !== '0' ? feeAsset : null,
          fee_amount: feeAmount && feeAmount !== '0' ? feeAmount : null,
          tx_hash: null,
          address: null,
          // Same key the completed fill will carry, so the fuller export
          // upgrades this row rather than landing next to it.
          external_id: externalId,
          needs_review: true,
          raw: { _format: FORMAT, rows: group.rows.map((row) => row.raw) },
        }, { line: first.line, amountCell: group.rows.map((row) => row.amountCell) }),
      });
      continue;
    }

    let baseLeg = legs[0];
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

    const combined = combineFees(
      fees.map((fee) => ({ asset: fee.asset, amount: fee.amount })),
      quoteLeg?.asset ?? null
    );

    emitted.push({
      order: group.order,
      record: finalizeRecord({
        record_type: 'trade',
        occurred_at: baseLeg.occurredAt,
        base_asset: baseLeg.asset,
        base_amount: baseLeg.amount,
        quote_asset: quoteLeg?.asset ?? null,
        quote_amount: quoteLeg?.amount ?? null,
        fee_asset: combined.amount && combined.amount !== '0' ? combined.asset : null,
        fee_amount: combined.amount && combined.amount !== '0' ? combined.amount : null,
        tx_hash: null,
        address: null,
        external_id: externalId,
        needs_review: needsReview,
        raw: { _format: FORMAT, rows: group.rows.map((row) => row.raw) },
      }, { line: first.line, amountCell: legs.map((leg) => leg.amountCell) }),
    });
  }

  // A conversion is two lines with no id of any kind on either: same portfolio,
  // same instant, opposite signs. Unpaired they each lose their counter-asset,
  // which is the only thing that says what the balance turned into.
  const conversionGroups = new Map();
  const plainSingles = [];
  for (const row of singles) {
    if (row.type !== 'conversion') { plainSingles.push(row); continue; }
    const key = `${row.portfolio}|${row.occurredAt}`;
    if (!conversionGroups.has(key)) conversionGroups.set(key, { key, order: row.line, rows: [] });
    conversionGroups.get(key).rows.push(row);
  }

  // The event's identity is the portfolio and the instant -- the one thing both
  // legs carry and a widowed leg still knows. Keying on the row's own contents
  // instead would give the half record and the whole record different ids.
  const conversionIdFor = (row) => contentId(
    'cbp', ['conversion', row.portfolio, row.occurredAt],
    dupIndexFor(`conversion|${row.portfolio}|${row.occurredAt}`)
  );

  for (const group of conversionGroups.values()) {
    const outgoing = group.rows.filter((row) => isNegativeAmount(row.amount ?? ''));
    const incoming = group.rows.filter((row) => !isNegativeAmount(row.amount ?? ''));
    const pairs = Math.min(outgoing.length, incoming.length);

    for (let i = 0; i < pairs; i += 1) {
      const legs = [outgoing[i], incoming[i]];
      const picked = pickBaseQuote(legs);
      const first = legs[0].line <= legs[1].line ? legs[0] : legs[1];
      emitted.push({
        order: first.line,
        record: finalizeRecord({
          record_type: 'conversion',
          occurred_at: first.occurredAt,
          base_asset: picked.base.asset,
          base_amount: picked.base.amount,
          quote_asset: picked.quote.asset,
          quote_amount: picked.quote.amount,
          fee_asset: null,
          fee_amount: null,
          tx_hash: null,
          address: null,
          external_id: conversionIdFor(first),
          needs_review: picked.ambiguous,
          raw: { _format: FORMAT, rows: legs.map((leg) => leg.raw) },
        }, { line: first.line, amountCell: legs.map((leg) => leg.amountCell) }),
      });
    }

    for (const row of [...outgoing.slice(pairs), ...incoming.slice(pairs)]) {
      emitted.push({
        order: row.line,
        record: finalizeRecord({
          record_type: 'conversion',
          occurred_at: row.occurredAt,
          base_asset: row.asset,
          base_amount: row.amount,
          quote_asset: null,
          quote_amount: null,
          fee_asset: null,
          fee_amount: null,
          tx_hash: null,
          address: null,
          external_id: conversionIdFor(row),
          needs_review: true,
          raw: row.raw,
        }, { line: row.line, amountCell: row.amountCell }),
      });
    }
  }

  for (const row of plainSingles) {
    const mapped = TYPE_MAP[row.type];
    const isUnknown = !mapped;
    if (isUnknown) unknownTypes += 1;

    // Transfers carry a uuid; anything else with no id at all is what the
    // content hash exists for.
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
      }, { line: row.line, amountCell: row.amountCell }),
    });
  }

  emitted.sort((a, b) => a.order - b.order);

  return {
    records: emitted.map((entry) => entry.record),
    stats: { headerRowsSkipped, noiseRowsSkipped: 0, unknownTypes },
  };
}

module.exports = { FORMAT, detect, parse };
