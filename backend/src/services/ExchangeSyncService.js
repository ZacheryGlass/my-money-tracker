'use strict';

const crypto = require('crypto');
const ExchangeAccount = require('../models/ExchangeAccount');
const ExchangeRecord = require('../models/ExchangeRecord');
const ExchangeSyncJob = require('../models/ExchangeSyncJob');
const ExchangeMatchService = require('./ExchangeMatchService');
const TransactionClassificationService = require('./TransactionClassificationService');
const ExchangeReconciliationService = require('./ExchangeReconciliationService');
const ExchangeBalanceReconciliationService = require('./ExchangeBalanceReconciliationService');
const { connectorFor } = require('./exchangeSync');
const secretCrypto = require('../utils/secretCrypto');
const { annotateRecords } = require('./exchangeImport/canonicalFingerprint');
const logger = require('../config/logger');

// Exchange account ids with a sync running right now. See _syncResolvedAccount
// for why this is in memory and what that assumes.
const inFlightAccounts = new Set();
const SYNC_LOCK_LEASE_MS = 10 * 60 * 1000;
const SYNC_LOCK_HEARTBEAT_MS = 3 * 60 * 1000;
const RATE_LIMIT_CODES = new Set([
  'KRAKEN_RATE_LIMITED',
  'COINBASE_RATE_LIMITED',
  'BINANCE_US_RATE_LIMITED',
]);

function notConfigured(message) {
  const error = new Error(message);
  error.code = 'EXCHANGE_NOT_CONFIGURED';
  return error;
}

/**
 * Decrypt an account's stored credentials.
 *
 * Fails closed in three separate ways, because each means something different
 * to the caller: no encryption key configured at all, no credential stored, or
 * a credential that will not decrypt (the encryption key was rotated).
 */
function decryptCredentials(account) {
  if (!secretCrypto.isConfigured()) {
    // A server misconfiguration, not a per-account one: the route answers 503
    // the same way every other key path does, rather than blaming the account.
    const error = new Error('SECRETS_ENCRYPTION_KEY is not configured on the server');
    error.code = 'SECRETS_NOT_CONFIGURED';
    throw error;
  }
  if (!account.api_key_encrypted || !account.api_secret_encrypted) {
    throw notConfigured('This exchange account has no API key stored');
  }
  try {
    return {
      apiKey: secretCrypto.decrypt(account.api_key_encrypted),
      apiSecret: secretCrypto.decrypt(account.api_secret_encrypted),
    };
  } catch (err) {
    // Distinct from "no credential": the row is still there and can be
    // replaced, and saying so is the difference between the user re-entering
    // the key and assuming the integration is broken.
    const error = new Error('The stored API key could not be decrypted (the encryption key may have changed). Re-enter it.');
    error.code = 'EXCHANGE_CREDENTIAL_UNREADABLE';
    error.cause = err;
    throw error;
  }
}

class ExchangeSyncService {
  static get ABSOLUTE_TOLERANCE() { return '0.00000001'; }
  static get RATE_LIMIT_CODES() { return RATE_LIMIT_CODES; }
  static reconcile(derived, live) {
    return { checked_at: new Date().toISOString(), ...ExchangeReconciliationService.reconcile(derived, live) };
  }

  /**
   * Store a credential pair. Mirrors the API Keys tab exactly: AES-256-GCM
   * under SECRETS_ENCRYPTION_KEY, only the last four characters kept in the
   * clear, and a 503 rather than a plaintext fallback when the server has no
   * encryption key -- storing a key in the clear "just this once" is how a
   * plaintext secret ends up in a backup.
   */
  static async setCredentials(userId, exchangeAccountId, { apiKey, apiSecret }) {
    const account = await ExchangeAccount.findByIdForUser(exchangeAccountId, userId);
    if (!account) {
      const error = new Error('Exchange account not found');
      error.code = 'EXCHANGE_ACCOUNT_NOT_FOUND';
      throw error;
    }
    if (!connectorFor(account.exchange)) {
      const error = new Error(`There is no API sync for "${account.exchange}" accounts; use CSV import instead`);
      error.code = 'EXCHANGE_NOT_SUPPORTED';
      throw error;
    }
    if (!secretCrypto.isConfigured()) {
      const error = new Error('SECRETS_ENCRYPTION_KEY is not configured on the server');
      error.code = 'SECRETS_NOT_CONFIGURED';
      throw error;
    }
    // Pending work is cancelled inside ExchangeAccount.setCredentials while
    // the account row is locked. That transaction is shared with enqueue(), so
    // a new job cannot be inserted between cancellation and key replacement.
    const saved = await ExchangeAccount.setCredentials(exchangeAccountId, userId, {
      apiKeyEncrypted: secretCrypto.encrypt(apiKey),
      apiKeyLast4: secretCrypto.last4(apiKey),
      apiSecretEncrypted: secretCrypto.encrypt(apiSecret),
      apiSecretLast4: secretCrypto.last4(apiSecret),
    });
    if (!saved) {
      const error = new Error('A sync for this exchange account is already running; wait for it to finish before replacing the key');
      error.code = 'EXCHANGE_SYNC_IN_PROGRESS';
      throw error;
    }
    return saved;
  }

