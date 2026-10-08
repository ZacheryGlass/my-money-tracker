'use strict';

// Coinbase: the retail transactions export and the Coinbase Pro / Exchange
// statement (told apart by their own headers), plus the CDP read-only
// connector. Code modules load lazily so the venue registry stays
// metadata-only.

module.exports = {
  id: 'coinbase',
  order: 10,
  metadata: {
    label: 'Coinbase',
    errorPrefix: 'COINBASE',
    extraAuthCodes: ['COINBASE_KEY_FORMAT'],
    bankDescriptors: ['coinbase'],
  },
  hasConnector: true,
  get credentials() {
    return {
      keyLabel: 'Key name',
      secretLabel: 'Private key (ECDSA PEM)',
      // https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/rest-api
      permissions: require('./connector').REQUIRED_PERMISSIONS,
      help: 'Create a CDP secret API key with the View permission only — no Trade, no Transfer. '
        + 'Choose ECDSA as the signature algorithm; Ed25519 keys are not supported by these APIs.',
    };
  },
  get csv() { return [require('./csvRetail'), require('./csvPro')]; },
  get connector() { return require('./connector'); },
};
