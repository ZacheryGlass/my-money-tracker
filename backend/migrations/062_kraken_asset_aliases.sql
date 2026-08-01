-- Canonicalize explicitly verified Kraken numbered/staked aliases in stored
-- records. The provider code remains in raw JSON; only the three canonical
-- asset columns used by derived balances and matching are corrected.
--
-- This is intentionally an exact, Kraken-scoped update. Migrations run on
-- every boot, so values already rewritten to SOL make a later pass a no-op.
UPDATE exchange_records er
SET base_asset = CASE
      WHEN er.base_asset IN ('SOL03', 'SOL03.S') THEN 'SOL'
      ELSE er.base_asset
    END,
    quote_asset = CASE
      WHEN er.quote_asset IN ('SOL03', 'SOL03.S') THEN 'SOL'
      ELSE er.quote_asset
    END,
    fee_asset = CASE
      WHEN er.fee_asset IN ('SOL03', 'SOL03.S') THEN 'SOL'
      ELSE er.fee_asset
    END
FROM exchange_accounts ea
WHERE ea.id = er.exchange_account_id
  AND ea.exchange = 'kraken'
  AND (
    er.base_asset IN ('SOL03', 'SOL03.S')
    OR er.quote_asset IN ('SOL03', 'SOL03.S')
    OR er.fee_asset IN ('SOL03', 'SOL03.S')
  );