  /**
   * Revoke a stored credential.
   *
   * Deliberately NOT gated on SECRETS_ENCRYPTION_KEY, unlike the write path.
   * Clearing is a DELETE of ciphertext -- it decrypts nothing and encrypts
   * nothing -- and the case that most needs it is exactly the case the gate
   * blocked: a key that was rotated or lost, leaving a credential the user can
   * neither use nor remove.
   */
  static async clearCredentials(userId, exchangeAccountId) {
    const account = await ExchangeAccount.findByIdForUser(exchangeAccountId, userId);
    if (!account) {
      const error = new Error('Exchange account not found');
      error.code = 'EXCHANGE_ACCOUNT_NOT_FOUND';
      throw error;
    }
    // Clear atomically only when no direct/nightly sync owns the account lease.
    // Otherwise a worker that already decrypted the old key could continue
    // calling the provider after the user thought Disconnect had revoked it.
    // Queued durable work has no account lease and is cancelled immediately
    // after the credential wipe; a running worker simply finishes and releases
    // its lease before Disconnect can succeed.
    const cleared = await ExchangeAccount.clearCredentials(exchangeAccountId, userId);
    if (!cleared) {
      const error = new Error('A sync for this exchange account is already running; wait for it to finish before removing the key');
      error.code = 'EXCHANGE_SYNC_IN_PROGRESS';
      throw error;
    }
    try {
      await ExchangeSyncJob.cancelForAccount(exchangeAccountId);
    } catch (error) {
      // The key is already gone, which is the safety-critical operation. A
      // queued worker will fail closed on its next claim because credentials
      // are absent; do not report a successful revocation as a 500 merely
      // because cleanup of its durable receipt was unavailable.
      logger.warn({ exchangeAccountId, err: error }, 'Exchange sync job cancellation after credential removal failed');
    }
    return cleared;
  }

  /**
   * The Test Connection probe. One authenticated READ -- Kraken's Balance,
   * Coinbase's accounts list -- and nothing is written anywhere. It exists so
   * that "I pasted a key" and "the key works" are separable events; without it
   * the first evidence of a bad key is a failed sync hours later.
   */
  static async testConnection(userId, exchangeAccountId) {
    const account = await ExchangeAccount.findWithCredentialsForUser(exchangeAccountId, userId);
    if (!account) {
      const error = new Error('Exchange account not found');
      error.code = 'EXCHANGE_ACCOUNT_NOT_FOUND';
      throw error;
    }
    const connector = connectorFor(account.exchange);
    if (!connector) {
      const error = new Error(`There is no API sync for "${account.exchange}" accounts`);
      error.code = 'EXCHANGE_NOT_SUPPORTED';
      throw error;
    }
    if (!account.api_key_encrypted || !account.api_secret_encrypted) {
      throw notConfigured('This exchange account has no API key stored');
    }

    // A connection probe is still a provider call. Use the same database
    // lease as a sync so Disconnect or key rotation cannot clear/replace the
    // key while the old ciphertext is in flight.
    const syncLockToken = crypto.randomUUID();
    const claimed = await ExchangeAccount.claimSyncLock(
      account.id, syncLockToken, SYNC_LOCK_LEASE_MS
    );
    if (!claimed) {
      const error = new Error('A sync or connection test for this exchange account is already running');
      error.code = 'EXCHANGE_SYNC_IN_PROGRESS';
      throw error;
    }
    let heartbeatTimer = null;
    try {
      const currentAccount = await ExchangeAccount.findWithCredentialsForUser(account.id, userId);
      if (!currentAccount || !currentAccount.api_key_encrypted || !currentAccount.api_secret_encrypted) {
        const error = new Error('The exchange credentials were removed before the connection test started');
        error.code = 'EXCHANGE_SYNC_LOCK_LOST';
        throw error;
      }
      const currentConnector = connectorFor(currentAccount.exchange);
      if (!currentConnector) {
        const error = new Error(`There is no API sync for "${currentAccount.exchange}" accounts`);
        error.code = 'EXCHANGE_NOT_SUPPORTED';
        throw error;
      }
      heartbeatTimer = setInterval(() => {
        void ExchangeAccount.refreshSyncLock(account.id, syncLockToken, SYNC_LOCK_LEASE_MS)
          .catch((error) => logger.warn({ accountId: account.id, err: error }, 'Exchange probe lock heartbeat failed'));
      }, SYNC_LOCK_HEARTBEAT_MS);
      heartbeatTimer.unref?.();
      if (!await ExchangeAccount.ownsSyncLock(account.id, syncLockToken)) {
        const error = new Error('The exchange connection test lost ownership before contacting the provider');
        error.code = 'EXCHANGE_SYNC_LOCK_LOST';
        throw error;
      }
      const result = await currentConnector.probe(decryptCredentials(currentAccount));
      if (!await ExchangeAccount.ownsSyncLock(account.id, syncLockToken)) {
        const error = new Error('The exchange connection test lost ownership before completing');
        error.code = 'EXCHANGE_SYNC_LOCK_LOST';
        throw error;
      }
      return result;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await ExchangeAccount.releaseSyncLock(account.id, syncLockToken)
        .catch((error) => logger.warn({ accountId: account.id, err: error }, 'Exchange probe lock release failed'));
    }
  }

