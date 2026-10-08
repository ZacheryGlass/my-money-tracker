'use strict';

// Binance.US: the account activity export and the signed read-only connector.
// Code modules load lazily so the venue registry stays metadata-only.

module.exports = {
  id: 'binance_us',
  order: 30,
  metadata: {
    label: 'Binance.US',
    errorPrefix: 'BINANCE_US',
    extraAuthCodes: [],
    // BAM Trading Services is Binance.US's operating company on statements.
    bankDescriptors: ['binance', 'bam trading'],
  },
  hasConnector: true,
  get credentials() {
    return {
      keyLabel: 'API key',
      secretLabel: 'Secret key',
      permissions: require('./connector').REQUIRED_PERMISSIONS,
      help: 'Create an API key with read-only permissions. This integration only calls signed GET endpoints; never grant trading, withdrawal, or transfer permissions.',
    };
  },
  get csv() { return [require('./csv')]; },
  get connector() { return require('./connector'); },
  get assets() { return require('./assets'); },
};
