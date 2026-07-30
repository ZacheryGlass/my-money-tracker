-- 053: preserve every asset in a multi-asset bridge bundle.
--
-- 044 intentionally matched only one fungible leg per activity row. That was
-- safe, but left a real bundle (for example POL plus USDC in one Polygon
-- bridge transaction) unexplained. The link remains one row per pair, while
-- this optional JSONB column carries one exact out/in/fee tuple per asset.
-- The existing scalar columns stay as the first asset for backwards-compatible
-- readers and remain authoritative for old single-asset links.
--
-- Re-runs on every boot and is safe for existing links: NULL means the legacy
-- single-asset representation.
ALTER TABLE eth_activity_links
  ADD COLUMN IF NOT EXISTS asset_details JSONB;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_activity_links'::regclass
                   AND conname = 'eth_activity_links_asset_details_check') THEN
    ALTER TABLE eth_activity_links
      ADD CONSTRAINT eth_activity_links_asset_details_check
      CHECK (asset_details IS NULL OR jsonb_typeof(asset_details) = 'array');
  END IF;
END $$;
