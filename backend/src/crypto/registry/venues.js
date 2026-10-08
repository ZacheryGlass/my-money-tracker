'use strict';

// Exchange venue facts, one entry per venue id (the exchange_accounts CHECK
// values), read from each venue folder's metadata. Each venue's code lists
// (error codes, bank descriptors, labels) derive from here instead of being
// retyped in services and routes.
//
//   label          display name; also the managed holdings account prefix
//   errorPrefix    the venue client's error-code prefix: <PREFIX>_RATE_LIMITED,
//                  <PREFIX>_API_ERROR, <PREFIX>_AUTH_FAILED (plus extraAuthCodes)
//   apiSync        whether a read-only API connector exists ('other' is CSV-only)
//   bankDescriptors lowercase substrings that identify the venue on a bank
//                  statement line ('binance_us' never appears on one; 'BAM
//                  Trading' does) -- read by the fiat matcher

// Built from the venue folders (crypto/exchanges/venues/<id>/index.js).
const { VENUE_MODULES } = require('../exchanges/venues');

const VENUES = Object.freeze(Object.fromEntries(VENUE_MODULES.map((venue) => [venue.id, Object.freeze({
  id: venue.id,
  label: venue.metadata.label,
  errorPrefix: venue.metadata.errorPrefix || null,
  apiSync: Boolean(venue.hasConnector),
  extraAuthCodes: Object.freeze([...(venue.metadata.extraAuthCodes || [])]),
  bankDescriptors: Object.freeze([...(venue.metadata.bankDescriptors || [])]),
})])));

const VENUE_IDS = Object.freeze(Object.keys(VENUES));

function venue(id) {
  return VENUES[id] || null;
}

// Every API venue's code of one kind: 'RATE_LIMITED', 'API_ERROR' or
// 'AUTH_FAILED' (the last also includes each venue's extra auth codes).
function venueErrorCodes(kind) {
  const codes = Object.values(VENUES)
    .filter((entry) => entry.errorPrefix)
    .flatMap((entry) => [
      `${entry.errorPrefix}_${kind}`,
      ...(kind === 'AUTH_FAILED' ? entry.extraAuthCodes : []),
    ]);
  return new Set(codes);
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

module.exports = { VENUES, VENUE_IDS, venue, venueErrorCodes, bankDescriptorPairs };