  /**
   * One sync pass for one account.
   *
   * Order matters: records are stored BEFORE the balance check, so a sync that
   * finds a discrepancy still keeps everything it fetched. The check is a
   * verdict on the data, not a gate in front of it.
   */
  static async syncAccount(userId, exchangeAccountId, { interactive = true } = {}) {
    const account = await ExchangeAccount.findWithCredentialsForUser(exchangeAccountId, userId);
    if (!account) {
      const error = new Error('Exchange account not found');
      error.code = 'EXCHANGE_ACCOUNT_NOT_FOUND';
      throw error;
    }
    if (!account.api_key_encrypted || !account.api_secret_encrypted) {
      throw notConfigured('This exchange account has no API key stored');
    }
    if (await ExchangeSyncJob.hasActiveForAccount(exchangeAccountId)) {
      const error = new Error('A background sync for this exchange account is already running');
      error.code = 'EXCHANGE_SYNC_IN_PROGRESS';
      throw error;
    }
    return this._syncResolvedAccount(account, { interactive });
  }

  // Shared by the request path and the job. The job has already resolved the
  // row (with each account's OWNER's credentials on it), so it must not be
  // made to look it up again under a userId it does not have.
  static async _syncResolvedAccount(account, { interactive, syncJobId = null }) {
    if (!account.api_key_encrypted || !account.api_secret_encrypted) {
      throw notConfigured('This exchange account has no API key stored');
    }
    // Sync Now pressed while the nightly job is mid-pass would run two walks
    // against one cursor: both read from the same resume point, both fetch the
    // same pages, and whichever finishes last overwrites the other's cursor.
    // Cheap to prevent and expensive to debug.
    //
    // This in-memory guard is only a cheap same-process fast path. The
    // database-backed lease below is the cross-process ownership boundary.
    if (inFlightAccounts.has(account.id)) {
      const error = new Error('A sync for this exchange account is already running');
      error.code = 'EXCHANGE_SYNC_IN_PROGRESS';
      throw error;
    }
    inFlightAccounts.add(account.id);
    const syncLockToken = crypto.randomUUID();
    let lockClaimed = false;
    let heartbeatTimer = null;
    try {
      lockClaimed = Boolean(await ExchangeAccount.claimSyncLock(
        account.id, syncLockToken, SYNC_LOCK_LEASE_MS
      ));
      if (!lockClaimed) {
        const error = new Error('A sync for this exchange account is already running');
        error.code = 'EXCHANGE_SYNC_IN_PROGRESS';
        throw error;
      }
      // Credentials can be replaced after the caller loaded its account but
      // before this lease was claimed. Re-read under the lease so the provider
      // request uses the current key, and so a concurrent disconnect cannot
      // turn into a stale worker that writes after the account was cleared.
      const currentAccount = await ExchangeAccount.findWithCredentialsForUser(account.id, account.user_id);
      if (!currentAccount) {
        const error = new Error('The exchange credentials were removed before the sync started');
        error.code = 'EXCHANGE_SYNC_LOCK_LOST';
        throw error;
      }
      // The account may have changed providers after the caller/job loaded its
      // snapshot but before this lease was claimed. Resolve the connector from
      // the fresh, leased row so new credentials can never be sent to the old
      // provider implementation.
      const connector = connectorFor(currentAccount.exchange);
      if (!connector) {
        const error = new Error(`There is no API sync for "${currentAccount.exchange}" accounts`);
        error.code = 'EXCHANGE_NOT_SUPPORTED';
        throw error;
      }
      heartbeatTimer = setInterval(() => {
        void ExchangeAccount.refreshSyncLock(account.id, syncLockToken, SYNC_LOCK_LEASE_MS)
          .catch((error) => logger.warn({ accountId: account.id, err: error }, 'Exchange sync lock heartbeat failed'));
      }, SYNC_LOCK_HEARTBEAT_MS);
      heartbeatTimer.unref?.();
      return await this._runSync(currentAccount, connector, { interactive, syncLockToken, syncJobId });
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (lockClaimed) {
        await ExchangeAccount.releaseSyncLock(account.id, syncLockToken)
          .catch((error) => logger.warn({ accountId: account.id, err: error }, 'Exchange sync lock release failed'));
      }
      inFlightAccounts.delete(account.id);
    }
  }

