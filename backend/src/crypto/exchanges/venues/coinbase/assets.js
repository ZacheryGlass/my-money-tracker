'use strict';

// Coinbase asset codes. ETH2 was Coinbase's label for staked ETH (one
// position, so it is rewritten on stored legs too); XBT is only a fingerprint
// alias. Wrapped and staking receipt tokens (cbETH) keep their own identity.

const VERSION = 1;
const FINGERPRINT_ALIASES = Object.freeze({ ETH2: 'ETH', XBT: 'BTC' });
const STORED_ALIASES = Object.freeze({ ETH2: 'ETH' });
const upper = (raw) => String(raw ?? '').trim().toUpperCase() || null;

module.exports = {
  VERSION,
  canonical: (raw) => { const asset = upper(raw); return asset && (FINGERPRINT_ALIASES[asset] || asset); },
  stored: (raw) => STORED_ALIASES[raw] || raw,
  FINGERPRINT_ALIASES,
  STORED_ALIASES,
};
