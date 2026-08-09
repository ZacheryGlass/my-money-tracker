'use strict';

const crypto = require('node:crypto');
const pool = require('../config/database');
const { sha256 } = require('../services/evmAudit/normalizer');
const {
  matchesLegacyTransfer,
  matchesIndexedTransfer,
  TRANSFER_TYPES,
} = require('../services/evmAudit/corroboratedIdentity');

const ACTIVE_JOB_STATUSES = ['queued', 'running', 'deferred'];
const OBSERVATION_BATCH_SIZE = 500;
const AUDIT_LEASE_SECONDS = 600;

function observationIdentity(observation) {
  return JSON.stringify([
    String(observation.subjectId), String(observation.chainId), observation.provider,
    observation.evidenceKind, observation.providerObjectKey, observation.payloadSha256,
  ]);
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function validateProviderPage(page) {
  if (['consensus-rpc'].includes(page.provider)
      && typeof page.responseRaw !== 'string') {
    const error = new Error(`${page.provider} evidence must retain the raw response body`);
    error.code = 'EVM_INVALID_RAW_PAGE';
    throw error;
  }
  if (page.responseRaw != null && sha256(page.responseRaw) !== page.responseSha256) {
    const error = new Error('EVM provider raw page hash does not match its response body');
    error.code = 'EVM_INVALID_RAW_PAGE';
    throw error;
  }
  const evidenceIdentity = page.evidenceIdentitySha256 || page.responseSha256;
  if (!/^[0-9a-f]{64}$/.test(String(evidenceIdentity || '').toLowerCase())) {
    const error = new Error('EVM provider evidence identity hash is invalid');
    error.code = 'EVM_INVALID_RAW_PAGE';
    throw error;
  }
}

function pageConflict(existing, page) {
  const evidenceIdentity = page.evidenceIdentitySha256 || page.responseSha256;
  return existing.provider !== page.provider
    || existing.endpoint !== page.endpoint
    || sha256(existing.request_params || {}) !== sha256(page.requestParams || {})
    || existing.cursor_in !== (page.cursorIn || null)
    || existing.cursor_out !== (page.cursorOut || null)
    || existing.response_sha256 !== page.responseSha256
    || existing.evidence_identity_sha256 !== evidenceIdentity
    || existing.response_raw !== (page.responseRaw ?? null)
    || sha256(existing.response_json || {}) !== sha256(page.responseJson || {})
    || Number(existing.item_count) !== Number(page.itemCount);
}

async function assertActiveLease(client, jobId, owner) {
  const { rows } = await client.query(
    `SELECT 1 FROM evm_audit_jobs
      WHERE id = $1 AND status = 'running' AND lease_owner = $2
        AND lease_expires_at > CURRENT_TIMESTAMP
      FOR UPDATE`,
    [jobId, owner]
  );
  if (!rows[0]) {
    const error = new Error('EVM audit lease is no longer active');
    error.code = 'EVM_AUDIT_LEASE_LOST';
    throw error;
  }
}

class EvmAudit {
  static async acquireRunLock(jobId) {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        `SELECT j.user_id,
                pg_try_advisory_lock(j.user_id, hashtext('evm-audit-run')) AS acquired
           FROM evm_audit_jobs j WHERE j.id = $1`,
        [jobId]
      );
      if (!rows[0]?.acquired) {
        client.release();
        return null;
      }
      return { client, userId: rows[0].user_id };
    } catch (error) {
      client.release();
      throw error;
    }
  }

  static async releaseRunLock(lock) {
    if (!lock?.client) return;
    try {
      await lock.client.query(
        `SELECT pg_advisory_unlock($1, hashtext('evm-audit-run'))`,
        [lock.userId]
      );
    } finally {
      lock.client.release();
    }
  }

  static async credentialGenerations(userId) {
    const { rows } = await pool.query(
      `SELECT service, MAX(updated_at) AS updated_at
         FROM user_api_keys
        WHERE user_id = $1 AND service IN ('moralis')
        GROUP BY service`,
      [userId]
    );
    return rows.reduce((result, row) => {
      result[row.service] = row.updated_at || null;
      return result;
    }, { moralis: null });
  }

  static async credentialGeneration(userId) {
    const generations = await this.credentialGenerations(userId);
    return [generations.moralis]
      .filter(Boolean)
      .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] || null;
  }

  static async ensureSubject(userId, address, client = pool) {
    const normalized = String(address).toLowerCase();
    const { rows } = await client.query(
      `INSERT INTO evm_subjects (user_id, address)
       VALUES ($1, $2)
       ON CONFLICT (user_id, address)
       DO UPDATE SET updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [userId, normalized]
    );
    return rows[0];
  }

  static async createOrFindActiveJob(userId, wallet, {
    mode = 'incremental', requestedChains = [], credentialGeneration = null,
    credentialGenerations = null,
    requestedProviders = null,
    etherscanConfigured = false, rpcConfigurationReady = false,
  } = {}) {
    const providerGenerations = credentialGenerations || {
      moralis: credentialGeneration,
    };
    const latestCredentialGeneration = credentialGeneration
      || [providerGenerations.moralis]
        .filter(Boolean)
        .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0]
      || null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const subject = await this.ensureSubject(userId, wallet.address, client);
      // Cross-process serialization for one user's address. The partial unique
      // index is the final guard; the advisory lock makes the returned job
      // deterministic instead of relying on a unique-violation retry race.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [String(userId), subject.address]
      );
      const active = await client.query(
        `SELECT * FROM evm_audit_jobs
          WHERE subject_id = $1 AND status = ANY($2::varchar[])
          ORDER BY requested_at DESC, id DESC LIMIT 1 FOR UPDATE`,
        [subject.id, ACTIVE_JOB_STATUSES]
      );
      const activeRow = active.rows[0] || null;
      const activeChains = new Set((activeRow?.requested_chains || []).map(Number));
      let supersededJobId = null;
      const isDeferredBroaderScope = activeRow?.status === 'deferred'
        && requestedChains.length > 0
        && activeChains.size > requestedChains.length
        && requestedChains.every((chainId) => activeChains.has(Number(chainId)));
      let requestedScopeIsComplete = false;
      if (isDeferredBroaderScope) {
        // A broad job may be deferred by the requested chain itself (for
        // example Moralis quota), so scope
        // narrowing must not bypass that provider's retry deadline. Only
        // supersede when every requested chain already has exclusively
        // complete capability scopes in the broad job.
        const requestedScope = await client.query(
          `SELECT chain_id,
                  COUNT(*) AS scope_count,
                  BOOL_AND(status = 'complete') AS complete,
                  ARRAY_AGG(DISTINCT provider) AS providers
             FROM evm_audit_scopes
            WHERE job_id = $1 AND chain_id = ANY($2::bigint[])
            GROUP BY chain_id`,
          [activeRow.id, requestedChains.map(Number)]
        );
        const requestedIds = new Set(requestedChains.map(Number));
        requestedScopeIsComplete = requestedScope.rows.length === requestedIds.size
          && requestedScope.rows.every((row) => Number(row.scope_count) > 0 && row.complete === true);
        const requestedProviderIsIncomplete = requestedProviders
          && requestedScope.rows.length === requestedIds.size
          && requestedScope.rows.some((row) => {
            const expectedProvider = requestedProviders[String(row.chain_id)];
            return expectedProvider
              && (row.providers || []).includes(expectedProvider)
              && row.complete !== true;
          });
        const providerPrefixes = {
          moralis: 'MORALIS_',
          etherscan: 'ETHERSCAN_',
          blockscout: 'BLOCKSCOUT_',
          'consensus-rpc': 'RPC_',
        };
        const deferredErrorCode = String(activeRow.error_code || '');
        const deferredErrorDetail = String(activeRow.error_detail || '');
        const deferredErrorProvider = Object.entries(providerPrefixes)
          .find(([, prefix]) => deferredErrorCode.startsWith(prefix))?.[0] || null;
        const deferredErrorProviderFromDetail = deferredErrorProvider || Object.entries({
          moralis: /moralis/i,
          etherscan: /etherscan/i,
          blockscout: /blockscout/i,
          'consensus-rpc': /consensus\s+rpc|rpc/i,
        }).find(([, pattern]) => pattern.test(deferredErrorDetail))?.[0] || null;
        const requestedProviderOwnsDeferredError = deferredErrorProviderFromDetail
          && Object.values(requestedProviders || {}).includes(deferredErrorProviderFromDetail);
        // A deferred broad job can predate a provider migration. If it has no
        // incomplete scope for the provider now required by the requested
        // chain, a new narrow job is safe: old pages remain immutable and the
        // new provider establishes its own bounded proof. An incomplete
        // requested-provider scope still blocks narrowing when the broad job's
        // own deferred error belongs to that provider. An unrelated provider
        // error from another provider must not
        // strand the new provider's independent proof.
        if (requestedProviders && (!requestedProviderIsIncomplete
          || (deferredErrorProviderFromDetail && !requestedProviderOwnsDeferredError))) {
          requestedScopeIsComplete = true;
        }
      }
      if (isDeferredBroaderScope && requestedScopeIsComplete) {
        // A whole-EVM job can remain deferred forever because an unrelated
        // chain has a standing provider limitation. An explicit narrower
        // request is safe to run as a new job: the old job's pages and
        // provider-attempt evidence remain immutable, and
        // the new job starts its own bounded proof for the requested scope.
        // Never supersede a running job or silently convert a broad request.
        supersededJobId = activeRow.id;
        await client.query(
          `UPDATE evm_audit_jobs
              SET status = 'cancelled',
                  stage = 'complete',
                  retry_after_at = NULL,
                  finished_at = CURRENT_TIMESTAMP,
                  lease_owner = NULL,
                  lease_expires_at = NULL,
                  heartbeat_at = CURRENT_TIMESTAMP,
                  error_detail = CONCAT(
                    COALESCE(error_detail, ''),
                    CASE WHEN COALESCE(error_detail, '') = '' THEN '' ELSE ' ' END,
                    'This broader audit was superseded by an explicit narrower audit scope; all retained provider evidence remains available.'
                  ),
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND status = 'deferred'
            RETURNING *`,
          [activeRow.id]
        );
      } else if (activeRow) {
        let activeJob = activeRow;
        const errorCode = String(activeJob.error_code || '');
        const indexedProviderDeferred = errorCode.startsWith('MORALIS_');
        const deferredProvider = errorCode.startsWith('MORALIS_') ? 'moralis' : null;
        // Etherscan's credential is also user-scoped, but its deferred job may
        // have no Moralis generation change to record. Re-open as soon as the
        // Settings key exists so a missing-key deferral is not sticky for 24h.
        const etherscanCredentialReady = errorCode === 'ETHERSCAN_NOT_CONFIGURED'
          && etherscanConfigured;
        const rpcConfigurationReadyNow = errorCode === 'RPC_UNSUPPORTED'
          && rpcConfigurationReady;
        const deferredProviderGeneration = deferredProvider
          ? providerGenerations[deferredProvider] : null;
        const deferredProviderGenerationColumn = deferredProvider
          ? `${deferredProvider}_credential_generation` : null;
        const priorProviderGeneration = deferredProviderGenerationColumn
          ? activeJob[deferredProviderGenerationColumn] || (
            // Jobs created before provider-specific generations were added can
            // fall back to the legacy value only when exactly one indexed
            // provider was requested. A combined timestamp is ambiguous when
            // more than one indexed provider was in scope.
            (activeJob.requested_chains || []).length === 1
              ? activeJob.credential_generation : null
          ) : null;
        const deferredProviderGenerationChanged = indexedProviderDeferred && deferredProvider
          && (priorProviderGeneration == null
            ? deferredProviderGeneration != null
            : deferredProviderGeneration == null
              || new Date(priorProviderGeneration).getTime()
                !== new Date(deferredProviderGeneration).getTime());
        const credentialChanged = etherscanCredentialReady
          || deferredProviderGenerationChanged || rpcConfigurationReadyNow;
        const retryDue = activeJob.status === 'deferred'
          && (!activeJob.retry_after_at || new Date(activeJob.retry_after_at).getTime() <= Date.now());
        if (activeJob.status === 'deferred' && (credentialChanged || retryDue)) {
          const refreshed = await client.query(
            `UPDATE evm_audit_jobs
                SET status = 'queued',
                    stage = 'queued',
                    credential_generation = $2,
                    moralis_credential_generation = $3,
                    retry_after_at = NULL,
                    error_code = NULL,
                    error_detail = NULL,
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = $1
            RETURNING *`,
            [activeJob.id, latestCredentialGeneration, providerGenerations.moralis]
          );
          activeJob = refreshed.rows[0];
        }
        let activeChains = new Set((activeJob.requested_chains || []).map(Number));
        // A deferred or not-yet-running incremental request is safe to widen
        // when the user explicitly asks for the genesis audit. Keep the same
        // durable job and its provider retry deadline: widening must never
        // bypass a Moralis quota/cooldown or create overlapping evidence
        // writers. A running job remains a real scope conflict.
        const needsFullExpansion = mode === 'full'
          && (activeJob.mode !== 'full'
            || requestedChains.some((chainId) => !activeChains.has(Number(chainId))));
        if (needsFullExpansion && activeJob.status !== 'running') {
          const expandedChains = [...new Set([
            ...activeChains,
            ...requestedChains.map(Number),
          ])];
          const expanded = await client.query(
            `UPDATE evm_audit_jobs
                SET mode = 'full',
                    requested_chains = $2::jsonb,
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = $1 AND status <> 'running'
            RETURNING *`,
            [activeJob.id, JSON.stringify(expandedChains)]
          );
          activeJob = expanded.rows[0] || activeJob;
          activeChains = new Set((activeJob.requested_chains || []).map(Number));
          // The job may already contain partial incremental pages. Those raw
          // observations remain valuable evidence, but their cursors and
          // finite bounds are not valid for a genesis run. Reset only the
          // provider scopes; the existing-ledger projection is a separate
          // reconciliation input and must not be replayed here.
          await client.query(
            `UPDATE evm_audit_scopes
                SET status = 'queued',
                    requested_from_block = CASE WHEN provider = 'consensus-rpc' THEN NULL ELSE 0 END,
                    requested_through_block = NULL,
                    requested_through_hash = NULL,
                    provider_cursor = NULL,
                    provider_order = 'unknown',
                    pagination_exhausted = FALSE,
                    error_code = NULL,
                    error_detail = NULL,
                    updated_at = CURRENT_TIMESTAMP
              WHERE job_id = $1 AND provider <> 'existing-ledger'`,
            [activeJob.id]
          );
        }
        const modeCovered = activeJob.mode === 'full' || mode === 'incremental';
        const chainsCovered = requestedChains.every((chainId) => activeChains.has(Number(chainId)));
        if (!modeCovered || !chainsCovered) {
          const error = new Error('A narrower history audit is already active; wait for it before starting this scope.');
          error.code = 'EVM_AUDIT_SCOPE_CONFLICT';
          throw error;
        }
        await client.query('COMMIT');
        return { job: activeJob, created: false };
      }
      const idempotencyKey = `${subject.id}:${mode}:${crypto.randomUUID()}`;
      const inserted = await client.query(
        `INSERT INTO evm_audit_jobs (
           user_id, subject_id, requested_wallet_id, mode, idempotency_key,
           credential_generation, moralis_credential_generation, requested_chains
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         RETURNING *`,
        [
          userId, subject.id, wallet.id, mode, idempotencyKey,
          latestCredentialGeneration, providerGenerations.moralis, JSON.stringify(requestedChains),
        ]
      );
      if (supersededJobId) {
        await client.query(
          `UPDATE evm_audit_jobs
              SET superseded_by_job_id = $2,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [supersededJobId, inserted.rows[0].id]
        );
      }
      await client.query('COMMIT');
      return { job: inserted.rows[0], created: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async findDetailedByIdForUser(jobId, userId) {
    const { rows } = await pool.query(
      `SELECT j.*, s.address,
              COALESCE((SELECT jsonb_agg(sc ORDER BY sc.chain_id, sc.capability)
                          FROM evm_audit_scopes sc WHERE sc.job_id = j.id), '[]'::jsonb) AS scopes,
              COALESCE((SELECT jsonb_agg(n ORDER BY n.chain_id)
                          FROM evm_nonce_audits n WHERE n.job_id = j.id), '[]'::jsonb) AS nonce_audits,
              COALESCE((SELECT jsonb_agg(b ORDER BY b.chain_id, b.asset_key)
                          FROM evm_balance_audits b WHERE b.job_id = j.id), '[]'::jsonb) AS balance_audits
         FROM evm_audit_jobs j
         JOIN evm_subjects s ON s.id = j.subject_id
        WHERE j.id = $1 AND j.user_id = $2`,
      [jobId, userId]
    );
    return rows[0] || null;
  }

  static async findById(jobId) {
    const { rows } = await pool.query(
      `SELECT j.*, s.address
         FROM evm_audit_jobs j
         JOIN evm_subjects s ON s.id = j.subject_id
        WHERE j.id = $1`,
      [jobId]
    );
    return rows[0] || null;
  }

  static async latestForWallets(userId, walletIds) {
    if (!walletIds.length) return new Map();
    const { rows } = await pool.query(
      `SELECT w.id AS wallet_id, j.*
         FROM eth_wallets w
         LEFT JOIN evm_subjects s ON s.user_id = w.user_id AND s.address = w.address
         LEFT JOIN LATERAL (
           SELECT x.* FROM evm_audit_jobs x
            WHERE x.subject_id = s.id
            ORDER BY x.requested_at DESC, x.id DESC LIMIT 1
         ) j ON TRUE
        WHERE w.user_id = $1 AND w.id = ANY($2::int[])`,
      [userId, walletIds]
    );
    return new Map(rows.filter((row) => row.id).map((row) => [row.wallet_id, row]));
  }

  static async listForUser(userId, { walletId = null, jobIds = null, limit = 50 } = {}) {
    const params = [userId, limit];
    const clauses = ['j.user_id = $1'];
    if (walletId != null) {
      params.push(walletId);
      clauses.push(`EXISTS (
        SELECT 1 FROM eth_wallets w
         WHERE w.id = $${params.length} AND w.user_id = j.user_id AND w.address = s.address
      )`);
    }
    if (jobIds?.length) {
      params.push(jobIds);
      clauses.push(`j.id = ANY($${params.length}::bigint[])`);
    }
    const { rows } = await pool.query(
      `SELECT j.*, s.address,
              COALESCE((SELECT jsonb_agg(sc ORDER BY sc.chain_id, sc.capability)
                          FROM evm_audit_scopes sc WHERE sc.job_id = j.id), '[]'::jsonb) AS scopes,
              COALESCE((SELECT jsonb_agg(n ORDER BY n.chain_id)
                          FROM evm_nonce_audits n WHERE n.job_id = j.id), '[]'::jsonb) AS nonce_audits,
              COALESCE((SELECT jsonb_agg(b ORDER BY b.chain_id, b.asset_key)
                          FROM evm_balance_audits b WHERE b.job_id = j.id), '[]'::jsonb) AS balance_audits
         FROM evm_audit_jobs j
         JOIN evm_subjects s ON s.id = j.subject_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY j.requested_at DESC, j.id DESC
        LIMIT $2`,
      params
    );
    return rows;
  }

  static async claim(jobId, owner, leaseSeconds = AUDIT_LEASE_SECONDS) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT user_id FROM evm_audit_jobs WHERE id = $1 FOR UPDATE`,
        [jobId]
      );
      if (!locked.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(
        `SELECT pg_advisory_xact_lock($1, hashtext('evm-audit-worker'))`,
        [locked.rows[0].user_id]
      );
      const { rows } = await client.query(
        `UPDATE evm_audit_jobs j
          SET status = 'running',
              started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
              lease_owner = $2,
              lease_expires_at = CURRENT_TIMESTAMP + make_interval(secs => $3),
              heartbeat_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE j.id = $1
          AND j.status IN ('queued', 'running', 'deferred')
          AND (j.status <> 'deferred'
            OR j.retry_after_at IS NULL
            OR j.retry_after_at <= CURRENT_TIMESTAMP)
          AND (j.lease_expires_at IS NULL OR j.lease_expires_at < CURRENT_TIMESTAMP)
          AND NOT EXISTS (
            SELECT 1 FROM evm_audit_jobs sibling
             WHERE sibling.user_id = j.user_id AND sibling.id <> j.id
               AND sibling.status = 'running'
               AND sibling.lease_expires_at >= CURRENT_TIMESTAMP
          )
      RETURNING *`,
        [jobId, owner, leaseSeconds]
      );
      await client.query('COMMIT');
      return rows[0] || null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async heartbeat(jobId, owner, { stage = null, progress = null, leaseSeconds = AUDIT_LEASE_SECONDS } = {}) {
    const { rows } = await pool.query(
      `UPDATE evm_audit_jobs
          SET stage = COALESCE($3, stage),
              progress = CASE WHEN $4::jsonb IS NULL THEN progress ELSE progress || $4::jsonb END,
              lease_expires_at = CURRENT_TIMESTAMP + make_interval(secs => $5),
              heartbeat_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND lease_owner = $2 AND status = 'running'
          AND lease_expires_at > CURRENT_TIMESTAMP
      RETURNING *`,
      [jobId, owner, stage, progress == null ? null : JSON.stringify(progress), leaseSeconds]
    );
    return rows[0] || null;
  }

  static async finish(jobId, owner, status, {
    errorCode = null, errorDetail = null, progress = null, retryAt = null,
  } = {}) {
    const { rows } = await pool.query(
      `UPDATE evm_audit_jobs
          SET status = $3::varchar,
              stage = CASE WHEN $3::varchar IN ('complete', 'complete_with_gaps') THEN 'complete' ELSE stage END,
              progress = CASE WHEN $4::jsonb IS NULL THEN progress ELSE progress || $4::jsonb END,
              error_code = $5,
              error_detail = $6,
              retry_after_at = $7,
              finished_at = CASE WHEN $3 IN ('complete', 'complete_with_gaps', 'unsupported', 'failed', 'cancelled')
                                 THEN CURRENT_TIMESTAMP ELSE finished_at END,
              lease_owner = NULL,
              lease_expires_at = NULL,
              heartbeat_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND (
          $2::text IS NULL
          OR (lease_owner = $2 AND status = 'running' AND lease_expires_at > CURRENT_TIMESTAMP)
        )
      RETURNING *`,
      [jobId, owner, status, progress == null ? null : JSON.stringify(progress), errorCode, errorDetail, retryAt]
    );
    return rows[0] || null;
  }

  static async setDiscoveredChains(jobId, owner, discoveredChains) {
    const { rows } = await pool.query(
      `UPDATE evm_audit_jobs
          SET discovered_chains = $3::jsonb, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND lease_owner = $2 AND status = 'running'
          AND lease_expires_at > CURRENT_TIMESTAMP
      RETURNING *`,
      [jobId, owner, JSON.stringify(discoveredChains)]
    );
    return rows[0] || null;
  }

  static async upsertScope(jobId, {
    chainId, provider, capability, status = 'queued', fromBlock = null,
    throughBlock = null, throughHash = null, cursor = null,
    providerOrder = null, coverageBasis = null, errorCode = null, errorDetail = null,
  }, fence = {}) {
    // Migration 079 made provider_order NOT NULL so every persisted scope has
    // an explicit ordering state. Initial scopes, unsupported scopes, and
    // incremental scopes without prior coverage legitimately do not know the
    // provider order yet; the INSERT turns that null into `unknown`. Keep the
    // original parameter for the conflict arm so a restart cannot overwrite
    // an already-proven direction with `unknown`.
    const transactional = Boolean(fence.jobId && fence.owner);
    const client = transactional ? await pool.connect() : pool;
    try {
      if (transactional) {
        await client.query('BEGIN');
        if (Number(fence.jobId) !== Number(jobId)) {
          const error = new Error('EVM audit scope fence does not match its job');
          error.code = 'EVM_AUDIT_LEASE_LOST';
          throw error;
        }
        await assertActiveLease(client, fence.jobId, fence.owner);
      }
      const { rows } = await client.query(
      `INSERT INTO evm_audit_scopes (
         job_id, chain_id, provider, capability, status,
         requested_from_block, requested_through_block, requested_through_hash,
         provider_cursor, provider_order, coverage_basis, error_code, error_detail
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, 'unknown'),$11,$12,$13)
       ON CONFLICT (job_id, chain_id, provider, capability)
       DO UPDATE SET
         status = EXCLUDED.status,
         requested_from_block = COALESCE(EXCLUDED.requested_from_block, evm_audit_scopes.requested_from_block),
         requested_through_block = COALESCE(EXCLUDED.requested_through_block, evm_audit_scopes.requested_through_block),
         requested_through_hash = COALESCE(EXCLUDED.requested_through_hash, evm_audit_scopes.requested_through_hash),
         provider_cursor = COALESCE(EXCLUDED.provider_cursor, evm_audit_scopes.provider_cursor),
         provider_order = CASE WHEN $10 IS NULL
           THEN evm_audit_scopes.provider_order ELSE EXCLUDED.provider_order END,
         coverage_basis = COALESCE(EXCLUDED.coverage_basis, evm_audit_scopes.coverage_basis),
         error_code = EXCLUDED.error_code,
         error_detail = EXCLUDED.error_detail,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
        [jobId, chainId, provider, capability, status, fromBlock, throughBlock, throughHash,
          cursor, providerOrder, coverageBasis, errorCode, errorDetail]
      );
      if (transactional) await client.query('COMMIT');
      return rows[0];
    } catch (error) {
      if (transactional) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (transactional) client.release();
    }
  }

  // Persist the provider response before normalizing it. If a malformed or
  // conflicting page makes the scan fail, the raw page remains inspectable
  // while the scope cursor stays at the last normalized checkpoint.
  static async recordRawPage(scopeId, page, fence = {}) {
    validateProviderPage(page);
    const evidenceIdentity = page.evidenceIdentitySha256 || page.responseSha256;
    const transactional = Boolean(fence.jobId && fence.owner);
    const client = transactional ? await pool.connect() : pool;
    try {
      if (transactional) {
        await client.query('BEGIN');
        await assertActiveLease(client, fence.jobId, fence.owner);
      }
      const inserted = await client.query(
      `INSERT INTO evm_provider_pages (
         scope_id, job_id, provider, endpoint, request_params, cursor_in, cursor_out,
         response_sha256, evidence_identity_sha256, response_raw, response_json, request_id, item_count
       )
       SELECT sc.id, sc.job_id, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10::jsonb, $11, $12
         FROM evm_audit_scopes sc
        WHERE sc.id = $1
       ON CONFLICT (scope_id, evidence_identity_sha256)
       DO NOTHING
       RETURNING id`,
      [
        scopeId, page.provider, page.endpoint, JSON.stringify(page.requestParams),
        page.cursorIn, page.cursorOut, page.responseSha256, evidenceIdentity,
        page.responseRaw, JSON.stringify(page.responseJson), page.requestId, page.itemCount,
      ]
      );
      let row = inserted.rows[0];
      const pageWasNew = Boolean(row);
      if (!row) {
        const existing = await client.query(
          `SELECT * FROM evm_provider_pages WHERE scope_id = $1 AND evidence_identity_sha256 = $2`,
          [scopeId, evidenceIdentity]
        );
        row = existing.rows[0];
      }
      if (!row) throw new Error('Audit scope no longer exists');
      if (!pageWasNew && pageConflict(row, page)) {
        const error = new Error('EVM provider page identity conflicts with retained evidence');
        error.code = 'EVM_CONFLICTING_PAGE';
        throw error;
      }
      if (transactional) await client.query('COMMIT');
      return row.id;
    } catch (error) {
      if (transactional) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (transactional) client.release();
    }
  }

  static async commitPage(scopeId, page, observations, fence = {}) {
    validateProviderPage(page);
    const evidenceIdentity = page.evidenceIdentitySha256 || page.responseSha256;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lockedScope = await client.query(
        `SELECT sc.job_id, sc.chain_id, j.subject_id
           FROM evm_audit_scopes sc
           JOIN evm_audit_jobs j ON j.id = sc.job_id
          WHERE sc.id = $1 FOR UPDATE OF sc`,
        [scopeId]
      );
      const scope = lockedScope.rows[0];
      if (!scope) throw new Error('Audit scope no longer exists');
      if (fence.jobId && fence.owner) {
        if (Number(scope.job_id) !== Number(fence.jobId)) {
          const error = new Error('EVM audit page fence does not match its scope job');
          error.code = 'EVM_AUDIT_LEASE_LOST';
          throw error;
        }
        await assertActiveLease(client, fence.jobId, fence.owner);
      }
      const insertedPage = await client.query(
        `INSERT INTO evm_provider_pages (
           scope_id, job_id, provider, endpoint, request_params, cursor_in, cursor_out,
           response_sha256, evidence_identity_sha256, response_raw, response_json, request_id, item_count
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
         ON CONFLICT (scope_id, evidence_identity_sha256) DO NOTHING
         RETURNING id`,
        [
          scopeId, scope.job_id, page.provider, page.endpoint, JSON.stringify(page.requestParams),
          page.cursorIn, page.cursorOut, page.responseSha256, evidenceIdentity,
          page.responseRaw, JSON.stringify(page.responseJson), page.requestId, page.itemCount,
        ]
      );
      let pageId = insertedPage.rows[0]?.id;
      const pageWasNew = Boolean(pageId);
      if (!pageId) {
        const existing = await client.query(
          `SELECT * FROM evm_provider_pages WHERE scope_id = $1 AND evidence_identity_sha256 = $2`,
          [scopeId, evidenceIdentity]
        );
        if (!existing.rows[0]) throw new Error('Audit provider page no longer exists');
        if (pageConflict(existing.rows[0], page)) {
          const error = new Error('EVM provider page identity conflicts with retained evidence');
          error.code = 'EVM_CONFLICTING_PAGE';
          throw error;
        }
        pageId = existing.rows[0].id;
      }

      const preparedObservations = observations.map((observation) => {
        if (Number(observation.subjectId) !== Number(scope.subject_id)
            || Number(observation.chainId) !== Number(scope.chain_id)) {
          throw new Error('Provider observation ownership does not match its locked audit scope');
        }
        return { observation, identity: observationIdentity(observation) };
      });
      const uniqueObservations = [...new Map(
        preparedObservations.map((entry) => [entry.identity, entry])
      ).values()];
      const observationIdsByIdentity = new Map();
      for (const batch of chunks(uniqueObservations, OBSERVATION_BATCH_SIZE)) {
        const values = [];
        const placeholders = batch.map(({ observation }, index) => {
          const offset = index * 13;
          values.push(
            observation.subjectId, observation.chainId, observation.provider,
            observation.evidenceKind, observation.providerObjectKey,
            observation.txHash, observation.blockNumber, observation.blockHash,
            observation.transactionIndex, observation.logIndex,
            observation.traceAddress == null ? null : JSON.stringify(observation.traceAddress),
            JSON.stringify(observation.payload), observation.payloadSha256,
          );
          return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10},$${offset + 11}::jsonb,$${offset + 12}::jsonb,$${offset + 13})`;
        });
        const insertedObservations = await client.query(
          `INSERT INTO evm_provider_observations (
             subject_id, chain_id, provider, evidence_kind, provider_object_key,
             tx_hash, block_number, block_hash, transaction_index, log_index,
             trace_address, payload_json, payload_sha256
           ) VALUES ${placeholders.join(',')}
           ON CONFLICT (
             subject_id, chain_id, provider, evidence_kind,
             provider_object_key, payload_sha256
           ) DO UPDATE SET last_observed_at = CURRENT_TIMESTAMP
           RETURNING id, subject_id, chain_id, provider, evidence_kind,
                     provider_object_key, payload_sha256`,
          values
        );
        for (const row of insertedObservations.rows) {
          observationIdsByIdentity.set(observationIdentity({
            subjectId: row.subject_id,
            chainId: row.chain_id,
            provider: row.provider,
            evidenceKind: row.evidence_kind,
            providerObjectKey: row.provider_object_key,
            payloadSha256: row.payload_sha256,
          }), row.id);
        }
      }
      const observationIds = preparedObservations.map(({ identity }) => observationIdsByIdentity.get(identity));
      const uniqueObservationIds = [...new Set(observationIds)];
      for (const batch of chunks(uniqueObservationIds, OBSERVATION_BATCH_SIZE)) {
        const values = [];
        const placeholders = batch.map((observationId, index) => {
          const offset = index * 5;
          values.push(scope.job_id, scope.subject_id, scope.chain_id, observationId, pageId);
          return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5})`;
        });
        await client.query(
          `INSERT INTO evm_job_observations (
             job_id, subject_id, chain_id, observation_id, page_id
           ) VALUES ${placeholders.join(',')}
           ON CONFLICT (job_id, observation_id)
           DO UPDATE SET page_id = COALESCE(evm_job_observations.page_id, EXCLUDED.page_id),
                         observed_at = CURRENT_TIMESTAMP`,
          values
        );
      }
      const observationChanges = observations.length;

      await client.query(
        `UPDATE evm_audit_scopes
            SET status = 'running',
                provider_cursor = $2,
                provider_order = COALESCE($5, provider_order),
                pages_committed = pages_committed + $3,
                items_committed = items_committed + $4,
                last_checkpoint_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [scopeId, page.cursorOut, pageWasNew ? 1 : 0, pageWasNew ? page.itemCount : 0,
          page.providerOrder || null]
      );
      await client.query('COMMIT');
      return { pageId, pageWasNew, observationChanges, observationIds };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async completeScope(scopeId, {
    status, paginationExhausted = false, providerOrder = null,
    coverageBasis = null, errorCode = null, errorDetail = null,
  }, fence = {}) {
    const transactional = Boolean(fence.jobId && fence.owner);
    const client = transactional ? await pool.connect() : pool;
    try {
      if (transactional) {
        await client.query('BEGIN');
        const scope = await client.query(
          'SELECT job_id FROM evm_audit_scopes WHERE id = $1 FOR UPDATE', [scopeId]
        );
        if (!scope.rows[0] || Number(scope.rows[0].job_id) !== Number(fence.jobId)) {
          const error = new Error('EVM audit scope fence does not match its job');
          error.code = 'EVM_AUDIT_LEASE_LOST';
          throw error;
        }
        await assertActiveLease(client, fence.jobId, fence.owner);
      }
      const { rows } = await client.query(
      `UPDATE evm_audit_scopes
          SET status = $2,
              pagination_exhausted = $3,
              provider_cursor = CASE WHEN $3 THEN NULL ELSE provider_cursor END,
              provider_order = COALESCE($6, provider_order),
              coverage_basis = COALESCE($7, coverage_basis),
              error_code = $4,
              error_detail = $5,
              last_checkpoint_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      RETURNING *`,
        [scopeId, status, paginationExhausted, errorCode, errorDetail, providerOrder, coverageBasis]
      );
      if (transactional) await client.query('COMMIT');
      return rows[0];
    } catch (error) {
      if (transactional) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (transactional) client.release();
    }
  }

  static async deferOpenScopes(jobId, chainId, {
    errorCode = 'AUDIT_PROVIDER_UNAVAILABLE',
    errorDetail = 'The provider did not complete this chain scope.',
    provider = 'consensus-rpc',
    scopeStatus = 'deferred',
    capabilities = [],
  }, fence = {}) {
    const transactional = Boolean(fence.jobId && fence.owner);
    const client = transactional ? await pool.connect() : pool;
    try {
      if (transactional) {
        await client.query('BEGIN');
        if (Number(fence.jobId) !== Number(jobId)) {
          const error = new Error('EVM audit scope fence does not match its job');
          error.code = 'EVM_AUDIT_LEASE_LOST';
          throw error;
        }
        await assertActiveLease(client, fence.jobId, fence.owner);
      }
      const { rowCount } = await client.query(
        `UPDATE evm_audit_scopes
            SET status = $5,
                pagination_exhausted = FALSE,
                error_code = $3,
                error_detail = $4,
                updated_at = CURRENT_TIMESTAMP
          WHERE job_id = $1 AND chain_id = $2 AND status IN ('queued', 'running')`,
        [jobId, chainId, errorCode, errorDetail, scopeStatus]
      );
      if (capabilities.length) {
        await client.query(
          `INSERT INTO evm_audit_scopes (
             job_id, chain_id, provider, capability, status,
             provider_order, error_code, error_detail
           )
           SELECT $1, $2, $3, capability, $4, 'unknown', $5, $6
             FROM unnest($7::varchar[]) AS requested(capability)
           ON CONFLICT (job_id, chain_id, provider, capability) DO NOTHING`,
          [jobId, chainId, provider, scopeStatus, errorCode, errorDetail, capabilities]
        );
      }
      if (transactional) await client.query('COMMIT');
      return rowCount;
    } catch (error) {
      if (transactional) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (transactional) client.release();
    }
  }

  static async recordProviderAttempt(row) {
    const transactional = Boolean(row.owner);
    const client = transactional ? await pool.connect() : pool;
    try {
      if (transactional) {
        await client.query('BEGIN');
        await assertActiveLease(client, row.jobId, row.owner);
      }
      const { rows } = await client.query(
      `INSERT INTO evm_provider_attempts (
         job_id, scope_id, provider, endpoint, method, attempt_no,
         request_params, cursor_in, outcome, http_status, error_code,
         error_detail, request_id, response_sha256, response_raw, response_json
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
       RETURNING *`,
      [
        row.jobId, row.scopeId || null, row.provider, row.endpoint,
        row.method || 'GET', row.attemptNo || 1,
        JSON.stringify(row.requestParams || {}), row.cursorIn || null,
        row.outcome, row.httpStatus || null, row.errorCode,
        row.errorDetail || null, row.requestId || null,
        row.responseSha256 || null, row.responseRaw || null,
        row.responseJson == null ? null : JSON.stringify(row.responseJson),
      ]
    );
      if (transactional) await client.query('COMMIT');
      return rows[0];
    } catch (error) {
      if (transactional) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (transactional) client.release();
    }
  }

  static async acceptCoverage({
    subjectId, chainId, provider, capability, fromBlock, throughBlock,
    throughHash = null, providerOrder = 'unknown', coverageBasis = null,
    paginationExhausted, status, jobId,
    owner = null,
  }) {
    // Keep null as "no new ordering observation" for an existing coverage
    // row, while the INSERT expression below satisfies migration 079's
    // NOT NULL constraint for a first observation.
    const transactional = Boolean(owner);
    const client = transactional ? await pool.connect() : pool;
    try {
      if (transactional) {
        await client.query('BEGIN');
        await assertActiveLease(client, jobId, owner);
      }
      const { rows } = await client.query(
      `INSERT INTO evm_source_coverage (
         subject_id, chain_id, provider, capability, from_block, through_block,
         through_block_hash, provider_order, coverage_basis, pagination_exhausted, status, source_job_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, 'unknown'),$9,$10,$11,$12)
       ON CONFLICT (
         subject_id, chain_id, provider, capability,
         from_block, through_block, source_job_id
       ) DO UPDATE SET
         through_block_hash = EXCLUDED.through_block_hash,
         provider_order = CASE WHEN $8 IS NULL
           THEN evm_source_coverage.provider_order ELSE EXCLUDED.provider_order END,
         coverage_basis = EXCLUDED.coverage_basis,
         pagination_exhausted = EXCLUDED.pagination_exhausted,
         status = EXCLUDED.status,
         accepted_at = CURRENT_TIMESTAMP
       RETURNING *`,
        [
          subjectId, chainId, provider, capability, fromBlock, throughBlock,
          throughHash, providerOrder, coverageBasis, paginationExhausted, status, jobId,
        ]
      );
      if (transactional) await client.query('COMMIT');
      return rows[0];
    } catch (error) {
      if (transactional) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (transactional) client.release();
    }
  }

  static async latestCoverage(subjectId, chainId, provider, capability) {
    const { rows } = await pool.query(
      `SELECT * FROM evm_source_coverage
        WHERE subject_id = $1 AND chain_id = $2 AND provider = $3
          AND capability = $4 AND status = 'complete'
        ORDER BY through_block DESC, accepted_at DESC, id DESC LIMIT 1`,
      [subjectId, chainId, provider, capability]
    );
    return rows[0] || null;
  }

  static async observationsForJob(jobId, { chainId = null, evidenceKind = null } = {}) {
    const params = [jobId];
    const clauses = ['jo.job_id = $1'];
    if (chainId != null) { params.push(chainId); clauses.push(`o.chain_id = $${params.length}`); }
    if (evidenceKind != null) { params.push(evidenceKind); clauses.push(`o.evidence_kind = $${params.length}`); }
    const { rows } = await pool.query(
      `SELECT o.* FROM evm_job_observations jo
         JOIN evm_provider_observations o ON o.id = jo.observation_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY o.chain_id, o.block_number, o.transaction_index, o.log_index, o.id`,
      params
    );
    return rows;
  }

  static async transactionObservationsForSubject(
    subjectId, chainId, provider, fromBlock = 0
  ) {
    const providers = Array.isArray(provider) ? provider : [provider];
    const { rows } = await pool.query(
      `SELECT * FROM evm_provider_observations
        WHERE subject_id = $1 AND chain_id = $2 AND provider = ANY($3::text[])
          AND evidence_kind = 'transaction'
          AND (block_number IS NULL OR block_number >= $4)
        ORDER BY block_number, transaction_index, id`,
      [subjectId, chainId, providers, fromBlock]
    );
    return rows;
  }

  static async upsertMinedTransaction(transaction, fence = {}) {
    const transactional = Boolean(fence.jobId && fence.owner);
    const client = transactional ? await pool.connect() : pool;
    try {
      if (transactional) {
        await client.query('BEGIN');
        await assertActiveLease(client, fence.jobId, fence.owner);
      }
      const { rows } = await client.query(
      `INSERT INTO evm_mined_transactions (
         subject_id, chain_id, tx_hash, block_number, block_hash,
         transaction_index, from_address, to_address, nonce, value_wei, input,
         transaction_type, receipt_status, gas_limit, gas_price,
         effective_gas_price, gas_used, signedness, finality_status,
         resolution_status, selected_observation_id, conflict_detail
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb
       )
       ON CONFLICT (subject_id, chain_id, tx_hash)
       DO UPDATE SET
         block_number = EXCLUDED.block_number,
         block_hash = EXCLUDED.block_hash,
         transaction_index = EXCLUDED.transaction_index,
         from_address = EXCLUDED.from_address,
         to_address = EXCLUDED.to_address,
         nonce = EXCLUDED.nonce,
         value_wei = EXCLUDED.value_wei,
         input = EXCLUDED.input,
         transaction_type = EXCLUDED.transaction_type,
         receipt_status = EXCLUDED.receipt_status,
         gas_limit = EXCLUDED.gas_limit,
         gas_price = EXCLUDED.gas_price,
         effective_gas_price = EXCLUDED.effective_gas_price,
         gas_used = EXCLUDED.gas_used,
         signedness = EXCLUDED.signedness,
         finality_status = EXCLUDED.finality_status,
         resolution_status = CASE
           WHEN evm_mined_transactions.resolution_status = 'verified'
                AND EXCLUDED.resolution_status = 'verified'
                AND ROW(
                  evm_mined_transactions.block_number, evm_mined_transactions.block_hash,
                  evm_mined_transactions.transaction_index, evm_mined_transactions.from_address,
                  evm_mined_transactions.to_address, evm_mined_transactions.nonce,
                  evm_mined_transactions.value_wei, evm_mined_transactions.input,
                  evm_mined_transactions.receipt_status, evm_mined_transactions.gas_used,
                  evm_mined_transactions.effective_gas_price, evm_mined_transactions.signedness
                ) IS DISTINCT FROM ROW(
                  EXCLUDED.block_number, EXCLUDED.block_hash, EXCLUDED.transaction_index,
                  EXCLUDED.from_address, EXCLUDED.to_address, EXCLUDED.nonce,
                  EXCLUDED.value_wei, EXCLUDED.input, EXCLUDED.receipt_status,
                  EXCLUDED.gas_used, EXCLUDED.effective_gas_price, EXCLUDED.signedness
                ) THEN 'conflict'
           ELSE EXCLUDED.resolution_status
         END,
         selected_observation_id = EXCLUDED.selected_observation_id,
         conflict_detail = CASE
           WHEN evm_mined_transactions.resolution_status = 'verified'
                AND EXCLUDED.resolution_status = 'verified'
                AND ROW(
                  evm_mined_transactions.block_number, evm_mined_transactions.block_hash,
                  evm_mined_transactions.transaction_index, evm_mined_transactions.from_address,
                  evm_mined_transactions.to_address, evm_mined_transactions.nonce,
                  evm_mined_transactions.value_wei, evm_mined_transactions.input,
                  evm_mined_transactions.receipt_status, evm_mined_transactions.gas_used,
                  evm_mined_transactions.effective_gas_price, evm_mined_transactions.signedness
                ) IS DISTINCT FROM ROW(
                  EXCLUDED.block_number, EXCLUDED.block_hash, EXCLUDED.transaction_index,
                  EXCLUDED.from_address, EXCLUDED.to_address, EXCLUDED.nonce,
                  EXCLUDED.value_wei, EXCLUDED.input, EXCLUDED.receipt_status,
                  EXCLUDED.gas_used, EXCLUDED.effective_gas_price, EXCLUDED.signedness
                )
             THEN jsonb_build_object(
               'reason', 'consensus_observation_changed',
               'previous_observation_id', evm_mined_transactions.selected_observation_id,
               'incoming_observation_id', EXCLUDED.selected_observation_id
             )
           ELSE EXCLUDED.conflict_detail
         END,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        transaction.subjectId, transaction.chainId, transaction.txHash,
        transaction.blockNumber, transaction.blockHash, transaction.transactionIndex,
        transaction.fromAddress, transaction.toAddress, transaction.nonce,
        transaction.valueWei, transaction.input, transaction.transactionType,
        transaction.receiptStatus, transaction.gasLimit, transaction.gasPrice,
        transaction.effectiveGasPrice, transaction.gasUsed, transaction.signedness,
        transaction.finalityStatus, transaction.resolutionStatus,
        transaction.selectedObservationId, transaction.conflictDetail == null
          ? null : JSON.stringify(transaction.conflictDetail),
      ]
    );
      if (transactional) await client.query('COMMIT');
      return rows[0];
    } catch (error) {
      if (transactional) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (transactional) client.release();
    }
  }

  static async linkTransactionEvidence(transactionId, evidence, fence = {}) {
    const transactional = Boolean(fence.jobId && fence.owner);
    const client = transactional ? await pool.connect() : pool;
    try {
      if (transactional) {
        await client.query('BEGIN');
        await assertActiveLease(client, fence.jobId, fence.owner);
      }
      for (const entry of evidence) {
        await client.query(
        `INSERT INTO evm_transaction_evidence (
           transaction_id, subject_id, chain_id, observation_id, evidence_role
         )
         SELECT tx.id, tx.subject_id, tx.chain_id, obs.id, $3
           FROM evm_mined_transactions tx
           JOIN evm_provider_observations obs
             ON obs.id = $2 AND obs.subject_id = tx.subject_id AND obs.chain_id = tx.chain_id
          WHERE tx.id = $1
         ON CONFLICT (transaction_id, observation_id)
         DO UPDATE SET evidence_role = EXCLUDED.evidence_role`,
        [transactionId, entry.observationId, entry.role]
        );
      }
      if (transactional) await client.query('COMMIT');
    } catch (error) {
      if (transactional) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (transactional) client.release();
    }
  }

  static async upsertCanonicalEffect(effect, fence = {}) {
    const transactional = Boolean(fence.jobId && fence.owner);
    const client = transactional ? await pool.connect() : pool;
    try {
      if (transactional) {
        await client.query('BEGIN');
        await assertActiveLease(client, fence.jobId, fence.owner);
      }
      const { rows } = await client.query(
      `INSERT INTO evm_canonical_effects (
         subject_id, chain_id, tx_hash, effect_key, effect_type, direction,
         log_index, trace_address, from_address, to_address, value_units,
         token_contract, token_standard, token_id, token_decimals,
         resolution_status, selected_observation_id, conflict_detail
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
       ON CONFLICT (subject_id, chain_id, effect_key)
       DO UPDATE SET
         tx_hash = EXCLUDED.tx_hash,
         effect_type = EXCLUDED.effect_type,
         direction = EXCLUDED.direction,
         log_index = EXCLUDED.log_index,
         trace_address = EXCLUDED.trace_address,
         from_address = EXCLUDED.from_address,
         to_address = EXCLUDED.to_address,
         value_units = EXCLUDED.value_units,
         token_contract = EXCLUDED.token_contract,
         token_standard = EXCLUDED.token_standard,
         token_id = EXCLUDED.token_id,
         token_decimals = EXCLUDED.token_decimals,
         resolution_status = CASE
           WHEN evm_canonical_effects.resolution_status = 'verified'
                AND EXCLUDED.resolution_status = 'verified'
                AND ROW(
                  evm_canonical_effects.tx_hash, evm_canonical_effects.effect_type,
                  evm_canonical_effects.direction, evm_canonical_effects.log_index,
                  evm_canonical_effects.trace_address, evm_canonical_effects.from_address,
                  evm_canonical_effects.to_address, evm_canonical_effects.value_units,
                  evm_canonical_effects.token_contract, evm_canonical_effects.token_standard,
                  evm_canonical_effects.token_id
                ) IS DISTINCT FROM ROW(
                  EXCLUDED.tx_hash, EXCLUDED.effect_type, EXCLUDED.direction,
                  EXCLUDED.log_index, EXCLUDED.trace_address, EXCLUDED.from_address,
                  EXCLUDED.to_address, EXCLUDED.value_units, EXCLUDED.token_contract,
                  EXCLUDED.token_standard, EXCLUDED.token_id
                ) THEN 'conflict'
           WHEN evm_canonical_effects.resolution_status = 'verified'
                AND EXCLUDED.resolution_status = 'provisional'
             THEN evm_canonical_effects.resolution_status
           ELSE EXCLUDED.resolution_status
         END,
         selected_observation_id = CASE
           WHEN evm_canonical_effects.resolution_status = 'verified'
                AND EXCLUDED.resolution_status = 'provisional'
             THEN evm_canonical_effects.selected_observation_id
           ELSE EXCLUDED.selected_observation_id
         END,
         conflict_detail = CASE
           WHEN evm_canonical_effects.resolution_status = 'verified'
                AND EXCLUDED.resolution_status = 'verified'
                AND ROW(
                  evm_canonical_effects.tx_hash, evm_canonical_effects.effect_type,
                  evm_canonical_effects.direction, evm_canonical_effects.log_index,
                  evm_canonical_effects.trace_address, evm_canonical_effects.from_address,
                  evm_canonical_effects.to_address, evm_canonical_effects.value_units,
                  evm_canonical_effects.token_contract, evm_canonical_effects.token_standard,
                  evm_canonical_effects.token_id
                ) IS DISTINCT FROM ROW(
                  EXCLUDED.tx_hash, EXCLUDED.effect_type, EXCLUDED.direction,
                  EXCLUDED.log_index, EXCLUDED.trace_address, EXCLUDED.from_address,
                  EXCLUDED.to_address, EXCLUDED.value_units, EXCLUDED.token_contract,
                  EXCLUDED.token_standard, EXCLUDED.token_id
                )
             THEN jsonb_build_object(
               'reason', 'verified_effect_changed',
               'previous_observation_id', evm_canonical_effects.selected_observation_id,
               'incoming_observation_id', EXCLUDED.selected_observation_id
             )
           ELSE EXCLUDED.conflict_detail
         END,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        effect.subjectId, effect.chainId, effect.txHash, effect.effectKey,
        effect.effectType, effect.direction, effect.logIndex,
        effect.traceAddress == null ? null : JSON.stringify(effect.traceAddress),
        effect.fromAddress, effect.toAddress, effect.valueUnits,
        effect.tokenContract, effect.tokenStandard, effect.tokenId,
        effect.tokenDecimals, effect.resolutionStatus,
        effect.selectedObservationId,
        effect.conflictDetail == null ? null : JSON.stringify(effect.conflictDetail),
      ]
      );
      if (transactional) await client.query('COMMIT');
      return rows[0];
    } catch (error) {
      if (transactional) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (transactional) client.release();
    }
  }

  static async linkEffectEvidence(effectId, observationIds, fence = {}) {
    const transactional = Boolean(fence.jobId && fence.owner);
    const client = transactional ? await pool.connect() : pool;
    try {
      if (transactional) {
        await client.query('BEGIN');
        await assertActiveLease(client, fence.jobId, fence.owner);
      }
      for (const observationId of observationIds) {
        await client.query(
        `INSERT INTO evm_effect_evidence (effect_id, subject_id, chain_id, observation_id)
         SELECT effect.id, effect.subject_id, effect.chain_id, obs.id
           FROM evm_canonical_effects effect
           JOIN evm_provider_observations obs
             ON obs.id = $2 AND obs.subject_id = effect.subject_id AND obs.chain_id = effect.chain_id
          WHERE effect.id = $1
         ON CONFLICT DO NOTHING`,
        [effectId, observationId]
        );
      }
      if (transactional) await client.query('COMMIT');
    } catch (error) {
      if (transactional) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (transactional) client.release();
    }
  }

  static async invalidateMissingRpcEffects(
    subjectId, chainId, txHash, retainedKeys, receiptObservationId, fence = {}
  ) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (fence.jobId && fence.owner) await assertActiveLease(client, fence.jobId, fence.owner);
      const { rows } = await client.query(
        `UPDATE evm_canonical_effects
            SET resolution_status = 'invalidated',
                conflict_detail = jsonb_build_object(
                  'reason', 'absent_from_later_consensus_receipt',
                  'receipt_observation_id', $5::bigint
                ),
                updated_at = CURRENT_TIMESTAMP
          WHERE subject_id = $1 AND chain_id = $2 AND tx_hash = $3
            AND effect_type <> 'internal' AND resolution_status <> 'invalidated'
            AND NOT (effect_key = ANY($4::text[]))
        RETURNING id`,
        [subjectId, chainId, txHash, retainedKeys, receiptObservationId]
      );
      if (receiptObservationId != null && rows.length) {
        await client.query(
          `INSERT INTO evm_effect_evidence (effect_id, subject_id, chain_id, observation_id)
           SELECT effect.id, effect.subject_id, effect.chain_id, obs.id
             FROM unnest($1::bigint[]) AS changed(id)
             JOIN evm_canonical_effects effect ON effect.id = changed.id
             JOIN evm_provider_observations obs
               ON obs.id = $2 AND obs.subject_id = effect.subject_id AND obs.chain_id = effect.chain_id
           ON CONFLICT DO NOTHING`,
          [rows.map((row) => row.id), receiptObservationId]
        );
      }
      await client.query('COMMIT');
      return rows.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async canonicalTransactions(subjectId, chainId) {
    const { rows } = await pool.query(
      `SELECT * FROM evm_mined_transactions
        WHERE subject_id = $1 AND chain_id = $2 AND resolution_status = 'verified'
        ORDER BY nonce, block_number, transaction_index, tx_hash`,
      [subjectId, chainId]
    );
    return rows;
  }

  // A committed consensus receipt is durable proof for a mined transaction.
  // Restarting an audit must not replay every expensive RPC lookup when the
  // prior run already verified the same finalized transaction. Reconciliation
  // still reads all canonical effects below, and a transaction without both a
  // verified row and a consensus receipt remains eligible for lookup.
  static async verifiedConsensusReceiptHashes(subjectId, chainId) {
    const { rows } = await pool.query(
      `SELECT DISTINCT tx.tx_hash
         FROM evm_mined_transactions tx
         JOIN evm_transaction_evidence te ON te.transaction_id = tx.id
         JOIN evm_provider_observations obs ON obs.id = te.observation_id
        WHERE tx.subject_id = $1 AND tx.chain_id = $2
          AND tx.resolution_status = 'verified'
          AND tx.finality_status = 'finalized'
          AND obs.provider = 'consensus-rpc'
          AND obs.evidence_kind = 'receipt'`,
      [subjectId, chainId]
    );
    return new Set(rows.map((row) => row.tx_hash));
  }

  static async transactionConflictCount(subjectId, chainId) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM evm_mined_transactions
        WHERE subject_id = $1 AND chain_id = $2
          AND resolution_status IN ('provisional', 'conflict')`,
      [subjectId, chainId]
    );
    return rows[0]?.count || 0;
  }

  static async requiredScopeGapCount(jobId, chainId) {
    const { rows } = await pool.query(
      `WITH required(capability) AS (
         VALUES ('normal'),('internal'),('erc20'),('erc721'),('erc1155'),('native_credit')
       )
       SELECT COUNT(*)::int AS count
         FROM required r
        WHERE NOT EXISTS (
          SELECT 1 FROM evm_audit_scopes sc
           WHERE sc.job_id = $1 AND sc.chain_id = $2
             AND sc.capability = r.capability
             AND sc.provider IN ('moralis', 'blockscout', 'etherscan', 'existing-ledger')
             AND sc.status = 'complete' AND sc.pagination_exhausted = TRUE
        )`,
      [jobId, chainId]
    );
    return rows[0]?.count || 0;
  }

  static async provisionalEffectCount(subjectId, chainId) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM evm_canonical_effects
        WHERE subject_id = $1 AND chain_id = $2
          AND resolution_status IN ('provisional', 'conflict')`,
      [subjectId, chainId]
    );
    return rows[0]?.count || 0;
  }

  static async canonicalEffects(subjectId, chainId, throughBlock) {
    const { rows } = await pool.query(
      `SELECT e.*
         FROM evm_canonical_effects e
         JOIN evm_mined_transactions tx
           ON tx.subject_id = e.subject_id AND tx.chain_id = e.chain_id AND tx.tx_hash = e.tx_hash
        WHERE e.subject_id = $1 AND e.chain_id = $2 AND tx.block_number <= $3
          AND e.resolution_status = 'verified'
          AND tx.resolution_status = 'verified'
        ORDER BY e.tx_hash, e.effect_key`,
      [subjectId, chainId, throughBlock]
    );
    return rows;
  }

  static async backfillVerifiedEffects(userId, subjectId, chainId, effectIds, fence = {}) {
    if (!effectIds.length) return 0;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (fence.jobId && fence.owner) await assertActiveLease(client, fence.jobId, fence.owner);
      const wallet = await client.query(
        `SELECT w.id
           FROM evm_subjects s
           JOIN eth_wallets w ON w.user_id = s.user_id AND w.address = s.address
          WHERE s.id = $2 AND s.user_id = $1 FOR UPDATE OF w`,
        [userId, subjectId]
      );
      if (!wallet.rows[0]) throw new Error('Tracked wallet is unavailable for verified-effect backfill');
      let inserted = 0;
      for (const effectId of effectIds) {
        const evidence = await client.query(
          `SELECT e.*, tx.block_number, tx.receipt_status,
                  COALESCE(
                    (SELECT MIN(t.block_time) FROM eth_transfers t
                      WHERE t.wallet_id = $4 AND t.chain_id = e.chain_id AND t.tx_hash = e.tx_hash),
                    (SELECT MIN((o.payload_json->>'block_timestamp')::timestamptz)
                       FROM evm_effect_evidence ee
                       JOIN evm_provider_observations o ON o.id = ee.observation_id
                      WHERE ee.effect_id = e.id
                        AND o.payload_json ? 'block_timestamp')
                  ) AS block_time
             FROM evm_canonical_effects e
             JOIN evm_mined_transactions tx
               ON tx.subject_id = e.subject_id AND tx.chain_id = e.chain_id AND tx.tx_hash = e.tx_hash
            WHERE e.id = $1 AND e.subject_id = $2 AND e.chain_id = $3
              AND e.resolution_status = 'verified' AND tx.resolution_status = 'verified'`,
          [effectId, subjectId, chainId, wallet.rows[0].id]
        );
        const effect = evidence.rows[0];
        if (!effect?.block_time) continue;
        const transferType = {
          native: 'native', native_credit: 'internal', internal: 'internal',
          gas: 'gas', erc20: 'token', erc721: 'nft', erc1155: 'nft1155',
        }[effect.effect_type];
        if (!transferType) continue;
        const ordinal = await client.query(
          `SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal
             FROM eth_transfers
            WHERE wallet_id = $1 AND chain_id = $2 AND transfer_type = $3 AND tx_hash = $4`,
          [wallet.rows[0].id, chainId, transferType, effect.tx_hash]
        );
        const result = await client.query(
          `INSERT INTO eth_transfers (
             wallet_id, chain_id, tx_hash, ordinal, transfer_type, block_number,
             block_time, from_address, to_address, value_wei, token_contract,
             token_decimals, token_standard, token_id, is_error, tx_is_error,
             source_log_index, source_trace_address, audit_effect_key,
             audit_observation_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,FALSE,$15,$16,$17::jsonb,$18,$19)
           ON CONFLICT (wallet_id, chain_id, audit_effect_key)
             WHERE audit_effect_key IS NOT NULL DO NOTHING`,
          [
            wallet.rows[0].id, chainId, effect.tx_hash, ordinal.rows[0].ordinal,
            transferType, effect.block_number, effect.block_time,
            effect.from_address, effect.to_address, effect.value_units,
            effect.token_contract, effect.token_decimals, effect.token_standard,
            effect.token_id, transferType === 'gas' ? effect.receipt_status === 0 : null,
            effect.log_index, effect.trace_address == null ? null : JSON.stringify(effect.trace_address),
            effect.effect_key, effect.selected_observation_id,
          ]
        );
        inserted += result.rowCount;
      }
      await client.query('COMMIT');
      return inserted;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async nativeDerivedAt(userId, subjectId, chainId, throughBlock) {
    const { rows } = await pool.query(
      `SELECT (
          COALESCE(SUM(CASE WHEN t.transfer_type IN ('native', 'internal')
                             AND t.is_error = FALSE AND t.to_address = w.address
                            THEN t.value_wei ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN t.transfer_type IN ('native', 'internal')
                             AND t.is_error = FALSE AND t.from_address = w.address
                            THEN t.value_wei ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN t.transfer_type = 'gas' THEN t.value_wei ELSE 0 END), 0)
        )::text AS balance_wei
         FROM evm_subjects s
         LEFT JOIN eth_wallets w ON w.user_id = s.user_id AND w.address = s.address
         LEFT JOIN eth_transfers t ON t.wallet_id = w.id
                                  AND t.chain_id = $3
                                  AND t.block_number <= $4
        WHERE s.id = $2 AND s.user_id = $1
        GROUP BY s.id`,
      [userId, subjectId, chainId, throughBlock]
    );
    return rows[0]?.balance_wei ?? '0';
  }

  static async tokenDerivedAt(userId, subjectId, chainId, throughBlock) {
    const { rows } = await pool.query(
      `SELECT t.token_contract,
              MAX(COALESCE(t.token_decimals, 18)) AS token_decimals,
              (COALESCE(SUM(CASE WHEN t.is_error = FALSE AND t.to_address = w.address
                                  THEN t.value_wei ELSE 0 END), 0)
               - COALESCE(SUM(CASE WHEN t.is_error = FALSE AND t.from_address = w.address
                                   THEN t.value_wei ELSE 0 END), 0))::text AS balance_units
         FROM evm_subjects s
         JOIN eth_wallets w ON w.user_id = s.user_id AND w.address = s.address
         JOIN eth_transfers t ON t.wallet_id = w.id
        WHERE s.id = $2 AND s.user_id = $1 AND t.chain_id = $3
          AND t.block_number <= $4 AND t.transfer_type = 'token'
          AND t.token_contract IS NOT NULL
        GROUP BY t.token_contract
        ORDER BY t.token_contract`,
      [userId, subjectId, chainId, throughBlock]
    );
    return rows;
  }

  static async storedTransferRows(userId, subjectId, chainId, throughBlock) {
    const { rows } = await pool.query(
      `SELECT t.*
         FROM evm_subjects s
         JOIN eth_wallets w ON w.user_id = s.user_id AND w.address = s.address
         JOIN eth_transfers t ON t.wallet_id = w.id
        WHERE s.id = $2 AND s.user_id = $1
          AND t.chain_id = $3 AND t.block_number <= $4
        ORDER BY t.block_number, t.tx_hash, t.transfer_type, t.ordinal`,
      [userId, subjectId, chainId, throughBlock]
    );
    return rows;
  }

  // Legacy explorer rows normally have economics but no immutable log
  // coordinate. Upgrade them only when the same receipt effect is proven by
  // consensus RPC and independently corroborated by the configured indexed
  // provider at the exact transaction/log
  // coordinate. Economic equality alone remains a gap.
  static async repairCorroboratedTransferIdentities(
    jobId, userId, subjectId, chainId, throughBlock, fence = {}
  ) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (fence.jobId && fence.owner) await assertActiveLease(client, fence.jobId, fence.owner);
      const walletResult = await client.query(
        `SELECT w.id, w.address
           FROM evm_subjects s
           JOIN eth_wallets w ON w.user_id = s.user_id AND w.address = s.address
          WHERE s.id = $2 AND s.user_id = $1
          FOR UPDATE OF w`,
        [userId, subjectId]
      );
      const wallet = walletResult.rows[0];
      if (!wallet) throw new Error('Tracked wallet is unavailable for identity repair');

      const effectsResult = await client.query(
        `SELECT e.*,
                o.id AS indexed_observation_id,
                o.provider AS indexed_provider,
                o.evidence_kind AS indexed_evidence_kind,
                o.tx_hash AS indexed_tx_hash,
                o.log_index AS indexed_log_index,
                o.payload_json AS indexed_payload_json
           FROM evm_canonical_effects e
           JOIN evm_provider_observations o
             ON o.subject_id = e.subject_id AND o.chain_id = e.chain_id
            AND o.provider = 'moralis'
            AND o.evidence_kind = e.effect_type || '_transfer'
            AND o.tx_hash = e.tx_hash AND o.log_index = e.log_index
          JOIN evm_job_observations jo
            ON jo.job_id = $1 AND jo.observation_id = o.id
          JOIN evm_mined_transactions tx
             ON tx.subject_id = e.subject_id AND tx.chain_id = e.chain_id
            AND tx.tx_hash = e.tx_hash
          WHERE EXISTS (
                  SELECT 1 FROM evm_subjects s
                   WHERE s.id = e.subject_id AND s.user_id = $2
                )
            AND e.subject_id = $3 AND e.chain_id = $4
            AND tx.block_number <= $5
            AND e.effect_type = ANY($6::text[])
            AND e.resolution_status = 'verified'
            AND tx.resolution_status = 'verified'
          ORDER BY e.id, o.id`,
        [jobId, userId, subjectId, chainId, throughBlock, Object.keys(TRANSFER_TYPES)]
      );
      const legacyResult = await client.query(
        `SELECT * FROM eth_transfers
          WHERE wallet_id = $1 AND chain_id = $2 AND block_number <= $3
            AND transfer_type = ANY($4::text[])
            AND audit_effect_key IS NULL
          ORDER BY id
          FOR UPDATE`,
        [wallet.id, chainId, throughBlock, Object.values(TRANSFER_TYPES)]
      );

      const legacyRows = legacyResult.rows;
      const byEffect = new Map();
      for (const row of effectsResult.rows) {
        const list = byEffect.get(row.id) || [];
        list.push(row);
        byEffect.set(row.id, list);
      }
      const repaired = [];
      for (const [effectId, observations] of byEffect) {
        const effect = observations[0];
        const indexedMatches = observations.filter((observation) => matchesIndexedTransfer(
          effect,
          {
            provider: observation.indexed_provider,
            evidence_kind: observation.indexed_evidence_kind,
            tx_hash: observation.indexed_tx_hash,
            log_index: observation.indexed_log_index,
            payload_json: observation.indexed_payload_json,
          }
        ));
        if (indexedMatches.length !== 1) continue;
        const candidates = legacyRows.filter((row) => matchesLegacyTransfer(effect, row)
          && (row.source_log_index == null || Number(row.source_log_index) === Number(effect.log_index)));
        if (candidates.length !== 1) continue;
        const legacy = candidates[0];
        const conflict = await client.query(
          `SELECT 1 FROM eth_transfers
            WHERE wallet_id = $1 AND chain_id = $2 AND audit_effect_key = $3
            LIMIT 1`,
          [wallet.id, chainId, effect.effect_key]
        );
        if (conflict.rowCount) continue;
        const updated = await client.query(
          `UPDATE eth_transfers
              SET source_log_index = $2,
                  source_trace_address = $3::jsonb,
                  audit_effect_key = $4,
                  audit_observation_id = $5
            WHERE id = $1 AND audit_effect_key IS NULL
            RETURNING id`,
          [
            legacy.id, effect.log_index,
            effect.trace_address == null ? null : JSON.stringify(effect.trace_address),
            effect.effect_key, effect.selected_observation_id,
          ]
        );
        if (!updated.rowCount) continue;
        await client.query(
          `INSERT INTO evm_effect_evidence (effect_id, subject_id, chain_id, observation_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [effectId, subjectId, chainId, indexedMatches[0].indexed_observation_id]
        );
        repaired.push({ effectId: Number(effectId), transferId: legacy.id });
      }
      await client.query('COMMIT');
      return { repaired: repaired.length, transferIds: repaired.map((row) => row.transferId) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async storedFeedCoverage(userId, subjectId, chainId) {
    const { rows } = await pool.query(
      `SELECT c.*
         FROM evm_subjects s
         JOIN eth_wallets w ON w.user_id = s.user_id AND w.address = s.address
         JOIN eth_feed_coverage c ON c.wallet_id = w.id AND c.chain_id = $3
        WHERE s.id = $2 AND s.user_id = $1
        ORDER BY c.feed`,
      [userId, subjectId, chainId]
    );
    return rows;
  }

  static async activityTxHashes(userId, subjectId, chainId, throughBlock) {
    const { rows } = await pool.query(
      `SELECT a.tx_hash
         FROM evm_subjects s
         JOIN eth_wallets w ON w.user_id = s.user_id AND w.address = s.address
         JOIN eth_activity a ON a.wallet_id = w.id
        WHERE s.id = $2 AND s.user_id = $1
          AND a.chain_id = $3 AND a.block_number <= $4`,
      [userId, subjectId, chainId, throughBlock]
    );
    return new Set(rows.map((row) => row.tx_hash));
  }

  static async bridgeAudit(userId, subjectId, chainId, throughBlock) {
    const { rows } = await pool.query(
      `SELECT a.tx_hash,
              COALESCE(o.category, a.category) AS category,
              bm.status AS movement_status,
              bm.verification_method
         FROM evm_subjects s
         JOIN eth_wallets w ON w.user_id = s.user_id AND w.address = s.address
         JOIN eth_activity a ON a.wallet_id = w.id
         LEFT JOIN eth_activity_overrides o
           ON o.wallet_id = a.wallet_id AND o.chain_id = a.chain_id AND o.tx_hash = a.tx_hash
         LEFT JOIN eth_bridge_movement_members mm
           ON mm.wallet_id = a.wallet_id AND mm.chain_id = a.chain_id AND mm.tx_hash = a.tx_hash
         LEFT JOIN eth_bridge_movements bm
           ON bm.id = mm.movement_id AND bm.user_id = s.user_id AND bm.invalidated_at IS NULL
        WHERE s.id = $2 AND s.user_id = $1 AND a.chain_id = $3
          AND a.block_number <= $4
          AND COALESCE(o.category, a.category) IN ('bridge_out', 'bridge_in')
        GROUP BY a.tx_hash, COALESCE(o.category, a.category), bm.status, bm.verification_method
        ORDER BY a.tx_hash`,
      [userId, subjectId, chainId, throughBlock]
    );
    const proven = new Set(['protocol_verified', 'user_confirmed', 'refunded', 'failed']);
    const byTransaction = new Map();
    for (const row of rows) {
      const current = byTransaction.get(row.tx_hash) || {
        transaction_hash: row.tx_hash,
        category: row.category,
        statuses: [],
      };
      current.statuses.push(row.movement_status || 'unpaired');
      byTransaction.set(row.tx_hash, current);
    }
    return {
      total: byTransaction.size,
      unresolved: [...byTransaction.values()]
        .filter((row) => !row.statuses.some((status) => proven.has(status)))
        .map((row) => ({
          transaction_hash: row.transaction_hash,
          category: row.category,
          movement_status: row.statuses.find((status) => status !== 'unpaired') || 'unpaired',
        })),
    };
  }

  static async storeNonceAudit(row, fence = {}) {
    const transactional = Boolean(fence.jobId && fence.owner);
    const client = transactional ? await pool.connect() : pool;
    try {
      if (transactional) {
        await client.query('BEGIN');
        await assertActiveLease(client, fence.jobId, fence.owner);
      }
      const { rows } = await client.query(
      `INSERT INTO evm_nonce_audits (
         job_id, subject_id, chain_id, boundary_block, boundary_block_hash,
         next_mined_nonce, observed_outgoing_count, missing_nonces,
         conflicting_nonces, unknown_signedness_count, status, error_code, error_detail
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13)
       ON CONFLICT (job_id, chain_id)
       DO UPDATE SET
         boundary_block = EXCLUDED.boundary_block,
         boundary_block_hash = EXCLUDED.boundary_block_hash,
         next_mined_nonce = EXCLUDED.next_mined_nonce,
         observed_outgoing_count = EXCLUDED.observed_outgoing_count,
         missing_nonces = EXCLUDED.missing_nonces,
         conflicting_nonces = EXCLUDED.conflicting_nonces,
         unknown_signedness_count = EXCLUDED.unknown_signedness_count,
         status = EXCLUDED.status,
         error_code = EXCLUDED.error_code,
         error_detail = EXCLUDED.error_detail,
         checked_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        row.jobId, row.subjectId, row.chainId, row.boundaryBlock,
        row.boundaryBlockHash, row.nextMinedNonce, row.observedOutgoingCount,
        JSON.stringify(row.missingNonces || []), JSON.stringify(row.conflictingNonces || []),
        row.unknownSignednessCount || 0, row.status, row.errorCode || null,
        row.errorDetail || null,
      ]
    );
      if (transactional) await client.query('COMMIT');
      return rows[0];
    } catch (error) {
      if (transactional) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (transactional) client.release();
    }
  }

  static async storeBalanceAudit(row, fence = {}) {
    const transactional = Boolean(fence.jobId && fence.owner);
    const client = transactional ? await pool.connect() : pool;
    try {
      if (transactional) {
        await client.query('BEGIN');
        await assertActiveLease(client, fence.jobId, fence.owner);
      }
      const { rows } = await client.query(
      `INSERT INTO evm_balance_audits (
         job_id, subject_id, chain_id, asset_key, asset_type, boundary_block,
         derived_units, live_units, delta_units, status, detail
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       ON CONFLICT (job_id, chain_id, asset_key)
       DO UPDATE SET
         boundary_block = EXCLUDED.boundary_block,
         derived_units = EXCLUDED.derived_units,
         live_units = EXCLUDED.live_units,
         delta_units = EXCLUDED.delta_units,
         status = EXCLUDED.status,
         detail = EXCLUDED.detail,
         checked_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        row.jobId, row.subjectId, row.chainId, row.assetKey, row.assetType,
        row.boundaryBlock, row.derivedUnits, row.liveUnits, row.deltaUnits,
        row.status, JSON.stringify(row.detail || {}),
      ]
    );
      if (transactional) await client.query('COMMIT');
      return rows[0];
    } catch (error) {
      if (transactional) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (transactional) client.release();
    }
  }

  static async dueJobs(limit = 10) {
    const { rows } = await pool.query(
      `SELECT id FROM evm_audit_jobs
        WHERE (
          status = 'queued'
          OR (status = 'deferred' AND (retry_after_at IS NULL OR retry_after_at <= CURRENT_TIMESTAMP))
          OR (status = 'running' AND lease_expires_at < CURRENT_TIMESTAMP)
        )
          AND NOT EXISTS (
            SELECT 1 FROM evm_audit_jobs running
             WHERE running.user_id = evm_audit_jobs.user_id
               AND running.id <> evm_audit_jobs.id
               AND running.status = 'running'
               AND running.lease_expires_at >= CURRENT_TIMESTAMP
          )
        ORDER BY requested_at, id LIMIT $1`,
      [limit]
    );
    return rows.map((row) => row.id);
  }
}

module.exports = EvmAudit;
