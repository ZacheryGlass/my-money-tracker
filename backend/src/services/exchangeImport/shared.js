'use strict';

const crypto = require('crypto');

// Thrown when a file's shape is not something any importer can read. Fail
// closed: a half-understood export that imports "most" rows is worse than one
// that imports none, because nothing downstream can tell which rows are missing.
class ImportFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportFormatError';
    this.code = 'UNRECOGNIZED_CSV_FORMAT';
  }
}

const RECORD_TYPES = new Set([
  'trade', 'deposit', 'withdrawal', 'fee', 'reward', 'conversion', 'transfer',
]);

// Where an unrecognized row type lands. Deliberately the least committal type:
// a mystery row must not become income (which would overstate rewards) or a
// deposit/withdrawal (which would enter the on-chain matching pass and could
// pair with a real transfer). 'transfer' asserts only "value moved", and the
// needs_review flag is what actually carries the meaning.
const UNKNOWN_RECORD_TYPE = 'transfer';

// Used to decide which leg of a trade is the quote. Not exhaustive and does not
// need to be: the fallbacks below cover anything missing.
const QUOTE_ASSETS = new Set([
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY',
  'USDC', 'USDT', 'DAI', 'USDG', 'PYUSD', 'RLUSD',
]);

const SCALE = 18n;
const SCALE_FACTOR = 10n ** SCALE;

// "1.5e-8" -> "0.000000015", by moving the decimal point through the digit
// string. Number(text).toFixed() would round-trip through a float and lose
// everything past the 15th significant digit, which is exactly the range this
// column exists to hold.
function expandExponent(mantissa, exponent) {
  // A wei-scale ledger never needs more than a few hundred places; anything
  // past that is a corrupt cell, not a quantity.
  if (!Number.isFinite(exponent) || Math.abs(exponent) > 1000) return null;

  const [whole = '', fraction = ''] = mantissa.split('.');
  let digits = `${whole}${fraction}`;
  // Where the point lands once the exponent is applied.
  let point = whole.length + exponent;

  if (point <= 0) {
    digits = `${'0'.repeat(-point)}${digits}`;
    point = 0;
  } else if (point > digits.length) {
    digits = `${digits}${'0'.repeat(point - digits.length)}`;
  }

  const integer = (point === 0 ? '0' : digits.slice(0, point)).replace(/^0+(?=\d)/, '');
  const decimals = digits.slice(point);
  return decimals ? `${integer}.${decimals}` : integer;
}

// Decimal string in, decimal string out -- never a JS number. base_amount is
// NUMERIC(38,18) and satoshi/wei-scale quantities lose digits through a float
// (0.1 + 0.2 arithmetic is the mild version; 18 significant digits is the
// version that silently rewrites a balance).
//
// Returns null for anything it cannot read exactly. A null that came from a
// non-empty cell is caught by finalizeRecord and flagged -- a quantity the
// importer could not read must never look like a quantity of zero.
function cleanAmount(raw) {
  if (raw === null || raw === undefined) return null;
  let text = String(raw).trim();
  if (!text) return null;

  let negative = false;
  // Accounting-style negatives: (1.23)
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }

  // "1,5" is 1.5 in half of Europe and 15 in a thousands-separated export, and
  // nothing in the cell says which. Guessing scales a balance by ten; refusing
  // routes the row to review with the original text intact in raw.
  if (text.includes(',') && !text.includes('.')) return null;

  // Currency symbols and thousands separators. Coinbase writes both "-$2.83"
  // and "$-2.83"; stripping the symbol first collapses the two.
  text = text.replace(/[$€£¥\s,]/g, '');
  if (text.startsWith('-')) { negative = !negative; text = text.slice(1); }
  else if (text.startsWith('+')) { text = text.slice(1); }

  // Scientific notation: some exports print dust that way ("1.5e-8").
  const scientific = /^(\d+(?:\.\d*)?|\.\d+)[eE]([+-]?\d+)$/.exec(text);
  if (scientific) {
    const expanded = expandExponent(scientific[1], Number(scientific[2]));
    if (expanded === null) return null;
    text = expanded;
  }

  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(text)) return null;
  if (/^0*(\.0*)?$/.test(text)) return '0';
  return negative ? `-${text}` : text;
}

function isNegativeAmount(value) {
  return typeof value === 'string' && value.startsWith('-');
}

function negateAmount(value) {
  if (value === null || value === undefined) return null;
  if (value === '0') return '0';
  return isNegativeAmount(value) ? value.slice(1) : `-${value}`;
}

