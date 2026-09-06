-- Correct Coinbase Pro crypto-to-crypto trade orientation from the source
-- statement's `product` column. The older importer used the outgoing leg as
-- base when neither asset was fiat/stable, so an ETH-BTC buy was stored as a
-- negative BTC base leg and positive ETH quote leg. Both values were retained,
-- but the economic labels and direction were reversed.
--
-- The raw payload is authoritative and remains unchanged. Update only rows
-- with one unambiguous product across every retained source leg and whose
-- current asset pair is exactly reversed. The canonical fingerprint sorts legs
-- before hashing, so swapping their labels and amounts leaves it unchanged.
-- Re-running this migration is a no-op because corrected rows no longer match
-- the reversed-pair predicate.
WITH product_rows AS (
  SELECT er.id,
         UPPER(TRIM(source_row ->> 'product')) AS product
    FROM exchange_records er
    JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(er.raw -> 'rows') = 'array'
           THEN er.raw -> 'rows' ELSE '[]'::jsonb END
    ) AS source_row
   WHERE ea.exchange = 'coinbase'
     AND er.record_type = 'trade'
     AND er.raw ->> '_format' = 'coinbase_pro'
     AND TRIM(COALESCE(source_row ->> 'product', '')) ~ '^[A-Za-z0-9.]+-[A-Za-z0-9.]+$'
), unambiguous_products AS (
  SELECT id, MIN(product) AS product
    FROM product_rows
   GROUP BY id
  HAVING COUNT(DISTINCT product) = 1
), corrections AS (
  SELECT er.id,
         SPLIT_PART(up.product, '-', 1) AS product_base,
         SPLIT_PART(up.product, '-', 2) AS product_quote
    FROM exchange_records er
    JOIN unambiguous_products up ON up.id = er.id
   WHERE SPLIT_PART(up.product, '-', 1) <> SPLIT_PART(up.product, '-', 2)
     AND UPPER(er.base_asset) = SPLIT_PART(up.product, '-', 2)
     AND UPPER(er.quote_asset) = SPLIT_PART(up.product, '-', 1)
)
UPDATE exchange_records er
   SET base_asset = corrections.product_base,
       base_amount = er.quote_amount,
       quote_asset = corrections.product_quote,
       quote_amount = er.base_amount
  FROM corrections
 WHERE er.id = corrections.id;
