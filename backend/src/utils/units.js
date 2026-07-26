'use strict';

// BigInt base-unit helpers shared by the crypto services. The point of this
// module is the NAMES: two same-named toBigInt helpers with opposite failure
// semantics used to live in EthActivityService (bad input -> 0n) and
// EthReconciliationService (bad input -> null), one wrong import away from
// turning "cannot read" into "zero" inside the balance audit. The divergences
// are API now:
//
//   toBigIntLenient  null/bad -> 0n, truncates at '.'  -- one malformed row
//                    must not throw mid-rebuild
//   toBigIntOrNull   null/bad -> null, rejects '.'     -- null means "cannot
//                    read", which the audit reports as unavailable, never zero
//   absBigInt        magnitude of a BigInt
//   formatUnits      base units -> full-precision magnitude string
//
// Deliberately NOT here, each with its own documented contract where it lives:
// EthWalletService.unitsToDecimalString (clamps to holdings DECIMAL(20,8)),
// CryptoLedger's weiToDecimalString/trimDecimal/toBaseUnits (signed
// presentation trio for the ledger API), exchangeImport/shared's
// toScaled/fromScaled (NUMERIC(38,18) import contract where throwing IS the
// fail-closed policy), the bridge pairing's scaleAmount (refusing an
// unreadable leg is the pairing policy), and TaxLotService's toUnits/fromUnits
// (quantity scale 8).

// NUMERIC(78,0) arrives as a string. Tolerates null and a stray scale so one
// malformed row cannot throw mid-rebuild.
function toBigIntLenient(value) {
  if (value === null || value === undefined) return 0n;
  const text = String(value).trim();
  if (!text) return 0n;
  const whole = text.split('.')[0];
  try {
    return BigInt(whole);
  } catch {
    return 0n;
  }
}

// Strict integer parse: anything unreadable -- including a decimal point -- is
// null, not zero. The null is load-bearing for the balance audit: a live
// balance it cannot parse is "unavailable", and coercing that to 0n would
// report a drift the chain does not have. Callers that DO mean zero say so
// with `?? 0n`.
function toBigIntOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) return null;
  return BigInt(text);
}

function absBigInt(value) {
  return value < 0n ? -value : value;
}

// Base units -> a whole-unit decimal string. Sign is carried by the caller
// (activity legs carry `direction`), so this returns the magnitude. NOT
// EthWalletService.unitsToDecimalString: that one clamps to the holdings
// column's DECIMAL(20,8); this is full precision, for display inside legs
// JSONB where nothing bounds the scale.
function formatUnits(value, decimals) {
  const abs = absBigInt(value);
  if (decimals <= 0) return abs.toString();
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

module.exports = {
  toBigIntLenient,
  toBigIntOrNull,
  absBigInt,
  formatUnits,
};
