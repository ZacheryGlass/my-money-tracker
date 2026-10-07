'use strict';

// Canonical, user-scoped digest of everything derived from the crypto inputs,
// plus a digest of the inputs themselves. Two runs over the same inputs must
// hash identically even though rebuilds churn surrogate ids and refresh
// timestamps and finality boundaries; any change in what a derived row SAYS
// must change the hash.
//
// Canonicalization:
//   - surrogate ids are replaced by natural keys in SQL (wallet address,
//     (wallet, chain, tx_hash) for activity, (exchange, account, external_id)
//     for venue records, (protocol, family_version, correlation_key) for bridge
//     movements, (wallet, chain, type, tx_hash, ordinal) for transfers);
//   - id columns and churn-only keys are dropped, recursively inside JSON too;
//   - bookkeeping timestamps are dropped, and inside any `finality` object only
//     `status` and `method` survive (the boundary block moves forward on every
//     refresh without changing the verdict);
//   - rows are stable-stringified with sorted keys and hashed as a sorted set.

const crypto = require('crypto');

const CHURN_KEYS = new Set([
  'id', 'receipt_id', 'activity_id', 'out_activity_id', 'in_activity_id', 'movement_id',
  'link_id', 'suggestion_id', 'transfer_id', 'eth_transfer_id', 'wallet_id', 'out_wallet_id',
  'in_wallet_id', 'account_id', 'exchange_record_id', 'counter_record_id', 'exchange_account_id',
  'transaction_id',
]);
const TIMESTAMP_KEYS = new Set([
  'created_at', 'updated_at', 'matched_at', 'classified_at', 'checked_at', 'fetched_at',
  'invalidated_at', 'attempted_at', 'observed_at', 'last_synced_at',
]);
const FINALITY_KEEP = new Set(['status', 'method']);

function canonicalize(value, parentKey = null) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (CHURN_KEYS.has(key) || TIMESTAMP_KEYS.has(key)) continue;
      if (parentKey === 'finality' && !FINALITY_KEEP.has(key)) continue;
      out[key] = canonicalize(value[key], key);
    }
    return out;
  }
  return value;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function hashRows(rows) {
  const lines = rows.map((row) => stableStringify(canonicalize(row))).sort();
  const hash = crypto.createHash('sha256');
  for (const line of lines) hash.update(line).update('\n');
  return { rows: lines.length, sha256: hash.digest('hex'), lines };
}

const WALLETS = 'SELECT id, address FROM eth_wallets WHERE user_id = $1';
const ACTIVITY_KEY = (alias, walletAlias) =>
  `(${walletAlias}.address || ':' || ${alias}.chain_id || ':' || LOWER(${alias}.tx_hash))`;
const RECORD_KEY = (recordAlias, accountAlias) =>
  `(${accountAlias}.exchange || ':' || ${accountAlias}.name || ':' || ${recordAlias}.external_id)`;
const MOVEMENT_KEY = (alias) =>
  `(${alias}.protocol || ':' || ${alias}.family_version || ':' || ${alias}.correlation_key)`;

