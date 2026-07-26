'use strict';

const ExchangeAccount = require('../models/ExchangeAccount');
const ExchangeRecord = require('../models/ExchangeRecord');
const { connectorFor } = require('./exchangeSync');
const secretCrypto = require('../utils/secretCrypto');
const {
  absAmount, subtractAmounts, compareAmounts, scaleByPowerOfTen,
} = require('./exchangeImport/shared');
const logger = require('../config/logger');

// Dust: an exchange rounds its published balance, and the ledger does not.
// Below this the two agree for every purpose this app has.
const ABSOLUTE_TOLERANCE = '0.00000001';
// ...and 1 part per million of the position, for assets held in quantities
// where 1e-8 is meaninglessly strict.
const RELATIVE_TOLERANCE_EXPONENT = 6;

// How many mismatching assets get named in the stored report. The point is to
// tell the user something is wrong and roughly where; a 400-asset dump would
// bloat every account row for no extra signal.
const MAX_REPORTED_MISMATCHES = 25;

// Exchange account ids with a sync running right now. See _syncResolvedAccount
// for why this is in memory and what that assumes.
const inFlightAccounts = new Set();

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

/**
 * Compare a derived position against the exchange's own figure.
 *
 * A mismatch means records were missed or misparsed. It is reported, not
 * corrected: the derived figure is the thing under test, so overwriting it
 * with the live one would hide exactly the bug this check exists to find.
 */
function reconcile(derived, live) {
  const assets = [...new Set([...Object.keys(derived), ...Object.keys(live)])].sort();
  const mismatches = [];

  for (const asset of assets) {
    const derivedAmount = derived[asset] ?? '0';
    const liveAmount = live[asset] ?? '0';
    const difference = subtractAmounts(derivedAmount, liveAmount);
    const magnitude = absAmount(difference) ?? '0';

    if (compareAmounts(magnitude, ABSOLUTE_TOLERANCE) <= 0) continue;
    // |difference| * 1e6 <= |live| is the relative test, done by shifting the
    // decimal point rather than dividing, so it stays exact.
    const scaled = scaleByPowerOfTen(magnitude, RELATIVE_TOLERANCE_EXPONENT);
    if (compareAmounts(scaled, absAmount(liveAmount) ?? '0') <= 0) continue;

    mismatches.push({ asset, derived: derivedAmount, live: liveAmount, difference });
  }

  return {
    checked_at: new Date().toISOString(),
    assets_checked: assets.length,
    mismatch_count: mismatches.length,
    mismatches: mismatches.slice(0, MAX_REPORTED_MISMATCHES),
    truncated: mismatches.length > MAX_REPORTED_MISMATCHES,
  };
}

class ExchangeSyncService {
  static get ABSOLUTE_TOLERANCE() { return ABSOLUTE_TOLERANCE; }
  static reconcile(derived, live) { return reconcile(derived, live); }

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
    return ExchangeAccount.setCredentials(exchangeAccountId, userId, {
      apiKeyEncrypted: secretCrypto.encrypt(apiKey),
      apiKeyLast4: secretCrypto.last4(apiKey),
      apiSecretEncrypted: secretCrypto.encrypt(apiSecret),
      apiSecretLast4: secretCrypto.last4(apiSecret),
    });
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
    return ExchangeAccount.clearCredentials(exchangeAccountId, userId);
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
    return connector.probe(decryptCredentials(account));
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
    return this._syncResolvedAccount(account, { interactive });
  }

  // Shared by the request path and the job. The job has already resolved the
  // row (with each account's OWNER's credentials on it), so it must not be
  // made to look it up again under a userId it does not have.
  static async _syncResolvedAccount(account, { interactive }) {
    const connector = connectorFor(account.exchange);
    if (!connector) {
      const error = new Error(`There is no API sync for "${account.exchange}" accounts`);
      error.code = 'EXCHANGE_NOT_SUPPORTED';
      throw error;
    }

    // Sync Now pressed while the nightly job is mid-pass would run two walks
    // against one cursor: both read from the same resume point, both fetch the
    // same pages, and whichever finishes last overwrites the other's cursor.
    // Cheap to prevent and expensive to debug.
    //
    // In-memory on purpose. This assumes ONE app process, which is what the
    // App Service plan runs; scaling out would need this in the database (an
    // advisory lock or a claimed-at column), and the assumption is written
    // down here so the day that changes it is findable.
    if (inFlightAccounts.has(account.id)) {
      const error = new Error('A sync for this exchange account is already running');
      error.code = 'EXCHANGE_SYNC_IN_PROGRESS';
      throw error;
    }
    inFlightAccounts.add(account.id);
    try {
      return await this._runSync(account, connector, { interactive });
    } finally {
      inFlightAccounts.delete(account.id);
    }
  }

  static async _runSync(account, connector, { interactive }) {
    let result;
    try {
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
      if (err.code !== 'SECRETS_NOT_CONFIGURED') {
        // The cursor is deliberately NOT passed here: a failed sync must leave
        // the resume point exactly where it was, or the next run starts past
        // rows nobody ever read.
        await ExchangeAccount.saveSyncState(account.id, {
          status: err.code === 'EXCHANGE_NOT_CONFIGURED' ? 'not_configured' : 'error',
          error: err.message,
        });
      }
      throw err;
    }

    const records = result.records.map((record) => ({ ...record, source: 'api' }));
    const stored = await ExchangeRecord.bulkInsert(account.id, records);
    // Fills the on-chain hole a CSV-first import left behind; see the note on
    // backfillChainDetails for why the ON CONFLICT arm cannot do this.
    const backfilled = await ExchangeRecord.backfillChainDetails(account.id, records);

    const derived = await ExchangeRecord.derivedBalances(account.id, account.user_id);
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
    const report = balancesIncomplete
      ? {
        checked_at: new Date().toISOString(),
        assets_checked: 0,
        mismatch_count: 0,
        mismatches: [],
        truncated: false,
        skipped: 'live_balances_incomplete',
      }
      : reconcile(derived, result.balances || {});
    const status = (pending || balancesIncomplete)
      ? 'ok'
      : (report.mismatch_count > 0 ? 'balance_mismatch' : 'ok');

    if (balancesIncomplete) {
      logger.warn({ exchangeAccountId: account.id, exchange: account.exchange },
        'Live balances were incomplete; skipping reconciliation for this sync');
    }

    const saved = await ExchangeAccount.saveSyncState(account.id, {
      cursor: result.cursor,
      status,
      error: null,
      balanceReport: { ...report, backfill_pending: pending, balances_incomplete: balancesIncomplete },
    });

    logger.info({
      exchangeAccountId: account.id,
      userId: account.user_id,
      exchange: account.exchange,
      fetched: result.stats?.rows ?? 0,
      imported: stored.inserted,
      upgraded: stored.upgraded,
      duplicates: stored.duplicates,
      chainDetailsFilled: backfilled.filled,
      unknownTypes: result.stats?.unknownTypes ?? 0,
      mismatches: report.mismatch_count,
      backfillPending: pending,
      balancesIncomplete,
    }, 'Exchange API sync');

    return {
      account: saved,
      fetched: result.stats?.rows ?? 0,
      imported: stored.inserted,
      upgraded: stored.upgraded,
      duplicates: stored.duplicates,
      chain_details_filled: backfilled.filled,
      needs_review: records.filter((record) => record.needs_review).length,
      unknown_types: result.stats?.unknownTypes ?? 0,
      backfill_pending: pending,
      balance_report: report,
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
