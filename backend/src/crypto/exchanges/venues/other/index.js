'use strict';

// Any other venue: CSV only, through the generic column-mapping reader, which
// is also the last-resort reader for a file no venue recognizes.

module.exports = {
  id: 'other',
  order: 90,
  metadata: {
    label: 'Other',
    errorPrefix: null,
    extraAuthCodes: [],
    bankDescriptors: [],
  },
  hasConnector: false,
  credentials: null,
  // The fallback reader: tried only after every venue's own reader declined.
  csvFallback: true,
  get csv() { return [require('./csv')]; },
  connector: null,
  // Codes are kept as written (uppercased): a generic file names no venue
  // whose aliases could apply.
  assets: {
    VERSION: 1,
    canonical: (raw) => String(raw ?? '').trim().toUpperCase() || null,
    stored: (raw) => raw,
    STORED_ALIASES: {},
  },
};
