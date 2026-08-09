-- Keep intentional scope replacement distinct from provider unsupported status
-- and link the historical job to the replacement that superseded it.
ALTER TABLE evm_audit_jobs
  ADD COLUMN IF NOT EXISTS superseded_by_job_id BIGINT
    REFERENCES evm_audit_jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_evm_audit_jobs_superseded_by
  ON evm_audit_jobs(superseded_by_job_id)
  WHERE superseded_by_job_id IS NOT NULL;
