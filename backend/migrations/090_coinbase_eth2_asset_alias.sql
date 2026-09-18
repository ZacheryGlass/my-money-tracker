-- ETH2 was Coinbase's label for staked ETH, not a separate economic asset.
-- Canonicalize every leg used by balances, matching and the ETH ledger. Keep
-- quantities, IDs, raw payloads, provenance and reviewed decisions unchanged.
-- Existing fingerprints already canonicalize ETH2 to ETH and remain valid.
WITH changed AS (
  UPDATE exchange_records er
     SET base_asset = CASE WHEN er.base_asset = 'ETH2' THEN 'ETH' ELSE er.base_asset END,
         quote_asset = CASE WHEN er.quote_asset = 'ETH2' THEN 'ETH' ELSE er.quote_asset END,
         fee_asset = CASE WHEN er.fee_asset = 'ETH2' THEN 'ETH' ELSE er.fee_asset END
    FROM exchange_accounts ea
   WHERE ea.id = er.exchange_account_id AND ea.exchange = 'coinbase'
     AND (er.base_asset = 'ETH2' OR er.quote_asset = 'ETH2' OR er.fee_asset = 'ETH2')
  RETURNING er.exchange_account_id
)
UPDATE exchange_accounts ea
   SET reconciliation_status = 'stale',
       balance_report = COALESCE(ea.balance_report, '{}'::jsonb) || jsonb_build_object(
         'mismatch_is_current', false,
         'stale_reasons', COALESCE(ea.balance_report->'stale_reasons', '[]'::jsonb)
           || '["asset_alias_normalized"]'::jsonb)
 WHERE ea.id IN (SELECT exchange_account_id FROM changed);
