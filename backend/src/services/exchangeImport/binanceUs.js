'use strict';

const {
  UNKNOWN_RECORD_TYPE,
  cleanAmount,
  absAmount,
  negateAmount,
  parseTimestamp,
  contentId,
  makeDupCounter,
  finalizeRecord,
  ImportFormatError,
} = require('./shared');
const { isBlankRow } = require('../../utils/csv');

// Binance.US account activity exports are not generic ledgers. In particular,
// the quantity columns are named "Realized Amount For ...", and trade rows put
// both legs on one line rather than emitting one line per asset. Keep this
// reader separate from the generic fallback so a new Binance export cannot be
// mistaken for a one-sided transfer.
const FORMAT = 'binance_us';

const COLUMNS = {
  time: ['time'],
  category: ['category'],
  operation: ['operation'],
  orderId: ['order id'],
  transactionId: ['transaction id'],
  primaryAsset: ['primary asset'],
  primaryAmount: ['realized amount for primary asset'],
  baseAsset: ['base asset'],
  baseAmount: ['realized amount for base asset'],
  quoteAsset: ['quote asset'],
  quoteAmount: ['realized amount for quote asset'],
  feeAsset: ['fee asset'],
  feeAmount: ['realized amount for fee asset'],
};

const REQUIRED = ['time', 'category', 'operation', 'transactionId'];

function resolveColumns(header) {
  const index = new Map(header.map((cell, i) => [String(cell ?? '').trim().toLowerCase(), i]));
  const resolved = {};
  for (const [key, candidates] of Object.entries(COLUMNS)) {
    for (const candidate of candidates) {
      const found = index.get(candidate);
      if (found !== undefined) {
        resolved[key] = found;
        break;
      }
    }
  }
  return resolved;
}

function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i += 1) {
    if (isBlankRow(rows[i])) continue;
    const resolved = resolveColumns(rows[i]);
    if (REQUIRED.every((key) => resolved[key] !== undefined)
        && (resolved.primaryAmount !== undefined || resolved.baseAmount !== undefined)) {
      return { index: i, columns: resolved, header: rows[i] };
    }
  }
  return null;
}

function detect(rows) {
  return findHeader(rows) !== null;
}

function asset(value) {
  const text = String(value ?? '').trim().toUpperCase();
  return text || null;
}

function operationOf(row, cellOf) {
  return cellOf(row, 'operation').toLowerCase();
}

function rawOf(header, row, line) {
  const raw = { _format: FORMAT, _source: 'csv', _source_line: line };
  header.forEach((name, col) => {
    const value = String(row[col] ?? '').trim();
    if (value) raw[String(name).trim()] = value;
  });
  return raw;
}

function externalIdFor({ operation, category, transactionId, baseAsset, quoteAsset, occurredAt, orderId, amounts }, dupIndexFor) {
  if (transactionId) {
    // These prefixes intentionally mirror the Binance.US API connector. When
    // Binance's CSV Transaction ID is the same provider id as the API row, a
    // CSV backfill upgrades the API record instead of duplicating it. The
    // operation-specific prefix also prevents a trade id from colliding with
    // a capital or distribution id.
    if (operation === 'buy' || operation === 'sell') {
      return `binanceus:trade:${baseAsset || ''}${quoteAsset || ''}:${transactionId}`;
    }
    if (operation === 'crypto deposit') return `binanceus:deposit:${transactionId}`;
    if (operation === 'crypto withdrawal') return `binanceus:withdrawal:${transactionId}`;
    if (operation === 'staking rewards') return `binanceus:distribution:${transactionId}`;
    return `binanceus:csv:${transactionId}`;
  }

  const key = [occurredAt, category, operation, orderId, baseAsset, quoteAsset, ...amounts].join('|');
  return contentId('binanceus:csv', [key], dupIndexFor(key));
}