// Every query takes the user id as $1 and returns JSON-able rows. `requires`
// names tables that must exist; an older schema simply skips the table.
const DERIVED_TABLES = {
  eth_activity: {
    requires: ['eth_activity'],
    sql: `SELECT w.address AS wallet, to_jsonb(a) AS row
            FROM eth_activity a JOIN (${WALLETS}) w ON w.id = a.wallet_id`,
  },
  eth_activity_links: {
    requires: ['eth_activity_links', 'eth_bridge_movements'],
    sql: `SELECT ${ACTIVITY_KEY('oa', 'ow')} AS out_activity, ${ACTIVITY_KEY('ia', 'iw')} AS in_activity,
                 ${MOVEMENT_KEY('m')} AS movement, to_jsonb(l) AS row
            FROM eth_activity_links l
            JOIN eth_activity oa ON oa.id = l.out_activity_id
            JOIN (${WALLETS}) ow ON ow.id = oa.wallet_id
            JOIN eth_activity ia ON ia.id = l.in_activity_id
            JOIN eth_wallets iw ON iw.id = ia.wallet_id
            LEFT JOIN eth_bridge_movements m ON m.id = l.movement_id`,
  },
  eth_bridge_movements: {
    requires: ['eth_bridge_movements'],
    sql: `SELECT to_jsonb(m) - 'user_id' AS row FROM eth_bridge_movements m WHERE m.user_id = $1`,
  },
  eth_bridge_movement_members: {
    requires: ['eth_bridge_movement_members', 'eth_bridge_receipts'],
    sql: `SELECT ${MOVEMENT_KEY('m')} AS movement, w.address AS wallet,
                 r.provider AS receipt_provider, r.decoder_version AS receipt_decoder_version,
                 to_jsonb(mm) AS row
            FROM eth_bridge_movement_members mm
            JOIN eth_bridge_movements m ON m.id = mm.movement_id AND m.user_id = $1
            JOIN eth_wallets w ON w.id = mm.wallet_id
            LEFT JOIN eth_bridge_receipts r ON r.id = mm.receipt_id`,
  },
  eth_bridge_suggestions: {
    requires: ['eth_bridge_suggestions'],
    sql: `SELECT ow.address AS out_wallet, iw.address AS in_wallet, to_jsonb(s) - 'user_id' AS row
            FROM eth_bridge_suggestions s
            JOIN eth_wallets ow ON ow.id = s.out_wallet_id
            JOIN eth_wallets iw ON iw.id = s.in_wallet_id
           WHERE s.user_id = $1`,
  },
  exchange_matches: {
    requires: ['exchange_matches'],
    sql: `SELECT ${RECORD_KEY('er', 'ea')} AS record,
                 CASE WHEN a.id IS NULL THEN NULL ELSE ${ACTIVITY_KEY('a', 'w')} END AS activity,
                 CASE WHEN cr.id IS NULL THEN NULL ELSE ${RECORD_KEY('cr', 'ca')} END AS counter_record,
                 to_jsonb(m) AS row
            FROM exchange_matches m
            JOIN exchange_records er ON er.id = m.exchange_record_id
            JOIN exchange_accounts ea ON ea.id = er.exchange_account_id AND ea.user_id = $1
            LEFT JOIN eth_activity a ON a.id = m.activity_id
            LEFT JOIN eth_wallets w ON w.id = a.wallet_id
            LEFT JOIN exchange_records cr ON cr.id = m.counter_record_id
            LEFT JOIN exchange_accounts ca ON ca.id = cr.exchange_account_id`,
  },
  exchange_match_suggestions: {
    requires: ['exchange_match_suggestions'],
    sql: `SELECT ${RECORD_KEY('er', 'ea')} AS record,
                 CASE WHEN a.id IS NULL THEN NULL ELSE ${ACTIVITY_KEY('a', 'aw')} END AS activity,
                 CASE WHEN cr.id IS NULL THEN NULL ELSE ${RECORD_KEY('cr', 'ca')} END AS counter_record,
                 w.address AS wallet, to_jsonb(s) AS row
            FROM exchange_match_suggestions s
            JOIN exchange_records er ON er.id = s.exchange_record_id
            JOIN exchange_accounts ea ON ea.id = er.exchange_account_id AND ea.user_id = $1
            LEFT JOIN eth_activity a ON a.id = s.activity_id
            LEFT JOIN eth_wallets aw ON aw.id = a.wallet_id
            LEFT JOIN exchange_records cr ON cr.id = s.counter_record_id
            LEFT JOIN exchange_accounts ca ON ca.id = cr.exchange_account_id
            LEFT JOIN eth_wallets w ON w.id = s.wallet_id`,
  },
  exchange_fiat_matches: {
    requires: ['exchange_fiat_matches'],
    sql: `SELECT ${RECORD_KEY('er', 'ea')} AS record,
                 COALESCE(t.plaid_transaction_id, t.date::text || ':' || t.amount::text || ':' || t.name) AS bank_transaction,
                 to_jsonb(f) AS row
            FROM exchange_fiat_matches f
            JOIN exchange_records er ON er.id = f.exchange_record_id
            JOIN exchange_accounts ea ON ea.id = er.exchange_account_id AND ea.user_id = $1
            JOIN transactions t ON t.id = f.transaction_id`,
  },
  eth_reconciliation: {
    requires: ['eth_reconciliation'],
    sql: `SELECT w.address AS wallet, to_jsonb(r) AS row
            FROM eth_reconciliation r JOIN (${WALLETS}) w ON w.id = r.wallet_id`,
  },
  crypto_holdings: {
    requires: ['holdings'],
    sql: `SELECT a.name AS account, to_jsonb(h) AS row
            FROM holdings h JOIN accounts a ON a.id = h.account_id
           WHERE a.user_id = $1
             AND (a.eth_wallet_id IS NOT NULL OR to_jsonb(a)->>'exchange_account_id' IS NOT NULL)`,
  },
  crypto_transaction_mirror: {
    requires: ['transactions', 'eth_transfers'],
    sql: `SELECT a.name AS account,
                 w.address || ':' || t.chain_id || ':' || t.transfer_type || ':' || LOWER(t.tx_hash) || ':' || t.ordinal AS transfer,
                 to_jsonb(tx) AS row
            FROM transactions tx
            JOIN accounts a ON a.id = tx.account_id AND a.user_id = $1
            JOIN eth_transfers t ON t.id = tx.eth_transfer_id
            JOIN eth_wallets w ON w.id = t.wallet_id`,
  },
  eth_transfer_classification: {
    requires: ['eth_transfers'],
    sql: `SELECT w.address || ':' || t.chain_id || ':' || t.transfer_type || ':' || LOWER(t.tx_hash) || ':' || t.ordinal AS transfer,
                 t.counterparty_is_own, t.counterparty_exchange, t.usd_at_time, t.usd_basis
            FROM eth_transfers t JOIN (${WALLETS}) w ON w.id = t.wallet_id`,
  },
};

