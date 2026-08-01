'use strict';

const ExchangeAccount = require('../models/ExchangeAccount');
const ExchangeRecord = require('../models/ExchangeRecord');
const ExchangeMatchService = require('./ExchangeMatchService');
const TransactionClassificationService = require('./TransactionClassificationService');
const ExchangeReconciliationService = require('./ExchangeReconciliationService');
const { parseExchangeCsv } = require('./exchangeImport');
const { annotateRecords } = require('./exchangeImport/canonicalFingerprint');
const logger = require('../config/logger');

class ExchangeImportService {
  /**
   * Parse a CSV export and store what it describes against one exchange
   * account. Fail-closed like every other scoped entry point: the account is
   * resolved under the caller's userId BEFORE anything is written, because
   * bulkInsert keys on the raw account id and the only other scoped call
   * (touchImport) runs after the insert -- too late to be the gate.
   */
  static async importCsv(userId, exchangeAccountId, csvText, { format = 'auto', mapping } = {}) {
    const account = await ExchangeAccount.findByIdForUser(exchangeAccountId, userId);
    if (!account) {
      const error = new Error('Exchange account not found');
      error.code = 'EXCHANGE_ACCOUNT_NOT_FOUND';
      throw error;
    }
    const parsed = parseExchangeCsv(csvText, { format, mapping });
    // External ids are provider/source replay keys. The shared fingerprint is
    // the separate, conservative cross-source identity used when those ids
    // differ; raw provenance remains attached for review and audit.
    const records = annotateRecords(account.exchange, parsed.records.map((record) => ({ ...record, source: 'csv' })));
    const { result, reconciliation } = await ExchangeAccount.withImportTransaction(
      exchangeAccountId,
      userId,
      async (client, lockedAccount) => {
        const inserted = await ExchangeRecord.bulkInsert(exchangeAccountId, records, { client });

        // Stamped even when nothing new landed: the user asked for an import
        // and wants to see that it ran. "Last import" answers a question about
        // their action, not about the file's contents.
        await ExchangeAccount.touchImport(exchangeAccountId, userId, { client });
        const recomputed = await ExchangeReconciliationService.recomputeForAccount(
          userId,
          exchangeAccountId,
          { client, account: lockedAccount }
        );
        return { result: inserted, reconciliation: recomputed };
      }
    );

    // The records that just landed are the missing half of on-chain transfers
    // already sitting flagged in the activity feed (#61). Re-deriving here is
    // what makes "import the export" the actual fix for those flags, instead of
    // something that only takes effect at the next wallet sync.
    const matches = await ExchangeMatchService.rebuildForUserSafely(userId, { exchangeAccountId });
    await TransactionClassificationService.backfillForUser(userId);

    const needsReview = parsed.records.filter((record) => record.needs_review).length;
    logger.info({
      userId,
      exchangeAccountId,
      format: parsed.format,
      parsed: parsed.records.length,
      inserted: result.inserted,
      upgraded: result.upgraded,
      duplicates: result.duplicates,
      deduplicated: result.deduplicated,
      duplicate_candidates: result.duplicateCandidates,
      duplicate_conflicts: result.duplicateConflicts,
      needsReview,
      matched: matches?.matches ?? 0,
      reconciliationStatus: reconciliation.status,
    }, 'Exchange CSV import');

    return {
      format: parsed.format,
      parsed: parsed.records.length,
      imported: result.inserted,
      // Records an earlier, shorter export could only half describe, completed
      // by this one. Counted apart from "imported" because nothing new arrived
      // and apart from "duplicates" because something did change.
      upgraded: result.upgraded,
      duplicates: result.duplicates,
      deduplicated: result.deduplicated,
      duplicate_candidates: result.duplicateCandidates,
      duplicate_conflicts: result.duplicateConflicts,
      needs_review: needsReview,
      matched: matches?.matches ?? 0,
      // Surfaced rather than swallowed: a repeated header or a preamble block
      // that was stepped over is a fact about the file the user should see.
      skipped_header_rows: parsed.stats.headerRowsSkipped,
      skipped_noise_rows: parsed.stats.noiseRowsSkipped,
      unknown_types: parsed.stats.unknownTypes,
      reconciliation_status: reconciliation.status,
      reconciliation: reconciliation.report,
    };
  }
}

module.exports = ExchangeImportService;
