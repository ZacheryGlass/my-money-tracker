'use strict';

// Binance.US asset codes. The API reports the legacy USD market's quote and
// commission as USD4 where the CSV of the same fills says USD; NANO was
// renamed XNO (2021 fills say NANO, deposits and balances say XNO). Both are
// rewritten on stored legs; XBT is only a fingerprint alias.

const VERSION = 1;
const FINGERPRINT_ALIASES = Object.freeze({ XBT: 'BTC', USD4: 'USD', NANO: 'XNO' });
const STORED_ALIASES = Object.freeze({ USD4: 'USD', NANO: 'XNO' });
const upper = (raw) => String(raw ?? '').trim().toUpperCase() || null;

module.exports = {
  VERSION,
  canonical: (raw) => { const asset = upper(raw); return asset && (FINGERPRINT_ALIASES[asset] || asset); },
  stored: (raw) => STORED_ALIASES[raw] || raw,
  FINGERPRINT_ALIASES,
  STORED_ALIASES,
};
