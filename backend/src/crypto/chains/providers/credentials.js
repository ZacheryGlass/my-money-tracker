'use strict';

// The user credential each provider family needs, resolved in one place. The
// Etherscan-compatible adapter needs the explorer key (keyless explorers
// declare requiresApiKey: false and ignore it); every caller that walks
// account history or reads balances asks here rather than naming a service.

const EXPLORER_CREDENTIAL = Object.freeze({ service: 'etherscan', label: 'Etherscan' });

// Resolved through SecretsService at call time (DB value, then env fallback);
// lazy so the registry stays free of the database at load.
function explorerKeyFor(userId) {
  return require('../../../services/SecretsService').getUserKey(userId, EXPLORER_CREDENTIAL.service);
}

module.exports = { EXPLORER_CREDENTIAL, explorerKeyFor };
