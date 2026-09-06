-- A worker-level failure can end an audit job after a scope was marked
-- running but before the chain-level catch updates that scope. A terminal job
-- cannot have live work, so close those stale scopes without discarding their
-- retained pages, observations, attempts, or cursor.
UPDATE evm_audit_scopes sc
   SET status = CASE
         WHEN j.status = 'deferred' THEN 'deferred'
         WHEN j.status = 'unsupported' THEN 'unsupported'
         ELSE 'failed'
       END,
       pagination_exhausted = FALSE,
       error_code = COALESCE(sc.error_code, j.error_code,
         CASE WHEN j.status = 'cancelled' THEN 'AUDIT_JOB_CANCELLED'
              ELSE 'EVM_AUDIT_INCOMPLETE' END),
       error_detail = COALESCE(sc.error_detail, j.error_detail,
         'The audit job ended before this scope completed.'),
       updated_at = CURRENT_TIMESTAMP
  FROM evm_audit_jobs j
 WHERE sc.job_id = j.id
   AND sc.status IN ('queued', 'running')
   AND j.status NOT IN ('queued', 'running');
