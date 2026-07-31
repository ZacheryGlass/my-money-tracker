'use strict';

const pool = require('../config/database');

// Root table: ownership lives here and exchange_records inherits it by joining
// through this table. Every read is scoped, and a missing userId throws rather
// than quietly widening to every user's accounts.
function requireUserId(method, userId) {
  if (!userId) {
    throw new Error(`ExchangeAccount.${method} requires a userId`);
  }
}

const EXCHANGES = new Set(['coinbase', 'kraken', 'binance_us', 'other']);
// Which venues the API sync can talk to is NOT a model concern: the single
// source of truth is CONNECTORS in services/exchangeSync/index.js, which the
// routes and ExchangeSyncService both consult via connectorFor().

// Migration 040 put ciphertext on this table, so `SELECT *` is now a leak
// waiting to happen: every route that returns an account returns whatever the
// query selected. Anything user-facing goes through this list instead, which
// omits api_key_encrypted and api_secret_encrypted and keeps only the last4
// the masked status is built from.
const PUBLIC_COLUMNS = [
  'id', 'user_id', 'name', 'exchange', 'last_import_at', 'created_at', 'updated_at',
  'api_key_last4', 'api_secret_last4',
  'last_sync_at', 'last_sync_status', 'last_sync_error', 'balance_report',
  // Deliberately NOT sync_cursor: it is an internal resume point, and for
  // Coinbase it carries per-account ids that are of no use to the client.
];

const publicSelect = (alias) => PUBLIC_COLUMNS.map((column) => `${alias}.${column}`).join(', ');

// "Is a credential stored", answered without decrypting anything. The route
// turns this into {configured, masked} -- the same contract the API Keys tab
// has, where the client only ever learns the last four characters.
const CREDENTIAL_FLAG = 'api_key_encrypted IS NOT NULL AS api_configured';

class ExchangeAccount {
  static get EXCHANGES() {
    return EXCHANGES;
  }

  static get PUBLIC_COLUMNS() {
    return PUBLIC_COLUMNS;
  }

  // The Settings list: each account with the two numbers that tell the user
  // whether an import worked -- how many records it holds and when it last ran.
  static async findAllByUser(userId) {
    requireUserId('findAllByUser', userId);
    const result = await pool.query(
      `SELECT ${publicSelect('ea')},
              ea.${CREDENTIAL_FLAG},
              COUNT(er.id)::int AS record_count,
              COUNT(er.id) FILTER (WHERE er.needs_review)::int AS needs_review_count,
              MIN(er.occurred_at) AS first_record_at,
              MAX(er.occurred_at) AS last_record_at
       FROM exchange_accounts ea
       LEFT JOIN exchange_records er ON er.exchange_account_id = ea.id
       WHERE ea.user_id = $1
       GROUP BY ea.id
       ORDER BY ea.created_at DESC`,
      [userId]
    );
    return result.rows;
  }

