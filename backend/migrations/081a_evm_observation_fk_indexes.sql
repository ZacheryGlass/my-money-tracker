-- 081a: support foreign-key checks when provider observations are retired.
--
-- PostgreSQL does not automatically index referencing columns. These indexes
-- keep deletes from evm_provider_observations from repeatedly scanning each
-- child table while enforcing its foreign keys.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_evm_job_observations_observation_fk
  ON evm_job_observations(observation_id, subject_id, chain_id);

CREATE INDEX IF NOT EXISTS idx_evm_effect_evidence_observation_fk
  ON evm_effect_evidence(observation_id, subject_id, chain_id);

CREATE INDEX IF NOT EXISTS idx_evm_transaction_evidence_observation_fk
  ON evm_transaction_evidence(observation_id, subject_id, chain_id);

CREATE INDEX IF NOT EXISTS idx_eth_transfers_audit_observation_fk
  ON eth_transfers(audit_observation_id);

CREATE INDEX IF NOT EXISTS idx_evm_canonical_effects_selected_observation_fk
  ON evm_canonical_effects(selected_observation_id, subject_id, chain_id);

CREATE INDEX IF NOT EXISTS idx_evm_mined_transactions_selected_observation_fk
  ON evm_mined_transactions(selected_observation_id, subject_id, chain_id);

COMMIT;