function absAmount(value) {
  if (value === null || value === undefined) return null;
  return isNegativeAmount(value) ? value.slice(1) : value;
}

function toScaled(value) {
  const negative = isNegativeAmount(value);
  const [whole, fraction = ''] = absAmount(value).split('.');
  const padded = (fraction + '0'.repeat(Number(SCALE))).slice(0, Number(SCALE));
  const scaled = BigInt(whole || '0') * SCALE_FACTOR + BigInt(padded || '0');
  return negative ? -scaled : scaled;
}

function fromScaled(scaled) {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / SCALE_FACTOR;
  const fraction = (abs % SCALE_FACTOR).toString().padStart(Number(SCALE), '0').replace(/0+$/, '');
  const text = fraction ? `${whole}.${fraction}` : `${whole}`;
  return negative && text !== '0' ? `-${text}` : text;
}

// Exact addition at NUMERIC(38,18) precision, for fee rows that arrive split.
function addAmounts(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return fromScaled(toScaled(a) + toScaled(b));
}

// A string JS already anchors to UTC: an explicit Z, an explicit offset, or a
// date-only ISO form (which the language spec defines as UTC).
const ZONE_ANCHORED = /([zZ]|[+-]\d{2}:?\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Exchange exports write UTC in three dialects; all three mean the same instant.
// Returning null (rather than guessing) is what makes the caller abort, since a
// record with no time cannot be placed in a history.
//
// Everything without a zone is read as UTC, including the formats that fall
// through to the Date constructor. Host-local parsing would make the same file
// produce different occurred_at values -- and so different content-hash ids --
// on a laptop and on the server.
function parseTimestamp(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;

  let candidate = text;
  // "2026-07-24 20:13:04 UTC" (Coinbase retail)
  const utcSuffix = /\s+UTC$/i;
  if (utcSuffix.test(candidate)) {
    candidate = `${candidate.replace(utcSuffix, '').replace(' ', 'T')}Z`;
  } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(candidate)) {
    // "2020-03-04 03:58:53" (Kraken ledgers) -- documented as UTC, and reading
    // it as server-local would shift every Kraken row by the host's offset.
    candidate = `${candidate.replace(' ', 'T')}Z`;
  }

  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) return null;
  if (ZONE_ANCHORED.test(candidate) || DATE_ONLY.test(candidate)) {
    return parsed.toISOString();
  }

  // No zone in the text, so the Date constructor read the wall clock as local.
  // Re-read the same calendar fields as UTC.
  return new Date(Date.UTC(
    parsed.getFullYear(), parsed.getMonth(), parsed.getDate(),
    parsed.getHours(), parsed.getMinutes(), parsed.getSeconds(), parsed.getMilliseconds()
  )).toISOString();
}

// Stable id for a row the exchange gave no id of its own. Content-addressed, so
// the same line in a re-exported (and longer) file collapses onto the same
// record. dupIndex distinguishes genuinely identical lines -- two 0.01 USD
// conversions at the same second are two events, not one imported twice -- and
// stays stable as long as the later export is a superset of the earlier one.
function contentId(prefix, parts, dupIndex = 0) {
  const digest = crypto
    .createHash('sha256')
    .update(parts.map((part) => String(part ?? '')).join(''))
    .digest('hex')
    .slice(0, 40);
  return dupIndex > 0 ? `${prefix}:h:${digest}:${dupIndex}` : `${prefix}:h:${digest}`;
}

// Counts identical content within one file so contentId can number repeats.
function makeDupCounter() {
  const seen = new Map();
  return (key) => {
    const next = (seen.get(key) ?? 0);
    seen.set(key, next + 1);
    return next;
  };
}

function trimTo(value, max) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

// A 20-hex-byte address, with or without the prefix some exports drop.
const HEX_ADDRESS = /^(0x)?[0-9a-fA-F]{40}$/;

// One spelling per address, so an exchange withdrawal can be matched against
// the on-chain deposit it produced: eth_transfers stores lowercase 0x-prefixed
// addresses, and a checksummed or bare-hex export would never join to it.
// Anything that is not hex-shaped -- "GDAX", "BTC Vault", a bech32 address --
// is left exactly as the exchange wrote it.
function normalizeAddress(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (!HEX_ADDRESS.test(text)) return text;
  const hex = /^0x/i.test(text) ? text.slice(2) : text;
  return `0x${hex.toLowerCase()}`;
}

function hasText(value) {
  if (Array.isArray(value)) return value.some(hasText);
  return value !== null && value !== undefined && String(value).trim() !== '';
}

