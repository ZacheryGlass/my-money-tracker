'use strict';

// The registry facts the frontend renders from, served once per session by
// GET /api/crypto/meta. The client keeps no copy of network, explorer,
// category or label-kind lists of its own.

const chains = require('../config/chains');
const networks = require('./registry/networks');
const vocabulary = require('./registry/vocabulary');
const { VENUES } = require('./registry/venues');
const { EXCEPTION_CATEGORY_DEFINITIONS } = require('./exchanges/core/reconciliation');

function buildCryptoMeta() {
  return {
    defaultNetworkId: chains.DEFAULT_CHAIN_ID,
    networks: chains.allChains().map((chain) => ({
      id: chain.id,
      caip2: chain.caip2,
      family: chain.family,
      name: chain.name,
      shortName: chain.shortName,
      nativeAsset: chain.nativeAsset,
      enabled: chain.enabled,
      explorer: chain.explorer,
    })),
    retiredNetworks: networks.retired.map((network) => ({ id: network.id, name: network.name })),
    vocabulary: {
      ledgerCategories: vocabulary.LEDGER_CATEGORY_DEFINITIONS.map((entry) => ({
        value: entry.value, label: entry.label, exchangeOnly: Boolean(entry.exchangeOnly),
      })),
      labelKinds: vocabulary.LABEL_KIND_DEFINITIONS.map((entry) => ({ ...entry })),
      spamReasons: Object.values(vocabulary.SPAM_REASONS),
      spamFilters: [...vocabulary.SPAM_FILTERS],
      exchangeExceptionCategories: EXCEPTION_CATEGORY_DEFINITIONS.map((entry) => ({ ...entry })),
    },
    venues: Object.values(VENUES).map((entry) => ({ id: entry.id, label: entry.label, apiSync: entry.apiSync })),
  };
}

module.exports = { buildCryptoMeta };
