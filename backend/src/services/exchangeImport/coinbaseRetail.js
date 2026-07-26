'use strict';

const {
  UNKNOWN_RECORD_TYPE,
  cleanAmount,
  absAmount,
  negateAmount,
  isNegativeAmount,
  parseTimestamp,
  contentId,
  makeDupCounter,
  finalizeRecord,
  ImportFormatError,
} = require('./shared');
const { isBlankRow } = require('../../utils/csv');

const FORMAT = 'coinbase_retail';

// Column resolution is by name, not position: Coinbase has reordered and
// renamed these over the years ("Spot Price Currency" in older exports), and a
// positional reader would silently read prices as quantities.
const COLUMNS = {
  id: ['ID', 'Transaction ID'],
  timestamp: ['Timestamp', 'Time'],
  type: ['Transaction Type'],
  asset: ['Asset', 'Currency'],
  quantity: ['Quantity Transacted'],
  priceCurrency: ['Price Currency', 'Spot Price Currency'],
  subtotal: ['Subtotal'],
  total: ['Total (inclusive of fees and/or spread)', 'Total'],
  fees: ['Fees and/or Spread', 'Fees'],
  notes: ['Notes'],
  sender: ['Sender Address'],
  recipient: ['Recipient Address'],
};

// The header line the format is recognized by. Anything missing these is not a
// Coinbase retail export, whatever else it may be.
const REQUIRED = ['timestamp', 'type', 'asset', 'quantity'];

const TYPE_MAP = {
  'staking income': 'reward',
  'reward income': 'reward',
  'rewards income': 'reward',
  'inflation reward': 'reward',
  'learning reward': 'reward',
  buy: 'trade',
  sell: 'trade',
  'advanced trade buy': 'trade',
  'advanced trade sell': 'trade',
  convert: 'conversion',
  send: 'withdrawal',
  withdrawal: 'withdrawal',
  receive: 'deposit',
  deposit: 'deposit',
  // Coinbase names these five from the DESTINATION's point of view, and the
  // name contradicts the row's own sign: every "Exchange Deposit" carries a
  // negative quantity (money leaving retail FOR the exchange), every "Pro
  // Withdrawal" a positive one. Read literally they book withdrawals as
  // deposits and back, so they map to the direction-free type and let the
  // amount's sign say which way the money went. All five are moves between the
  // user's own Coinbase surfaces -- retail, Pro/Exchange, the vault -- and
  // nothing leaves Coinbase, which is what 'transfer' already means here.
  'pro deposit': 'transfer',
  'pro withdrawal': 'transfer',
  'exchange deposit': 'transfer',
  'exchange withdrawal': 'transfer',
  'vault withdrawal': 'transfer',
  'retail staking transfer': 'transfer',
  'retail unstaking transfer': 'transfer',
  transfer: 'transfer',
  'retail eth2 deprecation': 'transfer',
};

// "Converted 36.06674036 ETH to 36.06674036 ETH2" -- the only place either leg
// of a Convert names the other, and the only thing the two rows share
// verbatim (their timestamps are seconds apart and their ids differ, except
// for the older exports where BOTH legs carry the same id).
const CONVERT_NOTE = /^converted\s+([\d,.]+)\s+(\S+)\s+to\s+([\d,.]+)\s+(\S+)/i;

function resolveColumns(header) {
  const index = new Map(header.map((cell, i) => [String(cell ?? '').trim().toLowerCase(), i]));
  const resolved = {};
  for (const [key, candidates] of Object.entries(COLUMNS)) {
    for (const candidate of candidates) {
      const found = index.get(candidate.toLowerCase());
      if (found !== undefined) { resolved[key] = found; break; }
    }
  }
  return resolved;
}