// Final shape check before a record leaves an importer. Anything that would be
// rejected by the table's own constraints is caught here, where the error can
// still name the source line.
//
// `amountCell` is the raw text cleanAmount was given (a string, or one per leg
// for a paired record). A null amount read out of a non-empty cell is a
// quantity this importer could not parse, and it must not reach the history
// looking like a row the exchange left blank.
function finalizeRecord(record, { line, amountCell } = {}) {
  if (!RECORD_TYPES.has(record.record_type)) {
    throw new ImportFormatError(`Line ${line}: unsupported record type "${record.record_type}"`);
  }
  if (!record.occurred_at) {
    throw new ImportFormatError(`Line ${line}: could not read a timestamp for this row`);
  }
  if (!record.external_id) {
    throw new ImportFormatError(`Line ${line}: could not build an identifier for this row`);
  }

  const amount = record.base_amount ?? null;
  const unreadableAmount = amount === null && hasText(amountCell);

  return {
    record_type: record.record_type,
    occurred_at: record.occurred_at,
    // 20 chars is every real ticker with room to spare; a longer "asset" is a
    // contract address or a mis-read column, and the untruncated text stays in
    // raw for whoever reviews it.
    base_asset: trimTo(record.base_asset, 20),
    base_amount: amount,
    quote_asset: trimTo(record.quote_asset, 20),
    quote_amount: record.quote_amount ?? null,
    fee_asset: trimTo(record.fee_asset, 20),
    fee_amount: record.fee_amount ?? null,
    tx_hash: trimTo(record.tx_hash, 80),
    address: trimTo(normalizeAddress(record.address), 80),
    external_id: trimTo(record.external_id, 120),
    needs_review: Boolean(record.needs_review) || unreadableAmount,
    raw: record.raw ?? null,
  };
}

// Which leg of a two-leg fill is the quote. Fiat/stablecoin first, then
// "anything but USD is the base", then -- for a crypto/crypto fill, where the
// pair has no quote currency at all -- the leg that was given up. Both legs are
// stored with their own asset and sign either way, so this decides only which
// one is *called* the base; nothing is lost when the pair is genuinely
// symmetrical. Only a pair that is not a pair at all (both legs moving the same
// direction) is ambiguous enough to flag.
function pickBaseQuote(legs) {
  const quoteish = legs.filter((leg) => QUOTE_ASSETS.has(String(leg.asset || '').toUpperCase()));
  if (quoteish.length === 1) {
    const quote = quoteish[0];
    return { base: legs.find((leg) => leg !== quote), quote, ambiguous: false };
  }
  const nonUsd = legs.filter((leg) => String(leg.asset || '').toUpperCase() !== 'USD');
  if (nonUsd.length === 1) {
    const base = nonUsd[0];
    return { base, quote: legs.find((leg) => leg !== base), ambiguous: false };
  }
  const outgoing = legs.filter((leg) => isNegativeAmount(leg.amount ?? ''));
  if (outgoing.length === 1) {
    const base = outgoing[0];
    return { base, quote: legs.find((leg) => leg !== base), ambiguous: false };
  }
  return { base: legs[0], quote: legs[1], ambiguous: true };
}

// One fee column, but an exchange can charge on both legs of a fill (Kraken
// bills the quote side and often leaves a rounding crumb on the other). Same
// asset: add them. Different assets: keep the leg the exchange actually
// denominates its fee in. The untouched per-leg figures stay in the record's
// raw payload, so nothing is lost -- only the summary column has to choose.
function combineFees(fees, preferredAsset) {
  const charged = fees.filter((fee) => fee.amount && fee.amount !== '0');
  if (!charged.length) return { asset: null, amount: null };

  const assets = new Set(charged.map((fee) => fee.asset));
  const chosen = assets.size === 1
    ? charged[0].asset
    : (assets.has(preferredAsset) ? preferredAsset : charged[0].asset);

  let amount = null;
  for (const fee of charged) {
    if (fee.asset === chosen) amount = addAmounts(amount, absAmount(fee.amount));
  }
  return { asset: chosen, amount };
}

module.exports = {
  ImportFormatError,
  RECORD_TYPES,
  UNKNOWN_RECORD_TYPE,
  QUOTE_ASSETS,
  cleanAmount,
  isNegativeAmount,
  negateAmount,
  absAmount,
  addAmounts,
  parseTimestamp,
  contentId,
  makeDupCounter,
  finalizeRecord,
  pickBaseQuote,
  combineFees,
  trimTo,
  normalizeAddress,
};
