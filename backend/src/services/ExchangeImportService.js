'use strict';

const ExchangeAccount = require('../models/ExchangeAccount');
const ExchangeRecord = require('../models/ExchangeRecord');
const { parseExchangeCsv, ImportFormatError, FORMATS } = require('./exchangeImport');
const logger = require('../config/logger');

class ExchangeImportService {
  /**
   * Parse a CSV export and store what it describes against one exchange
   * account. The account must already have been resolved against the caller --
   * this method takes the id it was told and does not re-check ownership.
   */
  static async importCsv(userId, exchangeAccountId, csvText, { format = 'auto', mapping } = {}) {
    const parsed = parseExchangeCsv(csvText, { format, mapping });
    const result = await ExchangeRecord.bulkInsert(exchangeAccountId, parsed.records);

    // Stamped even when nothing new landed: the user asked for an import and
    // wants to see that it ran. "Last import" answers a question about their
    // action, not about the file's contents.
    await ExchangeAccount.touchImport(exchangeAccountId, userId);

    const needsReview = parsed.records.filter((record) => record.needs_review).length;
    logger.info({
      userId,
      exchangeAccountId,
      format: parsed.format,
      parsed: parsed.records.length,
      inserted: result.inserted,
      duplicates: result.duplicates,
      needsReview,
    }, 'Exchange CSV import');

    return {
      format: parsed.format,
      parsed: parsed.records.length,
      imported: result.inserted,
      duplicates: result.duplicates,
      needs_review: needsReview,
      // Surfaced rather than swallowed: a repeated header or a preamble block
      // that was stepped over is a fact about the file the user should see.
      skipped_header_rows: parsed.stats.headerRowsSkipped,
      skipped_noise_rows: parsed.stats.noiseRowsSkipped,
      unknown_types: parsed.stats.unknownTypes,
    };
  }
}

module.exports = ExchangeImportService;
module.exports.ImportFormatError = ImportFormatError;
module.exports.FORMATS = FORMATS;
