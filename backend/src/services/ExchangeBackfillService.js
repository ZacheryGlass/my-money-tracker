'use strict';

const ExchangeAccount = require('../models/ExchangeAccount');
const ExchangeSyncJob = require('../models/ExchangeSyncJob');
const ExchangeSyncService = require('./ExchangeSyncService');
const { connectorFor } = require('./exchangeSync');
const secretCrypto = require('../utils/secretCrypto');
const logger = require('../config/logger');

const RATE_LIMIT_CODES = new Set([
  'KRAKEN_RATE_LIMITED',
  'COINBASE_RATE_LIMITED',
  'BINANCE_US_RATE_LIMITED',
]);
const MAX_BACKOFF_MS = 15 * 60 * 1000;
const BASE_BACKOFF_MS = 5000;
const PUMP_DELAY_MS = 250;
const TRANSIENT_RETRY_LIMIT = 5;
const TRANSIENT_CODES = new Set([
  'KRAKEN_API_ERROR',
  'COINBASE_API_ERROR',
  'BINANCE_US_API_ERROR',
]);
const TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ECONNREFUSED',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EPIPE', 'ERR_NETWORK',
  'ERR_BAD_RESPONSE', 'UND_ERR_CONNECT_TIMEOUT',
]);

let pumpPromise = null;
let pumpAgain = false;

function isRateLimited(error) {
  return Boolean(error && RATE_LIMIT_CODES.has(error.code));
}

function isTransient(error) {
  if (!error || isRateLimited(error)) return false;
  if (TRANSPORT_CODES.has(error.code)) return true;
  if (!TRANSIENT_CODES.has(error.code)) return false;
  const status = Number(error.httpStatus ?? error.response?.status ?? error.request_summary?.status);
  if (status >= 500) return true;
  return /timeout|temporar|unavailable|try again|server/i.test(String(error.message || ''));
}

function backoffDelay(attempt, retryAfterMs = 0) {
  const exponent = Math.max(0, Math.min(8, attempt - 1));
  const exponential = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** exponent));
  // A small bounded jitter keeps multiple accounts from waking together after
  // a shared provider limit, while Retry-After remains the lower bound when
  // the provider gives one. Math.random is not security-sensitive here.
  const jitter = Math.floor(exponential * 0.2 * Math.random());
  return Math.min(MAX_BACKOFF_MS, Math.max(exponential + jitter, Number(retryAfterMs) || 0));
}

function batchStats(result) {
  return {
    fetched: result.fetched || 0,
    imported: result.imported || 0,
    upgraded: result.upgraded || 0,
    duplicates: result.duplicates || 0,
    flagged: result.needs_review || 0,
    lastBatch: {
      fetched: result.fetched || 0,
      imported: result.imported || 0,
      upgraded: result.upgraded || 0,
      duplicates: result.duplicates || 0,
      flagged: result.needs_review || 0,
      chain_details_filled: result.chain_details_filled || 0,
      backfill_pending: Boolean(result.backfill_pending),
      status: result.status,
      balance_report: result.balance_report || null,
      coverage_limitations: result.coverage_limitations || [],
    },
  };
}

class ExchangeBackfillService {
  static get RATE_LIMIT_CODES() { return RATE_LIMIT_CODES; }

  static isRateLimited(error) { return isRateLimited(error); }

  static backoffDelay(attempt, retryAfterMs) {
    return backoffDelay(attempt, retryAfterMs);
  }

  static async enqueue(userId, exchangeAccountId) {
    const account = await ExchangeAccount.findWithCredentialsForUser(exchangeAccountId, userId);
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
    if (!account.api_key_encrypted || !account.api_secret_encrypted) {
      const error = new Error('This exchange account has no API key stored');
      error.code = 'EXCHANGE_NOT_CONFIGURED';
      throw error;
    }

    const job = await ExchangeSyncJob.enqueue(userId, exchangeAccountId);
    if (!job) {
      const error = new Error('The exchange backfill could not be queued');
      error.code = 'EXCHANGE_SYNC_JOB_CREATE_FAILED';
      throw error;
    }
    this.kick();
    return job;
  }

  static async status(userId, exchangeAccountId) {
    // Ownership is checked independently of job existence. A user must not be
    // able to distinguish a foreign account by probing its job history.
    const account = await ExchangeAccount.findByIdForUser(exchangeAccountId, userId);
    if (!account) {
      const error = new Error('Exchange account not found');
      error.code = 'EXCHANGE_ACCOUNT_NOT_FOUND';
      throw error;
    }
    return ExchangeSyncJob.findLatestForAccount(userId, exchangeAccountId);
  }

  /** Start/continue due work without tying it to an HTTP request lifetime. */
  static kick() {
    if (pumpPromise) {
      pumpAgain = true;
      return pumpPromise;
    }
    pumpPromise = this._pump()
      .catch((error) => logger.error({ err: error }, 'Exchange backfill pump failed'))
      .finally(() => {
        pumpPromise = null;
        if (pumpAgain) {
          pumpAgain = false;
          setTimeout(() => this.kick(), PUMP_DELAY_MS);
        }
      });
    return pumpPromise;
  }