  static async _runSync(account, connector, {
    interactive, syncLockToken = null, syncJobId = null,
  }) {
    let result;
    try {
      if (syncLockToken && !await ExchangeAccount.ownsSyncLock(account.id, syncLockToken)) {
        const error = new Error('The exchange sync lost ownership before contacting the provider');
        error.code = 'EXCHANGE_SYNC_LOCK_LOST';
        throw error;
      }
      result = await connector.sync(decryptCredentials(account), {
        cursor: account.sync_cursor ?? null,
        interactive,
      });
    } catch (err) {
      // A server-wide condition is not a fact about this account. Stamping
      // last_sync_status='not_configured' when the SERVER has no encryption
      // key records "this account has no key" against an account whose key is
      // stored and fine, and it survives after the server is fixed. Nothing is
      // written on that path at all.
      if (err.code !== 'SECRETS_NOT_CONFIGURED' && !RATE_LIMIT_CODES.has(err.code)) {
        // The cursor is deliberately NOT passed here: a failed sync must leave
        // the resume point exactly where it was, or the next run starts past
        // rows nobody ever read.
        const savedError = await ExchangeAccount.saveSyncState(account.id, {
          status: err.code === 'EXCHANGE_NOT_CONFIGURED' ? 'not_configured' : 'error',
          error: err.message,
          syncLockToken,
        });
        if (!savedError && syncLockToken) {
          const lost = new Error('The exchange sync lost ownership before recording its error');
          lost.code = 'EXCHANGE_SYNC_LOCK_LOST';
          throw lost;
        }
      }
      throw err;
    }

    // A lease can expire during an unusually slow provider call. Do not write
    // rows fetched with a key that another request has since revoked/replaced.
    if (syncLockToken && !await ExchangeAccount.ownsSyncLock(account.id, syncLockToken)) {
      const error = new Error('The exchange sync lost ownership before storing provider rows');
      error.code = 'EXCHANGE_SYNC_LOCK_LOST';
      throw error;
    }

    const records = annotateRecords(account.exchange, result.records.map((record) => ({ ...record, source: 'api' })));
    const write = await ExchangeAccount.withSyncWriteTransaction(
      account.id,
      account.user_id,
      syncLockToken,
      async (client, lockedAccount) => {
        const stored = await ExchangeRecord.bulkInsert(account.id, records, { syncLockToken, client });
        // Fills the on-chain hole a CSV-first import left behind; see the note
        // on backfillChainDetails for why the ON CONFLICT arm cannot do this.
        const backfilled = await ExchangeRecord.backfillChainDetails(
          account.id, records, { syncLockToken, client }
        );
        const { derived, latestRecordAt } = await ExchangeRecord.reconciliationInputs(
          account.id, account.user_id, { client }
        );
        // A truncated backfill has not read the whole history yet, so a mismatch
        // says nothing about the parser. Calling it 'balance_mismatch' here would
        // train the user to ignore the flag before it ever means anything.
        const pending = Boolean(result.stats?.backfillPending);
        // The same argument from the other side: a connector that could not
        // enumerate every live balance is comparing against a picture with holes
        // in it, and every unenumerated asset reads as a zero the ledger
        // contradicts. The comparison is skipped outright rather than run and
        // discounted -- a stored report full of phantom mismatches is worse than
        // none.
        const balancesIncomplete = result.balancesComplete === false;
        const coverageLimitations = Array.isArray(result.coverageLimitations)
          ? result.coverageLimitations.filter(Boolean)
          : [];
        if (balancesIncomplete) {
          coverageLimitations.push('The live balance list was incomplete; reconciliation was skipped for this batch.');
        }
        const providerSnapshot = balancesIncomplete
          ? undefined
          : ExchangeReconciliationService.snapshotEnvelope(
            lockedAccount,
            result.balances || {},
            result.balance_observed_at || new Date().toISOString()
          );
        const reconciliation = ExchangeReconciliationService.buildReconciliation({
          account: lockedAccount,
          derived,
          snapshot: providerSnapshot || lockedAccount.provider_balance_snapshot,
          latestRecordAt,
          existingReport: lockedAccount.balance_report,
          backfillPending: pending,
          balancesIncomplete,
          coverageLimitations,
        });
        const status = pending
          ? 'ok'
          : (balancesIncomplete
            ? 'coverage_limited'
            : (reconciliation.report.mismatch_count > 0
              ? 'balance_mismatch'
              : (coverageLimitations.length > 0 ? 'coverage_limited' : 'ok')));

        if (balancesIncomplete) {
          logger.warn({ exchangeAccountId: account.id, exchange: account.exchange },
            'Live balances were incomplete; skipping reconciliation for this sync');
        }

        const saved = await ExchangeAccount.saveSyncState(account.id, {
          cursor: result.cursor,
          status,
          error: null,
          balanceReport: reconciliation.report,
          providerBalanceSnapshot: providerSnapshot,
          reconciliationStatus: reconciliation.status,
          syncLockToken,
          client,
        });
        if (!saved) {
          const error = new Error('The exchange sync lost ownership of the account cursor');
          error.code = 'EXCHANGE_SYNC_LOCK_LOST';
          throw error;
        }
        return {
          stored,
          backfilled,
          derived,
          pending,
          balancesIncomplete,
          coverageLimitations,
          report: reconciliation.report,
          reconciliationStatus: reconciliation.status,
          status,
          saved,
        };
      }
    );
    const {
      stored, backfilled, pending, balancesIncomplete, coverageLimitations,
      report, reconciliationStatus, status: legacyStatus, saved: initiallySaved, derived,
    } = write;

    // The immutable per-asset audit is the source of truth for reviewed
    // exceptions. It runs after the atomic record/snapshot transaction commits
    // so its independent transaction sees the exact ledger just stored.
    // Fail closed to the compatibility reconciliation if the audit tables are
    // temporarily unavailable; never pretend the exception queue is empty.
    let balanceAudit = { available: false, authoritative: false };
    try {
      balanceAudit = await ExchangeBalanceReconciliationService.auditAccount(account.id, {
        syncJobId,
        derived,
        live: result.balances || {},
        balanceDetails: result.balance_details || {},
        backfillPending: pending,
        balancesIncomplete,
        coverageLimitations,
        calculatedAt: result.balance_observed_at || new Date().toISOString(),
      });
    } catch (error) {
      logger.error({ err: error, exchangeAccountId: account.id },
        'Exchange balance audit failed; preserving compatibility reconciliation result');
    }
    const status = balanceAudit.available && balanceAudit.authoritative
      ? (balanceAudit.blocking_exception_count > 0
        ? 'balance_mismatch'
        : (balanceAudit.exception_count > 0 ? 'reconciled_with_exceptions' : 'ok'))
      : legacyStatus;
    let saved = initiallySaved;
    if (status !== legacyStatus) {
      saved = await ExchangeAccount.saveSyncState(account.id, {
        status,
        error: null,
        syncLockToken,
      });
      if (!saved) {
        const error = new Error('The exchange sync lost ownership before storing its audit status');
        error.code = 'EXCHANGE_SYNC_LOCK_LOST';
        throw error;
      }
    }

    // API-sourced records are the ones that most often carry the exact tx_hash,
    // which is what upgrades a match from heuristic to exact -- so a sync is the
    // single most productive moment to re-derive them (#61). Non-fatal: the
    // records are already stored and the sync succeeded.
    const matches = await ExchangeMatchService.rebuildForUserSafely(account.user_id, {
      exchangeAccountId: account.id,
    });
    // A newly discovered fiat rail link must immediately stop the bank leg
    // from counting as spending; waiting for the nightly expense job would
    // show the same cash movement twice in the meantime.
    await TransactionClassificationService.backfillForUser(account.user_id);

    logger.info({
      exchangeAccountId: account.id,
      userId: account.user_id,
      exchange: account.exchange,
      fetched: result.stats?.rows ?? 0,
      imported: stored.inserted,
      upgraded: stored.upgraded,
      duplicates: stored.duplicates,
      deduplicated: stored.deduplicated,
      duplicate_candidates: stored.duplicateCandidates,
      duplicate_conflicts: stored.duplicateConflicts,
      chainDetailsFilled: backfilled.filled,
      unknownTypes: result.stats?.unknownTypes ?? 0,
      mismatches: report.mismatch_count,
      reconciliationStatus,
      backfillPending: pending,
      balancesIncomplete,
      matched: matches?.matches ?? 0,
    }, 'Exchange API sync');

    return {
      account: saved,
      fetched: result.stats?.rows ?? 0,
      imported: stored.inserted,
      upgraded: stored.upgraded,
      duplicates: stored.duplicates,
      deduplicated: stored.deduplicated,
      duplicate_candidates: stored.duplicateCandidates,
      duplicate_conflicts: stored.duplicateConflicts,
      chain_details_filled: backfilled.filled,
      needs_review: records.filter((record) => record.needs_review).length,
      unknown_types: result.stats?.unknownTypes ?? 0,
      backfill_pending: pending,
      balance_report: { ...report, coverage_limitations: coverageLimitations },
      reconciliation_status: reconciliationStatus,
      reconciliation: { status: reconciliationStatus, ...report },
      balance_audit: balanceAudit,
      coverage_limitations: coverageLimitations,
      matched: matches?.matches ?? 0,
      status,
    };
  }

