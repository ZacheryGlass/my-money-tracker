'use strict';

const {
  UNKNOWN_RECORD_TYPE,
  RECORD_TYPES,
  cleanAmount,
  absAmount,
  parseTimestamp,
  contentId,
  makeDupCounter,
  finalizeRecord,
  ImportFormatError,
} = require('./shared');
const { isBlankRow } = require('../../utils/csv');

const FORMAT = 'generic';

// Stated wherever this importer talks to the user, because it is the one rule
// they cannot see from their file: a timestamp with no zone in it is read as
// UTC. Reading it as the server's local time would shift every row by the
// host's offset -- and, since occurred_at feeds the content hash that ids
// id-less rows, would give the same file different ids on a laptop and in
// production. An export that writes local time should carry an offset.
const TIMESTAMP_CONVENTION = 'Timestamps without a time zone are read as UTC.';

// Header names this importer recognizes without being told. An exchange that
// uses none of them is not rejected outright -- the caller can pass an explicit
// mapping -- but it is never guessed at.
const CANDIDATES = {
  occurred_at: ['time', 'date', 'timestamp', 'datetime', 'created at', 'created_at', 'occurred at', 'date(utc)', 'date (utc)', 'utc_time'],
  record_type: ['type', 'transaction type', 'record type', 'operation', 'side', 'action', 'category'],
  base_asset: ['asset', 'currency', 'coin', 'symbol', 'base asset', 'base currency', 'token'],
  base_amount: ['amount', 'quantity', 'qty', 'base amount', 'quantity transacted', 'size', 'change'],
  quote_asset: ['quote asset', 'quote currency', 'price currency', 'counter currency'],
  quote_amount: ['quote amount', 'total', 'subtotal', 'proceeds', 'cost'],
  fee_asset: ['fee asset', 'fee currency', 'fee coin'],
  fee_amount: ['fee', 'fees', 'fee amount', 'commission'],
  tx_hash: ['tx hash', 'txhash', 'transaction hash', 'hash', 'txid'],
  address: ['address', 'destination', 'destination address', 'to address', 'recipient address', 'wallet address'],
  external_id: ['id', 'external id', 'reference', 'refid', 'transaction id', 'trade id'],
};

// Word-level mapping, checked in order so that "Advanced Trade Sell" resolves
// to a trade before "sell" would, and "staking reward" to a reward before
// "transfer" could catch it.
const TYPE_RULES = [
  [/\b(reward|rewards|staking|earn|interest|inflation|airdrop|income|rebate|dividend)\b/, 'reward'],
  [/\b(convert|converted|conversion|swap)\b/, 'conversion'],
  [/\b(buy|bought|sell|sold|trade|match|fill|order)\b/, 'trade'],
  [/\b(withdraw|withdrawal|withdrawn|send|sent|debit|out)\b/, 'withdrawal'],
  [/\b(deposit|deposited|receive|received|credit|in)\b/, 'deposit'],
  [/\b(transfer|move|internal)\b/, 'transfer'],
  [/\b(fee|commission)\b/, 'fee'],
];

function resolveColumns(header, override = {}) {
  const index = new Map(
    header.map((cell, i) => [String(cell ?? '').trim().toLowerCase(), i])
  );
  const resolved = {};
  for (const [field, names] of Object.entries(CANDIDATES)) {
    const forced = override[field];
    if (forced !== undefined && forced !== null && String(forced).trim() !== '') {
      const forcedIndex = index.get(String(forced).trim().toLowerCase());
      if (forcedIndex === undefined) {
        throw new ImportFormatError(`Column "${forced}" (mapped to ${field}) is not in this file's header.`);
      }
      resolved[field] = forcedIndex;
      continue;
    }
    for (const name of names) {
      const found = index.get(name);
      if (found !== undefined) { resolved[field] = found; break; }
    }
  }
  return resolved;
}