  static async _pump() {
    // One provider batch per pump turn prevents a large Coinbase backfill from
    // monopolising the event loop. A successful pending batch schedules the
    // next turn immediately; the durable row means a restart resumes safely.
    const job = await ExchangeSyncJob.claimDue();
    if (!job) return null;
    const nextDelayMs = await this._runClaimed(job);
    // Check for another account (or the next batch) without waiting for the
    // one-minute recovery cron. _runClaimed supplies the next due delay so a
    // provider backoff does not turn into a tight polling loop.
    if (Number.isFinite(nextDelayMs)) {
      setTimeout(() => this.kick(), Math.max(0, nextDelayMs));
    }
    return job;
  }

  static async _runClaimed(job) {
    let account;
    let heartbeatTimer = null;
    let leaseLost = false;
    const claimToken = job.claim_token;
    const heartbeat = async () => {
      const renewed = await ExchangeSyncJob.heartbeat(job.id, claimToken);
      if (!renewed) leaseLost = true;
    };
    try {
      if (!claimToken) {
        logger.warn({ jobId: job.id }, 'Exchange backfill job has no claim token; leaving it for recovery');
        return PUMP_DELAY_MS;
      }
      heartbeatTimer = setInterval(() => {
        void heartbeat().catch((error) => {
          leaseLost = true;
          logger.warn({ jobId: job.id, err: error }, 'Exchange backfill lease heartbeat failed');
        });
      }, Math.floor(ExchangeSyncJob.LEASE_MS / 3));
      heartbeatTimer.unref?.();
      account = await ExchangeAccount.findWithCredentialsForUser(job.exchange_account_id, job.user_id);
      if (!account) {
        await ExchangeSyncJob.fail(job.id, claimToken, {
          errorCode: 'EXCHANGE_ACCOUNT_NOT_FOUND',
          errorMessage: 'The exchange account no longer exists',
        });
        return PUMP_DELAY_MS;
      }
      if (!account.api_key_encrypted || !account.api_secret_encrypted) {
        await ExchangeSyncJob.fail(job.id, claimToken, {
          errorCode: 'EXCHANGE_NOT_CONFIGURED',
          errorMessage: 'Exchange credentials were removed before this backfill ran',
        });
        return PUMP_DELAY_MS;
      }

      const result = await ExchangeSyncService._syncResolvedAccount(account, { interactive: false });
      const stats = batchStats(result);
      if (leaseLost) {
        logger.warn({ jobId: job.id }, 'Exchange backfill lease was lost; discarding stale progress receipt');
        return PUMP_DELAY_MS;
      }
      if (result.backfill_pending) {
        await ExchangeSyncJob.requeue(job.id, claimToken, { ...stats, backfillPending: true, delayMs: PUMP_DELAY_MS });
      } else {
        await ExchangeSyncJob.complete(job.id, claimToken, stats);
      }
      return PUMP_DELAY_MS;
    } catch (error) {
      if (error.code === 'EXCHANGE_SYNC_LOCK_LOST' || error.code === 'EXCHANGE_SYNC_LEASE_LOST') {
        logger.warn({ jobId: job.id, err: error }, 'Exchange backfill lost ownership; leaving the row for recovery');
        return PUMP_DELAY_MS;
      }
      if (error.code === 'EXCHANGE_SYNC_IN_PROGRESS') {
        // Credentials can be cleared after the initial account read but before
        // the account lease is claimed. That is not a live-sync collision: the
        // job must finish as not-configured instead of retrying forever.
        const current = await ExchangeAccount.findWithCredentialsForUser(
          job.exchange_account_id, job.user_id
        );
        if (!current || !current.api_key_encrypted || !current.api_secret_encrypted) {
          await ExchangeSyncJob.fail(job.id, claimToken, {
            errorCode: 'EXCHANGE_NOT_CONFIGURED',
            errorMessage: 'Exchange credentials were removed before this backfill ran',
          });
          return PUMP_DELAY_MS;
        }
        // The nightly one-pass job may own the account for a few seconds. It
        // is not a failed backfill and should not consume the rate-limit budget.
        await ExchangeSyncJob.requeue(job.id, claimToken, {
          backfillPending: true,
          lastBatch: { status: 'waiting_for_existing_sync' },
          delayMs: 1000,
        });
        return 1000;
      }
      if (isRateLimited(error)) {
        const attempt = (job.backoff_attempts || 0) + 1;
        const delay = backoffDelay(attempt, error.retryAfterMs);
        await ExchangeSyncJob.backoff(job.id, claimToken, {
          delayMs: delay,
          errorCode: error.code,
          errorMessage: error.message,
        });
        logger.warn({ exchangeAccountId: job.exchange_account_id, code: error.code, delayMs: delay, attempt },
          'Exchange backfill paused for provider rate limit');
        return delay;
      }
      if (isTransient(error) && (job.backoff_attempts || 0) < TRANSIENT_RETRY_LIMIT) {
        const attempt = (job.backoff_attempts || 0) + 1;
        const delay = backoffDelay(attempt);
        await ExchangeSyncJob.backoff(job.id, claimToken, {
          delayMs: delay,
          errorCode: error.code || 'EXCHANGE_TRANSIENT_ERROR',
          errorMessage: error.message,
        });
        logger.warn({ exchangeAccountId: job.exchange_account_id, code: error.code, delayMs: delay, attempt },
          'Exchange backfill paused for a transient provider error');
        return delay;
      }
      await ExchangeSyncJob.fail(job.id, claimToken, {
        errorCode: error.code,
        errorMessage: error.message,
      });
      logger.error({ exchangeAccountId: job.exchange_account_id, userId: job.user_id, err: error },
        'Exchange backfill failed');
      return PUMP_DELAY_MS;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  }
}

module.exports = ExchangeBackfillService;