const DERIVED_TRANSFER_COLUMNS = ['counterparty_is_own', 'counterparty_exchange', 'usd_at_time', 'usd_basis'];

const INPUT_TABLES = {
  eth_wallets: {
    requires: ['eth_wallets'],
    sql: 'SELECT address, label FROM eth_wallets WHERE user_id = $1',
  },
  eth_transfers: {
    requires: ['eth_transfers'],
    sql: `SELECT w.address AS wallet, to_jsonb(t) - $2::text[] AS row
            FROM eth_transfers t JOIN (${WALLETS}) w ON w.id = t.wallet_id`,
    params: [DERIVED_TRANSFER_COLUMNS],
  },
  eth_address_labels_user: {
    requires: ['eth_address_labels'],
    sql: 'SELECT to_jsonb(l) - \'user_id\' AS row FROM eth_address_labels l WHERE l.user_id = $1',
  },
  eth_address_labels_builtin: {
    requires: ['eth_address_labels'],
    sql: 'SELECT to_jsonb(l) AS row FROM eth_address_labels l WHERE l.user_id IS NULL AND $1::int IS NOT NULL',
  },
  eth_activity_overrides: {
    requires: ['eth_activity_overrides'],
    sql: `SELECT w.address AS wallet, to_jsonb(o) AS row
            FROM eth_activity_overrides o JOIN (${WALLETS}) w ON w.id = o.wallet_id`,
  },
  eth_ignored_tokens: {
    requires: ['eth_ignored_tokens'],
    sql: 'SELECT to_jsonb(i) - \'user_id\' AS row FROM eth_ignored_tokens i WHERE i.user_id = $1',
  },
  eth_reconciliation_adjustments: {
    requires: ['eth_reconciliation_adjustments'],
    sql: `SELECT w.address AS wallet, to_jsonb(r) AS row
            FROM eth_reconciliation_adjustments r JOIN (${WALLETS}) w ON w.id = r.wallet_id`,
  },
  exchange_records: {
    requires: ['exchange_records'],
    sql: `SELECT ea.exchange, ea.name AS account, to_jsonb(er) AS row
            FROM exchange_records er
            JOIN exchange_accounts ea ON ea.id = er.exchange_account_id AND ea.user_id = $1`,
  },
  exchange_match_verdicts: {
    requires: ['exchange_match_verdicts'],
    sql: `SELECT ${RECORD_KEY('er', 'ea')} AS record, w.address AS wallet,
                 CASE WHEN cr.id IS NULL THEN NULL ELSE ${RECORD_KEY('cr', 'ca')} END AS counter_record,
                 to_jsonb(v) AS row
            FROM exchange_match_verdicts v
            JOIN exchange_records er ON er.id = v.exchange_record_id
            JOIN exchange_accounts ea ON ea.id = er.exchange_account_id AND ea.user_id = $1
            LEFT JOIN eth_wallets w ON w.id = v.wallet_id
            LEFT JOIN exchange_records cr ON cr.id = v.counter_record_id
            LEFT JOIN exchange_accounts ca ON ca.id = cr.exchange_account_id`,
  },
  eth_bridge_verdicts: {
    requires: ['eth_bridge_verdicts'],
    sql: `SELECT ow.address AS out_wallet, iw.address AS in_wallet, to_jsonb(v) - 'user_id' AS row
            FROM eth_bridge_verdicts v
            JOIN eth_wallets ow ON ow.id = v.out_wallet_id
            JOIN eth_wallets iw ON iw.id = v.in_wallet_id
           WHERE v.user_id = $1`,
  },
};

