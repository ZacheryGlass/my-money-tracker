'use strict';

const { cleanAmount, parseTimestamp, ImportFormatError } = require('./shared');
const { normalizeAssetParts, buildRecords } = require('./krakenLedger');
const { isBlankRow } = require('../../utils/csv');

// The CSV half of the Kraken reader: it turns a ledgers export into normalized
// ledger rows and hands them to krakenLedger.buildRecords, which is the SAME
// code the API sync uses. Pairing, type mapping and external_id construction
// all live there so the two sources cannot drift apart -- see the note at the
// top of krakenLedger.js for why that matters.

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

    const amountCell = cellOf(row, 'amount');
    const normalizedAsset = normalizeAssetParts(cellOf(row, 'asset'));
    parsedRows.push({
      line,
      txid: cellOf(row, 'txid'),
      refid: cellOf(row, 'refid'),
      occurredAt,
      type: cellOf(row, 'type').toLowerCase(),
      subtype: cellOf(row, 'subtype').toLowerCase(),
      asset: normalizedAsset.asset,
      identityAsset: normalizedAsset.identityAsset,
      amountCell,
      amount: cleanAmount(amountCell),
      fee: cleanAmount(cellOf(row, 'fee')),
      raw,
    });
  }

  const { records, unknownTypes } = buildRecords(parsedRows);

  return {
    records,
    stats: { headerRowsSkipped, noiseRowsSkipped: 0, unknownTypes },
  };
}

module.exports = { FORMAT, detect, parse };
