'use strict';

// Kraken: CSV ledgers export, read-only REST connector, shared ledger
// normalizer (one row shape for both, so CSV-after-API is pure duplicates).
// Code modules load lazily so the venue registry stays metadata-only.

module.exports = {
  id: 'kraken',
  order: 20,
  metadata: {
    label: 'Kraken',
    errorPrefix: 'KRAKEN',
    extraAuthCodes: [],
    // Payward, Inc. is Kraken's operating company on bank statements.
    bankDescriptors: ['kraken', 'payward'],
  },
  hasConnector: true,
  get credentials() {
    return {
      keyLabel: 'API key',
      secretLabel: 'Private key',
      // https://support.kraken.com/articles/360000919966-how-to-create-an-api-key
      permissions: require('./connector').REQUIRED_PERMISSIONS,
      help: 'Create the key with ONLY Query Funds, Query Ledger Entries and Query Closed Orders & Trades. '
        + 'Do not grant Withdraw Funds — withdrawal destinations are readable with Query Ledger Entries alone.',
    };
  },
  get csv() { return [require('./csv')]; },
  get connector() { return require('./connector'); },
  get assets() { return require('./assets'); },
  get identity() { return require('./identity'); },
};
