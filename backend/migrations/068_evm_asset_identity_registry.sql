-- Source-backed identities used by exchange/on-chain matching. Symbols that
-- are not in this registry are intentionally not amount-matched: a ticker is
-- presentation data, not proof that two assets are the same token.
CREATE TABLE IF NOT EXISTS evm_asset_identity_registry (
  asset_code VARCHAR(30) PRIMARY KEY,
  canonical_key VARCHAR(60) NOT NULL,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- MATIC/POL intentionally share one canonical identity, so an earlier
-- development copy that made canonical_key unique must be relaxed safely.
ALTER TABLE evm_asset_identity_registry
  DROP CONSTRAINT IF EXISTS evm_asset_identity_registry_canonical_key_key;

INSERT INTO evm_asset_identity_registry (asset_code, canonical_key, source)
VALUES
  ('ETH', 'native:ETH', 'chain registry nativeAsset=ETH'),
  ('MATIC', 'native:POL', 'chain registry MATIC to POL 1:1 rename'),
  ('POL', 'native:POL', 'chain registry nativeAsset=POL'),
  ('XDAI', 'native:XDAI', 'chain registry nativeAsset=XDAI')
ON CONFLICT (asset_code) DO UPDATE
SET canonical_key = EXCLUDED.canonical_key, source = EXCLUDED.source;