  /**
   * Every connected account, for the nightly job.
   *
   * Follows the Plaid/ETH convention exactly: iterate accounts, resolve each
   * account OWNER's credentials, and skip-and-log the ones that are not
   * configured rather than failing the whole run. One user's rotated key must
   * not stop another user's sync.
   */
  static async syncAllAccounts() {
    const accounts = await ExchangeAccount.findAllForJobs();
    const summary = {
      processed: 0, succeeded: 0, failed: 0, skipped: 0, mismatched: 0, results: [],
    };

    for (const account of accounts) {
      summary.processed += 1;
      try {
        // A user-requested durable backfill owns this cursor until it reaches
        // the end. The check is database-backed, so a nightly scheduler on a
        // second App Service instance cannot race the worker from instance A.
        if (await ExchangeSyncJob.hasActiveForAccount(account.id)) {
          summary.skipped += 1;
          summary.results.push({ exchangeAccountId: account.id, skipped: 'EXCHANGE_BACKFILL_ACTIVE' });
          continue;
        }
        const result = await this._syncResolvedAccount(account, { interactive: false });
        summary.succeeded += 1;
        if (result.status === 'balance_mismatch') summary.mismatched += 1;
        summary.results.push({
          exchangeAccountId: account.id,
          exchange: account.exchange,
          imported: result.imported,
          upgraded: result.upgraded,
          status: result.status,
          backfillPending: result.backfill_pending,
        });
      } catch (err) {
        if (err.code === 'EXCHANGE_NOT_CONFIGURED'
          || err.code === 'EXCHANGE_CREDENTIAL_UNREADABLE'
          || err.code === 'SECRETS_NOT_CONFIGURED'
          || err.code === 'EXCHANGE_NOT_SUPPORTED'
          // Someone pressed Sync Now on this account seconds ago; that pass is
          // doing the work. Skipping is the correct outcome, not a failure.
          || err.code === 'EXCHANGE_SYNC_IN_PROGRESS') {
          summary.skipped += 1;
          summary.results.push({ exchangeAccountId: account.id, skipped: err.code });
          logger.warn({ exchangeAccountId: account.id, userId: account.user_id, code: err.code },
            'Skipping exchange account: owner has no usable API key');
          continue;
        }
        summary.failed += 1;
        summary.results.push({ exchangeAccountId: account.id, error: err.message });
        logger.error({ exchangeAccountId: account.id, err }, 'Failed to sync exchange account');
      }
    }

    return summary;
  }
}

module.exports = ExchangeSyncService;
