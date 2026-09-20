-- User-triggered jobs can outlive one HTTP request.  A heartbeat distinguishes
-- a live worker on another App Service instance from a process that died after
-- it claimed the partial unique job_logs slot.
ALTER TABLE job_logs
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMP;

UPDATE job_logs
SET heartbeat_at = started_at
WHERE status = 'running' AND heartbeat_at IS NULL;
