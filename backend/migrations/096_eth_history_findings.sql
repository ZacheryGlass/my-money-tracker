-- Dated, evidence-backed assessments, not transactions or reconciliation
-- adjustments. Ownership is inherited from the existing account/wallet.
ALTER TABLE exchange_accounts ADD COLUMN IF NOT EXISTS eth_history_findings JSONB
  CHECK (jsonb_typeof(eth_history_findings) = 'object');
ALTER TABLE eth_wallet_chains ADD COLUMN IF NOT EXISTS eth_history_findings JSONB
  CHECK (jsonb_typeof(eth_history_findings) = 'object');
