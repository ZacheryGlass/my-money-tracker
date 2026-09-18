'use strict';

const crypto = require('crypto');
const { cleanAmount, addAmounts } = require('./shared');

const FINGERPRINT_VERSION = 1;

// These are deliberately explicit aliases. A ticker that merely looks similar
// is not safe to collapse: the raw provider spelling remains in provenance.
const ASSET_ALIASES = Object.freeze({
  coinbase: Object.freeze({ ETH2: 'ETH', XBT: 'BTC' }),
  binance_us: Object.freeze({ XBT: 'BTC' }),
  kraken: Object.freeze({
    XETH: 'ETH', XXBT: 'BTC', XBT: 'BTC', ZUSD: 'USD', ETH2: 'ETH',
    XXDG: 'DOGE', XDG: 'DOGE',
  }),
  other: Object.freeze({}),
});

const KRAKEN_SUFFIX = /\.(?:S|M|F|P)$/;

function canonicalAsset(exchange, value) {
  let asset = String(value ?? '').trim().toUpperCase();
  if (!asset) return null;
  if (exchange === 'kraken') asset = asset.replace(KRAKEN_SUFFIX, '');
  const aliases = ASSET_ALIASES[exchange] || ASSET_ALIASES.other;
  if (aliases[asset]) return aliases[asset];
  // Kraken's remaining legacy X/Z prefixes are provider syntax, not distinct
  // assets. Do not apply this heuristic to other venues.
  if (exchange === 'kraken' && /^[XZ][A-Z]{3}$/.test(asset)) return asset.slice(1);
  return asset;
}

// cleanAmount already rejects ambiguous locale formats. Remove insignificant
// zeroes after that validation so "1.0" and "1.000000" hash identically.
function canonicalAmount(value) {
  const amount = cleanAmount(value);
  if (amount === null) return null;
  const negative = amount.startsWith('-');
  const unsigned = negative ? amount.slice(1) : amount;
  const [whole, fraction = ''] = unsigned.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  const result = trimmed ? `${whole}.${trimmed}` : whole;
  return negative && result !== '0' ? `-${result}` : result;
}

function canonicalInstant(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  // The fingerprint intentionally uses a UTC day bucket. That makes a
  // same-day, same-amount collision visible to the conservative candidate
  // path even when one provider rounds or formats the event time differently.
  // conflictingDetails compares the full instant before an automatic merge.
  return parsed.toISOString().slice(0, 10);
}

function canonicalMoment(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function canonicalText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.toLowerCase() : null;
}

function canonicalLegs(exchange, record) {
  const legs = [
    { asset: canonicalAsset(exchange, record.base_asset), amount: canonicalAmount(record.base_amount) },
    { asset: canonicalAsset(exchange, record.quote_asset), amount: canonicalAmount(record.quote_amount) },
  ].filter((leg) => leg.asset && leg.amount !== null);
  legs.sort((left, right) => `${left.asset}\u0000${left.amount}`.localeCompare(`${right.asset}\u0000${right.amount}`));
  return legs;
}

function canonicalParts(exchange, record) {
  const occurredAt = canonicalInstant(record?.occurred_at);
  const legs = canonicalLegs(exchange, record || {});
  if (!occurredAt || !record?.record_type || legs.length === 0) return null;
  if ((record.base_asset && canonicalAmount(record.base_amount) === null)
      || (record.quote_asset && canonicalAmount(record.quote_amount) === null)) {
    return null;
  }

  const feeAsset = canonicalAsset(exchange, record.fee_asset);
  const feeAmount = canonicalAmount(record.fee_amount);
  if (record.fee_asset && feeAmount === null) return null;

  return {
    version: FINGERPRINT_VERSION,
    exchange: String(exchange || 'other').toLowerCase(),
    type: String(record.record_type).toLowerCase(),
    occurred_at: occurredAt,
    legs,
    fee: feeAsset && feeAmount !== null ? { asset: feeAsset, amount: feeAmount } : null,
  };
}

function fingerprintFor(exchange, record) {
  const parts = canonicalParts(exchange, record);
  if (!parts) return null;
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function comparable(value) {
  const text = canonicalText(value);
  if (!text) return null;
  if (/^(0x)?[0-9a-f]{40,}$/i.test(text)) return text.replace(/^0x/, '');
  return text;
}

function conflictingDetails(existing, incoming) {
  const conflicts = [];
  for (const field of ['tx_hash', 'address', 'network', 'chain_id']) {
    const left = comparable(existing?.[field]);
    const right = comparable(incoming?.[field]);
    if (left && right && left !== right) conflicts.push(field);
  }
  const leftMoment = canonicalMoment(existing?.occurred_at);
  const rightMoment = canonicalMoment(incoming?.occurred_at);
  if (leftMoment && rightMoment && leftMoment !== rightMoment) conflicts.push('occurred_at');
  return conflicts;
}

function sourceSnapshot(record) {
  return {
    source: record?.source || null,
    external_id: record?.external_id || null,
    raw: record?.raw || null,
    original_assets: {
      base_asset: record?.base_asset || null,
      quote_asset: record?.quote_asset || null,
      fee_asset: record?.fee_asset || null,
    },
  };
}

function annotateRecord(exchange, record) {
  const fingerprint = fingerprintFor(exchange, record);
  // Coinbase's historical ETH2 code is staked ETH. Store the canonical asset
  // on every economic leg, not only inside the dedupe fingerprint, so all SQL
  // readers agree. Source payloads and original asset spellings stay available.
  const assets = {};
  for (const field of ['base_asset', 'quote_asset', 'fee_asset']) {
    if (exchange === 'coinbase' && record[field] === 'ETH2') assets[field] = canonicalAsset(exchange, record[field]);
  }
  return {
    ...record,
    ...assets,
    ...(Object.keys(assets).length ? {
      dedupe_provenance: [...(record.dedupe_provenance || []), sourceSnapshot(record)],
    } : {}),
    fingerprint,
    fingerprint_version: fingerprint ? FINGERPRINT_VERSION : null,
    // The insert names every column explicitly, so PostgreSQL's column
    // DEFAULT does not apply. Every ordinary row must carry FALSE; the
    // candidate path promotes it to TRUE later when ambiguity is observed.
    duplicate_candidate: Boolean(record?.duplicate_candidate),
  };
}

// Also accept historical provider snapshots that still separate staked ETH.
// Other venues and wrapped/staking receipt tokens retain their own identities.
function canonicalBalances(exchange, balances = {}) {
  const result = { ...balances };
  if (exchange === 'coinbase' && Object.hasOwn(result, 'ETH2')) {
    result.ETH = addAmounts(String(result.ETH ?? '0'), String(result.ETH2));
    delete result.ETH2;
  }
  return result;
}

function annotateRecords(exchange, records) {
  return (records || []).map((record) => annotateRecord(exchange, record));
}

module.exports = {
  FINGERPRINT_VERSION,
  ASSET_ALIASES,
  canonicalAsset,
  canonicalBalances,
  canonicalAmount,
  canonicalParts,
  canonicalInstant,
  fingerprintFor,
  conflictingDetails,
  sourceSnapshot,
  annotateRecord,
  annotateRecords,
};
