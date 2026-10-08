'use strict';

// Kraken asset codes -> one canonical code, the SAME function for stored legs,
// fingerprints and balance snapshots. Kraken used to have two tables that
// disagreed (the ledger stripped any one-letter wallet suffix and knew SOL03;
// the fingerprint stripped only .S/.M/.F/.P and did not), so a balance code
// and a ledger leg could name one position two ways. Decision: the ledger's
// rule wins -- strip ANY single-letter suffix, because a suffix Kraken adds
// next year must not silently split a position. Stored legs were always
// written through this rule, so no stored fingerprint changes (version 1).
//
// Order: suffix, legacy code map, legacy X/Z prefix, then explicitly verified
// economic aliases. `identity` is the code before economic aliasing.

const VERSION = 1;

// Kraken's legacy asset codes. ETH2 was the pre-merge staked-ETH ticker and is
// the same asset today; leaving it distinct would split one ETH position in
// two. Undocumented but empirically stable -- Kraken's own Balance example
// (https://docs.kraken.com/api/docs/rest-api/get-account-balance) shows XETH,
// ETH2 and ETH2.S side by side in one response.
const LEGACY_CODES = Object.freeze({
  XETH: 'ETH',
  XXBT: 'BTC',
  XBT: 'BTC',
  ZUSD: 'USD',
  ETH2: 'ETH',
  XXDG: 'DOGE',
  XDG: 'DOGE',
});

// Explicitly verified economic aliases: two provider assets that are the same
// position. Do not turn this into a generic "strip digits" rule -- a future
// numbered ticker needs evidence first.
const ECONOMIC_ALIASES = Object.freeze({
  SOL03: 'SOL',
});

// .S staked, .M opt-in rewards, .P parachain are documented
// (https://support.kraken.com/articles/360039879471-what-is-asset-s-and-asset-m-);
// .F (Kraken Rewards) and .B (bonded) are not, which is exactly why this
// strips ANY single-letter suffix rather than an allowlist.
const SUFFIX = /\.[A-Z]$/;

function parts(raw) {
  let asset = String(raw ?? '').trim().toUpperCase();
  if (!asset) return { asset: null, identity: null };
  asset = asset.replace(SUFFIX, '');
  if (LEGACY_CODES[asset]) asset = LEGACY_CODES[asset];
  // Legacy four-character codes: X<crypto>, Z<fiat> (XLTC, ZEUR). Three-letter
  // tickers are left alone, so ADA and DOT are untouched.
  if (/^[XZ][A-Z]{3}$/.test(asset)) asset = asset.slice(1);
  return { asset: ECONOMIC_ALIASES[asset] || asset, identity: asset };
}

const canonical = (raw) => parts(raw).asset;

module.exports = {
  VERSION, parts, canonical, stored: canonical, LEGACY_CODES, ECONOMIC_ALIASES,
  // Codes merged inside balance snapshots: none beyond canonical(), which the
  // Kraken connector applies to every balance code itself.
  STORED_ALIASES: Object.freeze({}),
};
