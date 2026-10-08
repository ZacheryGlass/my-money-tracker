'use strict';

// Binance.US identity rules applied by ExchangeRecord.bulkInsert (the
// venue-agnostic store), declared here so the store names no venue. The SQL
// is the store's original SQL, moved verbatim.

const { canonicalAmount, canonicalAsset } = require('../../core/fingerprint');

// Binance.US keys one fill differently per source: the CSV's Transaction ID
// and the API's trade id are separate id spaces, the API rounds quoteQty and
// reports milliseconds the CSV drops. Both carry the order id, so order id +
// base leg + the second it filled identifies the fill across sources.
function orderId(record) {
  if (record?.raw?._format !== 'binance_us' || record.record_type !== 'trade') return null;
  const id = record.raw['Order ID'] ?? record.raw.orderId;
  return id === undefined || id === null || id === '' ? null : String(id);
}

function fillKey(record) {
  const id = orderId(record);
  const amount = canonicalAmount(record?.base_amount);
  const time = new Date(record?.occurred_at).getTime();
  // Canonical, so a row stored before an alias (NANO before XNO) still pairs.
  const asset = canonicalAsset('binance_us', record?.base_asset);
  if (!id || amount === null || !asset || !Number.isFinite(time)) return null;
  return `${id}|${asset}|${amount}|${Math.floor(time / 1000)}`;
}

// Stored fills of these orders, locked for the batch.
async function loadFills(database, exchangeAccountId, orderIds) {
  const { rows } = await database.query(
    `SELECT er.*
     FROM exchange_records er
     WHERE er.exchange_account_id = $1
       AND er.record_type = 'trade'
       AND er.raw->>'_format' = 'binance_us'
       AND COALESCE(er.raw->>'Order ID', er.raw->>'orderId') = ANY($2::text[])
     FOR UPDATE`,
    [exchangeAccountId, orderIds]
  );
  return rows || [];
}

// Binance capital APIs expose submission time/hash-based IDs; CSVs may expose
// later credit time/different native IDs. Legacy CSVs may also predate
// fingerprints. An amount/time resemblance is NOT identity: refuse the batch
// rather than silently count both or auto-merge them. Returns the pairs a
// person already called different events, which neither block the batch nor
// come back as same-day duplicate candidates.
async function reviewOverlaps({ database, exchangeAccountId, unique, existingById, auditedIncomingIds }) {
  const capital = unique.filter((record) => record.source === 'api'
    && record.raw?._format === 'binance_us'
    && ['deposit', 'withdrawal'].includes(record.record_type)
    && !existingById.has(record.external_id) && !auditedIncomingIds.has(record.external_id));
  let rejectedPairs = new Set();
  if (!capital.length) return rejectedPairs;
  const csv = await database.query(
    `SELECT er.* FROM exchange_records er
     WHERE er.exchange_account_id = $1
       AND er.record_type IN ('deposit', 'withdrawal')
       AND (er.source = 'csv' OR er.raw->>'_source' = 'csv')
     FOR UPDATE`, [exchangeAccountId]
  );
  let overlaps = capital.flatMap((incoming) => csv.rows.filter((existing) =>
    existing.record_type === incoming.record_type
    && existing.base_asset === incoming.base_asset
    && canonicalAmount(existing.base_amount) !== null
    && canonicalAmount(existing.base_amount) === canonicalAmount(incoming.base_amount)
    && Math.abs(new Date(existing.occurred_at) - new Date(incoming.occurred_at)) <= 86400000
    && !(existing.tx_hash && incoming.tx_hash
      && existing.tx_hash.toLowerCase() !== incoming.tx_hash.toLowerCase())
  ).map((existing) => ({ record_id: existing.id, incoming_external_id: incoming.external_id, incoming })));
  if (overlaps.length) {
    // A pair the user has said are different events must not block again.
    const rejected = await database.query(
      `SELECT record_id, incoming_external_id
       FROM exchange_overlap_reviews
       WHERE exchange_account_id = $1 AND status = 'rejected'
         AND incoming_external_id = ANY($2::text[])`,
      [exchangeAccountId, overlaps.map((overlap) => overlap.incoming_external_id)]
    );
    rejectedPairs = new Set((rejected.rows || []).map((row) => `${row.record_id}|${row.incoming_external_id}`));
    overlaps = overlaps.filter((overlap) => !rejectedPairs.has(`${overlap.record_id}|${overlap.incoming_external_id}`));
  }
  if (overlaps.length) {
    const error = new Error('Binance.US capital history overlaps existing CSV records. Review the possible duplicates before this batch can be imported.');
    error.code = 'BINANCE_US_CAPITAL_OVERLAP';
    error.candidates = overlaps;
    throw error;
  }
  return rejectedPairs;
}

module.exports = {
  reviewOverlaps,
  // Cross-source fill twins: one fill reported by the CSV and the API under
  // different native ids.
  twins: { key: fillKey, orderId, loadExisting: loadFills },
};