function firstNonBlank(rows) {
  for (let i = 0; i < rows.length; i += 1) {
    if (!isBlankRow(rows[i])) return i;
  }
  return -1;
}

function normalizeType(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return null;
  if (RECORD_TYPES.has(text)) return text;
  for (const [pattern, mapped] of TYPE_RULES) {
    if (pattern.test(text)) return mapped;
  }
  return null;
}

function parse(rows, { mapping = {} } = {}) {
  const headerIndex = firstNonBlank(rows);
  if (headerIndex === -1) throw new ImportFormatError('The file has no rows.');

  const header = rows[headerIndex];
  const columns = resolveColumns(header, mapping);

  // Fail closed. Without a time and an amount there is no record to build, and
  // importing whatever happened to parse would leave a history nobody can trust.
  const missing = ['occurred_at', 'base_amount'].filter((field) => columns[field] === undefined);
  if (missing.length) {
    throw new ImportFormatError(
      `Unrecognized CSV layout: no ${missing.join(' or ')} column found. Header was: ${header.join(', ')}. `
      + 'Supply an explicit column mapping to import this file. '
      + `${TIMESTAMP_CONVENTION}`
    );
  }

  const cellOf = (row, key) => (columns[key] === undefined ? '' : String(row[columns[key]] ?? '').trim());
  const records = [];
  const dupIndexFor = makeDupCounter();
  let headerRowsSkipped = 0;
  let unknownTypes = 0;

  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const line = i + 1;
    if (isBlankRow(row)) continue;
    // Some exports concatenate several statements and repeat the header.
    if (columns.occurred_at !== undefined
        && cellOf(row, 'occurred_at').toLowerCase() === String(header[columns.occurred_at]).trim().toLowerCase()) {
      headerRowsSkipped += 1;
      continue;
    }

    const occurredAt = parseTimestamp(cellOf(row, 'occurred_at'));
    if (!occurredAt) {
      throw new ImportFormatError(`Line ${line}: could not read a timestamp from column "${header[columns.occurred_at]}"`);
    }

    const mapped = normalizeType(cellOf(row, 'record_type'));
    if (!mapped) unknownTypes += 1;

    const raw = { _format: FORMAT, _source_line: line };
    header.forEach((name, col) => {
      const value = String(row[col] ?? '').trim();
      if (value) raw[String(name).trim()] = value;
    });

    const fee = cleanAmount(cellOf(row, 'fee_amount'));
    const nativeId = cellOf(row, 'external_id');
    const amountCell = cellOf(row, 'base_amount');
    const contentKey = [occurredAt, cellOf(row, 'record_type'), cellOf(row, 'base_asset'), amountCell].join('|');

    records.push(finalizeRecord({
      record_type: mapped ?? UNKNOWN_RECORD_TYPE,
      occurred_at: occurredAt,
      base_asset: cellOf(row, 'base_asset') || null,
      base_amount: cleanAmount(amountCell),
      quote_asset: cellOf(row, 'quote_asset') || null,
      quote_amount: cleanAmount(cellOf(row, 'quote_amount')),
      fee_asset: fee && fee !== '0' ? (cellOf(row, 'fee_asset') || cellOf(row, 'quote_asset') || null) : null,
      fee_amount: fee && fee !== '0' ? absAmount(fee) : null,
      tx_hash: cellOf(row, 'tx_hash') || null,
      address: cellOf(row, 'address') || null,
      external_id: nativeId
        ? `gen:${nativeId}`
        : contentId('gen', [contentKey], dupIndexFor(contentKey)),
      needs_review: !mapped,
      raw,
    }, { line, amountCell }));
  }

  return {
    records,
    stats: { headerRowsSkipped, noiseRowsSkipped: 0, unknownTypes },
  };
}

// The fallback never claims a file: it runs only when no specific importer
// recognized one, and reports its own failure through parse().
function detect() {
  return false;
}

module.exports = { FORMAT, detect, parse, TIMESTAMP_CONVENTION };