async function tableExists(client, name) {
  const { rows } = await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${name}`]);
  return rows[0].present;
}

async function digestTables(client, userId, specs, { keepLines = false } = {}) {
  const tables = {};
  for (const [name, spec] of Object.entries(specs)) {
    let present = true;
    for (const required of spec.requires) {
      if (!(await tableExists(client, required))) present = false;
    }
    if (!present) {
      tables[name] = { skipped: 'table missing' };
      continue;
    }
    const { rows } = await client.query(spec.sql, [userId, ...(spec.params || [])]);
    const result = hashRows(rows);
    tables[name] = keepLines ? result : { rows: result.rows, sha256: result.sha256 };
  }
  return tables;
}

function overall(tables) {
  const hash = crypto.createHash('sha256');
  for (const name of Object.keys(tables).sort()) {
    hash.update(`${name}:${tables[name].sha256 || tables[name].skipped}\n`);
  }
  return hash.digest('hex');
}

// Runs inside the caller's transaction; callers wanting a consistent snapshot
// open REPEATABLE READ READ ONLY first.
async function computeDigest(client, userId, options = {}) {
  if (!Number.isInteger(Number(userId)) || Number(userId) <= 0) throw new Error('userId is required');
  const derived = await digestTables(client, Number(userId), DERIVED_TABLES, options);
  const inputs = await digestTables(client, Number(userId), INPUT_TABLES, options);
  return {
    user_id: Number(userId),
    derived_sha256: overall(derived),
    input_sha256: overall(inputs),
    derived,
    inputs,
  };
}

// Names the tables whose hash differs; with keepLines on both sides, also the
// rows only one side has.
function diffDigests(before, after) {
  const out = { derived: {}, inputs: {} };
  for (const section of ['derived', 'inputs']) {
    const names = new Set([...Object.keys(before[section] || {}), ...Object.keys(after[section] || {})]);
    for (const name of [...names].sort()) {
      const a = before[section]?.[name] || {};
      const b = after[section]?.[name] || {};
      if (a.sha256 === b.sha256 && a.skipped === b.skipped) continue;
      const entry = { before_rows: a.rows ?? null, after_rows: b.rows ?? null };
      if (a.lines && b.lines) {
        const left = new Set(a.lines);
        const right = new Set(b.lines);
        entry.only_before = a.lines.filter((line) => !right.has(line));
        entry.only_after = b.lines.filter((line) => !left.has(line));
      }
      out[section][name] = entry;
    }
  }
  return out;
}

module.exports = {
  canonicalize,
  stableStringify,
  hashRows,
  computeDigest,
  diffDigests,
  DERIVED_TABLES,
  INPUT_TABLES,
};