function findHeader(rows) {
  // The header sits below a preamble ("Transactions", "User,<name>,<id>"), and
  // this format is also the one that repeats it mid-file, so the search is by
  // content rather than by a fixed line number.
  for (let i = 0; i < rows.length; i += 1) {
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

// The two ledger lines of one Convert, matched up. They always carry the same
// note, so it is the group key; within a group the leg whose asset is the
// note's from-asset (or, failing that, the negative one) is the base.
function pairConversions(conversions) {
  const groups = new Map();
  for (const row of conversions) {
    const match = CONVERT_NOTE.exec(row.notes);
    const key = match ? row.notes.trim().toLowerCase() : `__unpairable__${row.line}`;
    if (!groups.has(key)) groups.set(key, { match, rows: [] });
    groups.get(key).rows.push(row);
  }

  const pairs = [];
  const orphans = [];
  for (const group of groups.values()) {
    if (!group.match) {
      orphans.push(...group.rows);
      continue;
    }
    const fromAsset = group.match[2].toUpperCase();
    const toAsset = group.match[4].toUpperCase();
    const assetOf = (row) => String(row.baseAsset || '').toUpperCase();

    // When both legs name the same asset the note cannot tell them apart, so
    // the sign does. (It never can be the same asset in practice -- a Convert
    // to itself is the bug this pairing exists to stop producing.)
    const isFrom = fromAsset === toAsset
      ? (row) => isNegativeAmount(row.baseAmount ?? '')
      : (row) => assetOf(row) === fromAsset;

    const fromRows = group.rows.filter(isFrom);
    const toRows = group.rows.filter((row) => !isFrom(row));

    // A repeated note means the user made the same conversion twice; pairing
    // in file order keeps each record's two legs adjacent in time.
    const paired = Math.min(fromRows.length, toRows.length);
    for (let i = 0; i < paired; i += 1) pairs.push({ from: fromRows[i], to: toRows[i] });
    orphans.push(...fromRows.slice(paired), ...toRows.slice(paired));
  }

  return { pairs, orphans };
}

function parse(rows) {
  const found = findHeader(rows);
  if (!found) {
    throw new ImportFormatError('Not a Coinbase retail transactions export.');
  }
  const { index: headerIndex, columns, header } = found;
  const cellOf = (row, key) => (columns[key] === undefined ? '' : String(row[columns[key]] ?? '').trim());

  const parsedRows = [];
  const dupIndexFor = makeDupCounter();
  let headerRowsSkipped = 0;
  let noiseRowsSkipped = 0;
  let unknownTypes = 0;

  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const line = i + 1;
    if (isBlankRow(row)) continue;

    // Coinbase repeats the header (and sometimes the whole preamble block)
    // partway through long exports. Read as data, that line becomes a record
    // with the literal timestamp "Timestamp", so it has to be recognized.
    if (cellOf(row, 'type').toLowerCase() === 'transaction type'
        || String(row[0] ?? '').trim().toLowerCase() === 'id') {
      headerRowsSkipped += 1;
      continue;
    }

    const occurredAt = parseTimestamp(cellOf(row, 'timestamp'));
    if (!occurredAt) {
      // A short row with no readable time is a repeated preamble line
      // ("Transactions", "User,..."), which is noise. A full-width row with an
      // unreadable time is a format we do not understand -- abort rather than
      // drop a real transaction.
      if (row.length < header.length) { noiseRowsSkipped += 1; continue; }
      throw new ImportFormatError(`Line ${line}: could not read the Timestamp column ("${cellOf(row, 'timestamp')}")`);
    }

    const rawType = cellOf(row, 'type');
    const recordType = TYPE_MAP[rawType.toLowerCase()] ?? UNKNOWN_RECORD_TYPE;
    const isUnknown = !(rawType.toLowerCase() in TYPE_MAP);
    if (isUnknown) unknownTypes += 1;

    const quantityCell = cellOf(row, 'quantity');
    const baseAsset = cellOf(row, 'asset');
    const baseAmount = cleanAmount(quantityCell);
    const subtotal = cleanAmount(cellOf(row, 'subtotal'));
    const fee = cleanAmount(cellOf(row, 'fees'));

    const raw = { _format: FORMAT, _source_line: line };
    header.forEach((name, col) => {
      const value = String(row[col] ?? '').trim();
      if (value) raw[String(name).trim()] = value;
    });

    const nativeId = cellOf(row, 'id');
    const notes = cellOf(row, 'notes');
    const externalId = nativeId
      ? `cb:${nativeId}`
      : contentId('cb', [occurredAt, rawType, baseAsset, baseAmount, subtotal, notes],
        dupIndexFor(`${occurredAt}|${rawType}|${baseAsset}|${baseAmount}|${subtotal}|${notes}`));

    parsedRows.push({
      line,
      occurredAt,
      rawType,
      recordType,
      isUnknown,
      baseAsset,
      baseAmount,
      quantityCell,
      priceCurrency: cellOf(row, 'priceCurrency') || null,
      subtotal,
      total: cleanAmount(cellOf(row, 'total')),
      fee,
      notes,
      sender: cellOf(row, 'sender') || null,
      recipient: cellOf(row, 'recipient') || null,
      nativeId,
      externalId,
      raw,
    });
  }

  const emitted = [];

  const emitSingle = (row, { needsReview = false } = {}) => {
    let quoteAsset = null;
    let quoteAmount = null;

    if (row.recordType === 'trade') {
      // The export signs Subtotal inconsistently (a sale is sometimes positive,
      // sometimes negative), so the sign is rebuilt from the base leg instead:
      // buying an asset spends the quote, selling it receives the quote.
      const magnitude = absAmount(row.subtotal ?? row.total);
      if (magnitude !== null && row.priceCurrency) {
        quoteAsset = row.priceCurrency;
        quoteAmount = isNegativeAmount(row.baseAmount ?? '0') ? magnitude : negateAmount(magnitude);
      }
    }

    let address;
    if (row.recordType === 'withdrawal') address = row.recipient || row.sender;
    else if (row.recordType === 'deposit') address = row.sender || row.recipient;
    else address = row.recipient || row.sender;

    emitted.push({
      order: row.line,
      record: finalizeRecord({
        record_type: row.recordType,
        occurred_at: row.occurredAt,
        base_asset: row.baseAsset,
        base_amount: row.baseAmount,
        quote_asset: quoteAsset,
        quote_amount: quoteAmount,
        // Fees are stored as positive magnitudes across every importer: a fee is
        // a cost, and its sign in the source depends only on which side of the
        // ledger the exchange printed it from. Zero fees stay null.
        fee_asset: row.fee && row.fee !== '0' ? row.priceCurrency : null,
        fee_amount: row.fee && row.fee !== '0' ? absAmount(row.fee) : null,
        tx_hash: null,
        address,
        external_id: row.externalId,
        needs_review: row.isUnknown || needsReview,
        raw: row.raw,
      }, { line: row.line, amountCell: row.quantityCell }),
    });
  };

  // A Convert writes two ledger lines and puts the same note on both. Applying
  // that note to each of them produced two records, one of them a self-
  // conversion (ETH -> ETH) that also happened to be the only row carrying the
  // fee. The event is one conversion, so it becomes one record.
  const conversions = parsedRows.filter((row) => row.recordType === 'conversion');
  const { pairs, orphans } = pairConversions(conversions);
  const orphanLines = new Set(orphans.map((row) => row.line));

  for (const { from, to } of pairs) {
    // Whichever leg the exchange charged. The 2019-era exports bill the
    // receiving leg, and it is the only line the fee appears on at all.
    const feeRow = (from.fee && from.fee !== '0') ? from
      : ((to.fee && to.fee !== '0') ? to : null);

    const raw = { ...from.raw, _paired_source_line: to.line };
    if (to.nativeId) raw._paired_id = to.nativeId;
    raw._paired_row = to.raw;

    emitted.push({
      order: Math.min(from.line, to.line),
      record: finalizeRecord({
        record_type: 'conversion',
        occurred_at: from.occurredAt,
        base_asset: from.baseAsset,
        base_amount: from.baseAmount,
        quote_asset: to.baseAsset,
        quote_amount: to.baseAmount,
        fee_asset: feeRow ? feeRow.priceCurrency : null,
        fee_amount: feeRow ? absAmount(feeRow.fee) : null,
        tx_hash: null,
        address: null,
        external_id: from.externalId,
        needs_review: false,
        raw,
      }, { line: from.line, amountCell: [from.quantityCell, to.quantityCell] }),
    });
  }

  for (const row of parsedRows) {
    if (row.recordType === 'conversion') {
      // A Convert leg with no counter-leg in the file is half an event: kept,
      // because the money moved, but flagged -- nothing here says what it
      // became.
      if (orphanLines.has(row.line)) emitSingle(row, { needsReview: true });
      continue;
    }
    emitSingle(row);
  }

  emitted.sort((a, b) => a.order - b.order);

  return {
    records: emitted.map((entry) => entry.record),
    stats: { headerRowsSkipped, noiseRowsSkipped, unknownTypes },
  };
}

module.exports = { FORMAT, detect, parse, TYPE_MAP };
