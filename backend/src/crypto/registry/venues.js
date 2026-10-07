'use strict';

// Exchange venue facts, one entry per venue id (the exchange_accounts CHECK
// values). Grows into the full venue registry in S5; today it carries the
// bank-statement descriptors the fiat matcher looks for, because a venue's
// legal or payment name on a bank line is rarely its account id
// ('binance_us' never appears on a statement; 'BAM Trading' does).
//
// Descriptors are lowercase substrings matched against a bank transaction's
// name and merchant_name.

const VENUES = Object.freeze({
  coinbase: Object.freeze({ id: 'coinbase', label: 'Coinbase', bankDescriptors: Object.freeze(['coinbase']) }),
  kraken: Object.freeze({ id: 'kraken', label: 'Kraken', bankDescriptors: Object.freeze(['kraken', 'payward']) }),
  binance_us: Object.freeze({
    id: 'binance_us', label: 'Binance.US', bankDescriptors: Object.freeze(['binance', 'bam trading']),
  }),
  other: Object.freeze({ id: 'other', label: 'Other', bankDescriptors: Object.freeze([]) }),
});

function venue(id) {
  return VENUES[id] || null;
}

// Parallel arrays (venue id, descriptor) for a SQL unnest().
function bankDescriptorPairs() {
  const exchanges = [];
  const descriptors = [];
  for (const entry of Object.values(VENUES)) {
    for (const descriptor of entry.bankDescriptors) {
      exchanges.push(entry.id);
      descriptors.push(descriptor);
    }
  }
  return { exchanges, descriptors };
}

module.exports = { VENUES, venue, bankDescriptorPairs };
