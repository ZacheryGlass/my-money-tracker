'use strict';

// Kraken identity rules applied by ExchangeRecord.bulkInsert (the
// venue-agnostic store), declared here so the store names no venue.

const { fingerprintFor } = require('../../core/fingerprint');

// A secondary Kraken fee row belongs to its trade (raw.parent_external_id).
// Importing it without the complete trade -- or against a stored half trade
// that this batch cannot upgrade -- could charge one fee twice, so the batch
// is refused.
function validateBatch({ unique, byId, existingById }) {
  for (const fee of unique) {
    const parentId = fee.raw?._format === 'kraken' && fee.record_type === 'fee'
      ? fee.raw.parent_external_id : null;
    if (!parentId || existingById.has(fee.external_id)) continue;
    const incomingParent = byId.get(parentId);
    const storedParent = existingById.get(parentId);
    // A manually accepted half trade cannot be upgraded. Adding its
    // companion fee anyway could charge a fee already on that half twice.
    if (!incomingParent || (storedParent
      && !(storedParent.needs_review && !incomingParent.needs_review)
      && fingerprintFor('kraken', storedParent) !== fingerprintFor('kraken', incomingParent))) {
      const error = new Error('Kraken secondary fee requires its complete trade. Review the existing trade before importing this fee.');
      error.code = 'EXCHANGE_FEE_PARENT_CONFLICT';
      throw error;
    }
  }
}

module.exports = { validateBatch };
