'use strict';

// CoinGecko's tiers, in one place, because getting them wrong FAILS SILENTLY.
//
// A demo key belongs on api.coingecko.com under `x-cg-demo-api-key`; a paid key
// belongs on pro-api.coingecko.com under `x-cg-pro-api-key`. Send a key under a
// header the host does not read and it is simply ignored -- no 401, no warning.
// The call degrades to the anonymous pool, and for the historical series that
// means the 365-day cap stays in force on a key that was bought to lift it.
//
// Nothing in a key's text distinguishes the tiers (both spell CG-...), so the
// tier is DECLARED, not sniffed: CG_API_PLAN=pro. Default is demo, which is
// what a free deployment has.
const DEMO_BASE = 'https://api.coingecko.com/api/v3';
const PRO_BASE = 'https://pro-api.coingecko.com/api/v3';

function isPro() {
  return String(process.env.CG_API_PLAN || '').trim().toLowerCase() === 'pro';
}

function baseUrl() {
  return isPro() ? PRO_BASE : DEMO_BASE;
}

function keyHeader() {
  return isPro() ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key';
}

// Moves an already-built api.coingecko.com URL onto the pro host when the plan
// says so. For callers that assemble their URLs from string literals; new code
// should build on baseUrl() instead.
function withPlanHost(url) {
  return isPro() ? String(url).replace(DEMO_BASE, PRO_BASE) : String(url);
}

module.exports = { DEMO_BASE, PRO_BASE, isPro, baseUrl, keyHeader, withPlanHost };
