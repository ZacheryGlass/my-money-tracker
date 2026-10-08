'use strict';

// The exchange venues: every directory here with an index.js is one venue
// (id = the exchange_accounts.exchange value). Adding an exchange is adding a
// directory -- metadata, CSV readers, optional read-only connector -- plus the
// CHECK-widening migration that admits its id. Ordered by `order`, which is
// also the order CSV readers get first refusal on an upload.
//
// CRYPTO_EXTRA_VENUES_DIR adds a second directory, for the extensibility
// acceptance test.

const fs = require('fs');
const path = require('path');

function loadDir(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'index.js')))
    .map((entry) => require(path.join(dir, entry.name, 'index.js')));
}

const VENUE_MODULES = [
  ...loadDir(__dirname),
  ...(process.env.CRYPTO_EXTRA_VENUES_DIR ? loadDir(path.resolve(process.env.CRYPTO_EXTRA_VENUES_DIR)) : []),
].sort((a, b) => a.order - b.order);

const seen = new Set();
for (const venue of VENUE_MODULES) {
  if (!venue.id || !venue.metadata?.label || !Number.isFinite(venue.order)) {
    throw new Error(`venue ${venue.id || '(unnamed)'} needs an id, an order and metadata.label`);
  }
  if (seen.has(venue.id)) throw new Error(`duplicate venue ${venue.id}`);
  seen.add(venue.id);
}

function venueModule(id) {
  return VENUE_MODULES.find((venue) => venue.id === id) || null;
}

module.exports = { VENUE_MODULES, venueModule };