  // The route-facing lookup. Public columns only: whatever a route hands back
  // as `account` is what reaches the browser.
  static async findByIdForUser(id, userId) {
    requireUserId('findByIdForUser', userId);
    const result = await pool.query(
      `SELECT ${PUBLIC_COLUMNS.join(', ')}, ${CREDENTIAL_FLAG}
       FROM exchange_accounts WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    return result.rows[0];
  }

  // The one read that returns ciphertext, named so it cannot be reached by
  // accident. Only ExchangeSyncService calls it, and it decrypts in-process:
  // nothing here is ever serialized into a response.
  static async findWithCredentialsForUser(id, userId) {
    requireUserId('findWithCredentialsForUser', userId);
    const result = await pool.query(
      'SELECT * FROM exchange_accounts WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    return result.rows[0];
  }

  // Cross-user, for the nightly job only -- the same explicit escape hatch
  // EthWallet and PlaidItem have. Restricted to accounts that actually hold a
  // credential, so an account that only ever took CSV uploads is not counted
  // as a skip every single night.
  static async findAllForJobs() {
    const result = await pool.query(
      `SELECT * FROM exchange_accounts
       WHERE api_key_encrypted IS NOT NULL
       ORDER BY id`
    );
    return result.rows;
  }

  static async create(userId, { name, exchange }) {
    requireUserId('create', userId);
    const result = await pool.query(
      `INSERT INTO exchange_accounts (user_id, name, exchange)
       VALUES ($1, $2, $3)
       RETURNING ${PUBLIC_COLUMNS.join(', ')}, ${CREDENTIAL_FLAG}`,
      [userId, name, exchange]
    );
    return result.rows[0];
  }

  // Both filters on the same statement: a foreign id updates nothing and the
  // route turns the empty result into a 404.
  static async update(id, userId, { name, exchange }) {
    requireUserId('update', userId);
    const result = await pool.query(
      `UPDATE exchange_accounts
       SET name = COALESCE($3, name),
           exchange = COALESCE($4, exchange),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
       RETURNING ${PUBLIC_COLUMNS.join(', ')}, ${CREDENTIAL_FLAG}`,
      [id, userId, name ?? null, exchange ?? null]
    );
    return result.rows[0];
  }

  static async delete(id, userId) {
    requireUserId('delete', userId);
    const result = await pool.query(
      `DELETE FROM exchange_accounts WHERE id = $1 AND user_id = $2
       RETURNING ${PUBLIC_COLUMNS.join(', ')}`,
      [id, userId]
    );
    return result.rows[0];
  }

  static async touchImport(id, userId) {
    requireUserId('touchImport', userId);
    const result = await pool.query(
      `UPDATE exchange_accounts
       SET last_import_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
       RETURNING ${PUBLIC_COLUMNS.join(', ')}, ${CREDENTIAL_FLAG}`,
      [id, userId]
    );
    return result.rows[0];
  }

  // Both halves in one statement. The table's CHECK requires them to be set
  // and cleared together -- half a credential fails every request with a
  // signature error instead of being skipped as unconfigured.
  //
  // Changing the key invalidates the cursor's provenance but not the cursor
  // itself: the records already stored are still the same account's, and
  // UNIQUE (exchange_account_id, external_id) makes a re-fetch of overlapping
  // history a no-op, so the resume point is deliberately left alone.
  static async setCredentials(id, userId, {
    apiKeyEncrypted, apiKeyLast4, apiSecretEncrypted, apiSecretLast4,
  }) {
    requireUserId('setCredentials', userId);
    const result = await pool.query(
      `UPDATE exchange_accounts
       SET api_key_encrypted = $3,
           api_key_last4 = $4,
           api_secret_encrypted = $5,
           api_secret_last4 = $6,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
       RETURNING ${PUBLIC_COLUMNS.join(', ')}, ${CREDENTIAL_FLAG}`,
      [id, userId, apiKeyEncrypted, apiKeyLast4, apiSecretEncrypted, apiSecretLast4]
    );
    return result.rows[0];
  }

  // Disconnecting keeps every record already imported -- exactly like an ETH
  // wallet disconnected with removeData=false. The history is the part no live
  // connection can recover once the key is gone.
  static async clearCredentials(id, userId) {
    requireUserId('clearCredentials', userId);
    const result = await pool.query(
      `UPDATE exchange_accounts
       SET api_key_encrypted = NULL,
           api_key_last4 = NULL,
           api_secret_encrypted = NULL,
           api_secret_last4 = NULL,
           last_sync_status = NULL,
           last_sync_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2
       RETURNING ${PUBLIC_COLUMNS.join(', ')}, ${CREDENTIAL_FLAG}`,
      [id, userId]
    );
    return result.rows[0];
  }

  // Written by the job, which iterates every user's accounts, so this one is
  // keyed by id alone -- the caller is findAllForJobs, not a request.
  //
  // The cursor is only advanced when a cursor is passed: a failed sync writes
  // its status and leaves the resume point where it was, because advancing
  // past rows that were never fetched would drop them silently and forever
  // (the same rule the ETH per-feed cursors follow).
  static async saveSyncState(id, { cursor, status, error, balanceReport }) {
    const result = await pool.query(
      `UPDATE exchange_accounts
       SET sync_cursor = COALESCE($2::jsonb, sync_cursor),
           last_sync_at = CURRENT_TIMESTAMP,
           last_sync_status = $3,
           last_sync_error = $4,
           balance_report = COALESCE($5::jsonb, balance_report),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING ${PUBLIC_COLUMNS.join(', ')}, ${CREDENTIAL_FLAG}`,
      [
        id,
        cursor === undefined || cursor === null ? null : JSON.stringify(cursor),
        status ?? null,
        error ?? null,
        balanceReport === undefined || balanceReport === null ? null : JSON.stringify(balanceReport),
      ]
    );
    return result.rows[0];
  }
}

module.exports = ExchangeAccount;
