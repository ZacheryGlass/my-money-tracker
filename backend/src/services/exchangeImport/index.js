'use strict';

const { parseCsv, isBlankRow } = require('../../utils/csv');
const { ImportFormatError } = require('./shared');
const { VENUE_MODULES } = require('../../crypto/exchanges/venues');

// Every venue's CSV readers (crypto/exchanges/venues), in venue order. The
// specific readers get first refusal; their header signatures are disjoint
// (Coinbase retail alone has "Quantity Transacted", Coinbase Pro alone has
// "amount/balance unit", Kraken alone has txid+refid, Binance.US alone has
// "Realized Amount For Base Asset"), so at most one can claim a file. The
// fallback reader (generic column mapping) is tried last.
const IMPORTERS = VENUE_MODULES.filter((venue) => !venue.csvFallback).flatMap((venue) => venue.csv);
const FALLBACKS = VENUE_MODULES.filter((venue) => venue.csvFallback).flatMap((venue) => venue.csv);
const generic = FALLBACKS[0];
const BY_FORMAT = new Map([...IMPORTERS, ...FALLBACKS].map((importer) => [importer.FORMAT, importer]));

const FORMATS = [...BY_FORMAT.keys()];

/**
 * Turn CSV text into exchange_records rows.
 *
 * Fail-closed by design: a file no importer recognizes throws rather than
 * importing the subset of rows that happened to parse, and a row whose type is
 * not in the format's map is imported with needs_review set rather than
 * dropped. Silence in either direction produces a history that looks complete
 * and is not.
 *
 * @param {string} text raw CSV
 * @param {{format?: string, mapping?: object}} options `format` forces an
 *   importer ('auto' detects); `mapping` names columns for the generic reader.
 * @returns {{format: string, records: Array<object>, stats: object}}
 */
function parseExchangeCsv(text, { format = 'auto', mapping } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new ImportFormatError('The uploaded file is empty.');
  }

  const rows = parseCsv(text);
  if (!rows.some((row) => !isBlankRow(row))) {
    throw new ImportFormatError('The uploaded file has no rows.');
  }

  if (format && format !== 'auto') {
    const importer = BY_FORMAT.get(format);
    if (!importer) {
      throw new ImportFormatError(`Unknown import format "${format}". Known formats: ${FORMATS.join(', ')}.`);
    }
    // An explicit format is an assertion, and a wrong one has to fail loudly:
    // the importer's own parse() reports what it expected to see.
    const result = importer.parse(rows, { mapping });
    return { format: importer.FORMAT, ...result };
  }

  for (const importer of IMPORTERS) {
    if (importer.detect(rows)) {
      const result = importer.parse(rows, { mapping });
      return { format: importer.FORMAT, ...result };
    }
  }

  // Last resort. It maps by column name and throws a header-quoting error when
  // it cannot find a timestamp and an amount.
  const result = generic.parse(rows, { mapping });
  return { format: generic.FORMAT, ...result };
}

module.exports = { parseExchangeCsv, ImportFormatError, FORMATS };
