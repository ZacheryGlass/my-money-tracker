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

// The venue that produced a record, from its raw._format: a venue's API
// records carry the venue id, its CSV records the reader's FORMAT.
function venueForFormat(format) {
  if (!format) return null;
  return VENUE_MODULES.find((venue) => venue.id === format
    || (venue.csv || []).some((reader) => reader.FORMAT === format)) || null;
}

// The identity hooks that apply to a batch: those of the account's venue and
// of every venue whose records are in it (each hook still checks the record's
// own format). twins comes from the first venue that declares it.
function identityHooksFor(exchange, records) {
  const ids = new Set([exchange, ...(records || []).map((record) => venueForFormat(record?.raw?._format)?.id)]);
  const hooks = [...ids].filter(Boolean).map((id) => venueModule(id)?.identity).filter(Boolean);
  return {
    validateBatch: (ctx) => { for (const hook of hooks) hook.validateBatch?.(ctx); },
    reviewOverlaps: async (ctx) => {
      const rejected = new Set();
      for (const hook of hooks) {
        if (!hook.reviewOverlaps) continue;
        for (const pair of await hook.reviewOverlaps(ctx)) rejected.add(pair);
      }
      return rejected;
    },
    twins: hooks.find((hook) => hook.twins)?.twins || null,
  };
}

module.exports = { VENUE_MODULES, venueModule, venueForFormat, identityHooksFor };
