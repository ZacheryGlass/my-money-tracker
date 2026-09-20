'use strict';

// A subject may be audited one chain at a time. Select the newest job relevant
// to each chain, rather than the newest job for the whole subject: otherwise a
// fresh single-chain run hides older evidence for the other chains. Explicit
// requests/discovery and persisted chain evidence all establish relevance.
const LATEST_JOB_BY_CHAIN_CTE = `
  WITH job_chains AS (
    SELECT j.id AS job_id, j.subject_id, chain.value::bigint AS chain_id
      FROM evm_audit_jobs j
      CROSS JOIN LATERAL jsonb_array_elements_text(
        COALESCE(j.requested_chains, '[]'::jsonb)
        || COALESCE(j.discovered_chains, '[]'::jsonb)
      ) chain(value)
     WHERE j.user_id = $1 AND chain.value ~ '^[0-9]+$'
    UNION
    SELECT j.id, j.subject_id, sc.chain_id
      FROM evm_audit_jobs j
      JOIN evm_audit_scopes sc ON sc.job_id = j.id
     WHERE j.user_id = $1
    UNION
    SELECT j.id, j.subject_id, n.chain_id
      FROM evm_audit_jobs j
      JOIN evm_nonce_audits n ON n.job_id = j.id
     WHERE j.user_id = $1
    UNION
    SELECT j.id, j.subject_id, b.chain_id
      FROM evm_audit_jobs j
      JOIN evm_balance_audits b ON b.job_id = j.id
     WHERE j.user_id = $1
  ), latest_job_by_chain AS (
    SELECT DISTINCT ON (j.subject_id, jc.chain_id)
           j.id AS job_id, j.subject_id, jc.chain_id
      FROM job_chains jc
      JOIN evm_audit_jobs j ON j.id = jc.job_id
     ORDER BY j.subject_id, jc.chain_id, j.requested_at DESC, j.id DESC
  )`;

module.exports = { LATEST_JOB_BY_CHAIN_CTE };
