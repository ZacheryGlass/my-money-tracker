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
  'pro withdrawal': 'withdrawal',
  'exchange withdrawal': 'withdrawal',
  'vault withdrawal': 'withdrawal',
  receive: 'deposit',
  deposit: 'deposit',
  'pro deposit': 'deposit',
  'exchange deposit': 'deposit',
  'retail staking transfer': 'transfer',
  'retail unstaking transfer': 'transfer',
  transfer: 'transfer',
  'retail eth2 deprecation': 'transfer',
};

// "Converted 36.06674036 ETH to 36.06674036 ETH2" -- the only place the
// destination leg of a Convert appears in this export.
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

function parse(rows) {
  const found = findHeader(rows);
  if (!found) {
    throw new ImportFormatError('Not a Coinbase retail transactions export.');
  }
  const { index: headerIndex, columns, header } = found;
  const cellOf = (row, key) => (columns[key] === undefined ? '' : String(row[columns[key]] ?? '').trim());

  const records = [];
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

    const baseAsset = cellOf(row, 'asset');
    const baseAmount = cleanAmount(cellOf(row, 'quantity'));
    const priceCurrency = cellOf(row, 'priceCurrency') || null;
    const subtotal = cleanAmount(cellOf(row, 'subtotal'));
    const total = cleanAmount(cellOf(row, 'total'));
    const fee = cleanAmount(cellOf(row, 'fees'));
    const notes = cellOf(row, 'notes');

    let quoteAsset = null;
    let quoteAmount = null;
    let needsReview = isUnknown;

    if (recordType === 'trade') {
      // The export signs Subtotal inconsistently (a sale is sometimes positive,
      // sometimes negative), so the sign is rebuilt from the base leg instead:
      // buying an asset spends the quote, selling it receives the quote.
      const magnitude = absAmount(subtotal ?? total);
      if (magnitude !== null && priceCurrency) {
        quoteAsset = priceCurrency;
        quoteAmount = isNegativeAmount(baseAmount ?? '0') ? magnitude : negateAmount(magnitude);
      }
    } else if (recordType === 'conversion') {
      const match = CONVERT_NOTE.exec(notes);
      if (match) {
        quoteAsset = match[4];
        // A conversion's two legs move in opposite directions, same as a trade.
        const converted = cleanAmount(match[3]);
        quoteAmount = isNegativeAmount(baseAmount ?? '0') ? converted : negateAmount(converted);
      } else {
        // Without the note there is no second leg anywhere in this export, and
        // a one-legged conversion is a hole in the history -- flag it.
        needsReview = true;
      }
    }

    let address = null;
    const sender = cellOf(row, 'sender') || null;
    const recipient = cellOf(row, 'recipient') || null;
    if (recordType === 'withdrawal') address = recipient || sender;
    else if (recordType === 'deposit') address = sender || recipient;
    else address = recipient || sender;

    const raw = { _format: FORMAT, _source_line: line };
    header.forEach((name, col) => {
      const value = String(row[col] ?? '').trim();
      if (value) raw[String(name).trim()] = value;
    });

    const nativeId = cellOf(row, 'id');
    const externalId = nativeId
      ? `cb:${nativeId}`
      : contentId('cb', [occurredAt, rawType, baseAsset, baseAmount, subtotal, notes],
        dupIndexFor(`${occurredAt}|${rawType}|${baseAsset}|${baseAmount}|${subtotal}|${notes}`));

    records.push(finalizeRecord({
      record_type: recordType,
      occurred_at: occurredAt,
      base_asset: baseAsset,
      base_amount: baseAmount,
      quote_asset: quoteAsset,
      quote_amount: quoteAmount,
      // Fees are stored as positive magnitudes across every importer: a fee is
      // a cost, and its sign in the source depends only on which side of the
      // ledger the exchange printed it from. Zero fees stay null.
      fee_asset: fee && fee !== '0' ? priceCurrency : null,
      fee_amount: fee && fee !== '0' ? absAmount(fee) : null,
      tx_hash: null,
      address,
      external_id: externalId,
      needs_review: needsReview,
      raw,
    }, { line }));
  }

  return {
    records,
    stats: { headerRowsSkipped, noiseRowsSkipped, unknownTypes },
  };
}

module.exports = { FORMAT, detect, parse, TYPE_MAP };
