-- Matching is derived evidence and must not overwrite the import-quality
-- review queue. Migration 065's fiat rebuild marked every unmatched fiat rail
-- event as an importer problem, even when the parser had read it completely.
-- Clear only complete, non-dedupe deposit/withdrawal rows; malformed and
-- possible-duplicate records remain reviewable.
UPDATE exchange_records
SET needs_review = FALSE
WHERE needs_review = TRUE
  AND duplicate_candidate = FALSE
  AND record_type IN ('deposit', 'withdrawal')
  AND UPPER(base_asset) IN ('USD', 'USDC', 'EUR', 'GBP', 'CAD')
  AND base_amount IS NOT NULL;