function parse(rows) {
  const found = findHeader(rows);
  if (!found) throw new ImportFormatError('Not a Binance.US account activity export.');

  const { index: headerIndex, columns, header } = found;
  const cellOf = (row, key) => (columns[key] === undefined ? '' : String(row[columns[key]] ?? '').trim());
  const records = [];
  const dupIndexFor = makeDupCounter();
  let headerRowsSkipped = 0;
  let unknownTypes = 0;

  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const line = i + 1;
    if (isBlankRow(row)) continue;

    if (cellOf(row, 'time').toLowerCase() === 'time'
        && cellOf(row, 'transactionId').toLowerCase() === 'transaction id') {
      headerRowsSkipped += 1;
      continue;
    }

    const timeCell = cellOf(row, 'time');
    const occurredAt = parseTimestamp(timeCell);
    if (!occurredAt) {
      throw new ImportFormatError(`Line ${line}: could not read the Time column ("${timeCell}")`);
    }

    const category = cellOf(row, 'category').toLowerCase();
    const operation = operationOf(row, cellOf);
    const orderId = cellOf(row, 'orderId');
    const transactionId = cellOf(row, 'transactionId');
    const primaryAsset = asset(cellOf(row, 'primaryAsset'));
    const baseAsset = asset(cellOf(row, 'baseAsset'));
    const quoteAsset = asset(cellOf(row, 'quoteAsset'));
    const primaryAmountCell = cellOf(row, 'primaryAmount');
    const baseAmountCell = cellOf(row, 'baseAmount');
    const quoteAmountCell = cellOf(row, 'quoteAmount');
    const feeAmountCell = cellOf(row, 'feeAmount');
    const primaryAmount = cleanAmount(primaryAmountCell);
    const baseAmount = cleanAmount(baseAmountCell);
    const quoteAmount = cleanAmount(quoteAmountCell);
    const feeAmount = absAmount(cleanAmount(feeAmountCell));
    const feeAsset = asset(cellOf(row, 'feeAsset'));
    const raw = rawOf(header, row, line);

    const isBuy = operation === 'buy';
    const isSell = operation === 'sell';
    const isDeposit = operation === 'crypto deposit';
    const isWithdrawal = operation === 'crypto withdrawal';
    const isReward = operation === 'staking rewards';
    const known = isBuy || isSell || isDeposit || isWithdrawal || isReward;
    const unreadableAmount = (value, cell) => value === null && cell !== '';

    if (!known) unknownTypes += 1;

    let recordType;
    let recordBaseAsset;
    let recordBaseAmount;
    let recordQuoteAsset = null;
    let recordQuoteAmount = null;
    let recordFeeAsset = null;
    let recordFeeAmount = null;
    let needsReview = !known;

    if (isBuy || isSell) {
      recordType = 'trade';
      recordBaseAsset = baseAsset;
      recordBaseAmount = isBuy ? absAmount(baseAmount) : negateAmount(absAmount(baseAmount));
      recordQuoteAsset = quoteAsset;
      recordQuoteAmount = isBuy ? negateAmount(absAmount(quoteAmount)) : absAmount(quoteAmount);
      recordFeeAsset = feeAmount && feeAmount !== '0' ? feeAsset : null;
      recordFeeAmount = feeAmount && feeAmount !== '0' ? feeAmount : null;
      needsReview = needsReview || !recordBaseAsset || !recordQuoteAsset
        || baseAmount === null || quoteAmount === null;
    } else if (isDeposit || isReward) {
      recordType = isDeposit ? 'deposit' : 'reward';
      recordBaseAsset = primaryAsset;
      recordBaseAmount = absAmount(primaryAmount);
      needsReview = needsReview || !recordBaseAsset || primaryAmount === null;
    } else if (isWithdrawal) {
      recordType = 'withdrawal';
      recordBaseAsset = primaryAsset;
      recordBaseAmount = negateAmount(absAmount(primaryAmount));
      recordFeeAsset = feeAmount && feeAmount !== '0' ? feeAsset : null;
      recordFeeAmount = feeAmount && feeAmount !== '0' ? feeAmount : null;
      needsReview = needsReview || !recordBaseAsset || primaryAmount === null;
    } else {
      // Keep an unfamiliar operation visible without asserting whether it was
      // income, a deposit, or a withdrawal. Prefer the primary leg, then the
      // base leg, and preserve every source cell in raw for review.
      recordType = UNKNOWN_RECORD_TYPE;
      recordBaseAsset = primaryAsset || baseAsset;
      recordBaseAmount = primaryAmount ?? baseAmount;
      needsReview = true;
    }

    // A fee (or an unused primary leg) is still source data. Do not let a
    // malformed numeric cell look like a clean row merely because the main
    // balance leg was readable; raw retains the original text for correction.
    needsReview = needsReview
      || unreadableAmount(primaryAmount, primaryAmountCell)
      || unreadableAmount(baseAmount, baseAmountCell)
      || unreadableAmount(quoteAmount, quoteAmountCell)
      || unreadableAmount(feeAmount, feeAmountCell)
      || (feeAmount && feeAmount !== '0' && !feeAsset);

    const externalId = externalIdFor({
      operation,
      category,
      transactionId,
      baseAsset: recordBaseAsset,
      quoteAsset: recordQuoteAsset,
      occurredAt,
      orderId,
      amounts: [primaryAmountCell, baseAmountCell, quoteAmountCell, feeAmountCell],
    }, dupIndexFor);

    records.push(finalizeRecord({
      record_type: recordType,
      occurred_at: occurredAt,
      base_asset: recordBaseAsset,
      base_amount: recordBaseAmount,
      quote_asset: recordQuoteAsset,
      quote_amount: recordQuoteAmount,
      fee_asset: recordFeeAsset,
      fee_amount: recordFeeAmount,
      tx_hash: null,
      address: null,
      network: null,
      chain_id: null,
      external_id: externalId,
      needs_review: needsReview,
      raw,
    }, {
      line,
      amountCell: [primaryAmountCell, baseAmountCell, quoteAmountCell, feeAmountCell],
    }));
  }

  return {
    records,
    stats: { headerRowsSkipped, noiseRowsSkipped: 0, unknownTypes },
  };
}

module.exports = { FORMAT, detect, parse };
