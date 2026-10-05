#!/usr/bin/env node

'use strict';

// Backfill the implied fiat funding of Coinbase buys and sells that were stored
// before the readers emitted it.
//
// A retail buy paid from a bank or card (or a sale paid out to one) books its
// quote leg against the fiat wallet although the money never touched it, so
// the derived USD balance falls short by every bank-paid purchase and gains
// every bank payout. The readers now emit an implied deposit/withdrawal beside
// such a trade (src/services/exchangeImport/coinbaseFunding.js). Stored rows are
// never rewritten by a re-sync -- the ON CONFLICT upgrade only touches review-
// flagged rows and a Coinbase cursor never re-walks old history -- so this
// script derives the same records from the stored trades with the SAME builder
// and inserts them through ExchangeRecord.bulkInsert. Their ids are the
// readers' ids (`<trade external_id>:funding`), so a later replay from either
// source is a plain duplicate, and re-running this script inserts nothing.
//
// The reconciliation report is recomputed in the insert transaction, exactly as
// a CSV import does, and matching (which rebuilds Plaid fiat links) runs after
// the commit. Dry run unless --apply is explicit; the dry run is read-only and
// classifies each funding record the way bulkInsert would.
//
//   node scripts/backfill-coinbase-implied-funding.js --user-id <id> --account-id <id> [--apply]

// node-pg writes a JS Date in the host's zone and a timestamp-without-time-zone
// column drops the offset, so a laptop run would shift any stored row that
// bulkInsert merges into. The server runs in UTC; pin the script to it too.
process.env.TZ = 'UTC';
require('dotenv').config({ quiet: true });
const pool = require('../src/config/database');
const ExchangeAccount = require('../src/models/ExchangeAccount');
const ExchangeRecord = require('../src/models/ExchangeRecord');
const ExchangeReconciliationService = require('../src/services/ExchangeReconciliationService');
const {
  annotateRecords,
  conflictingDetails,
} = require('../src/services/exchangeImport/canonicalFingerprint');
const {
  impliedFundingRecord,
  payloadSource,
  paymentMethodOf,
  isWalletPaymentMethod,
  retailSide,
} = require('../src/services/exchangeImport/coinbaseFunding');
const { addAmounts, negateAmount, compareAmounts } = require('../src/services/exchangeImport/shared');

const { isDistinctSameSourceEvent } = ExchangeRecord;

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] || null;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

// Why a stored trade gets no funding record. Reported so "nothing to do" can be
// told apart from "could not tell".
function skipReason(row) {
  const side = retailSide(row.raw);
  if (!side) return 'not_a_retail_buy_or_sell';
  const method = paymentMethodOf(row.raw);
  if (!method) return 'payment_method_not_named';
  if (isWalletPaymentMethod(method)) return 'paid_from_wallet';
  return 'legs_contradict_side_or_zero';
}

// Pure: stored trade rows -> annotated funding records plus skip tallies. The
// funding carries the source of the payload it was derived from (see
// coinbaseFunding.payloadSource), which is what lets a later replay from the
// other source merge with it instead of becoming a same-source candidate.
function planFunding(exchange, rows) {
  const fundings = [];
  const skipped = {};
  for (const row of rows) {
    const funding = impliedFundingRecord(row, { source: payloadSource(row) });
    if (funding) {
      fundings.push(funding);
      continue;
    }
    const reason = skipReason(row);
    skipped[reason] = (skipped[reason] || 0) + 1;
  }
  return { fundings: annotateRecords(exchange, fundings), skipped };
}

// The decision bulkInsert would make for each funding record, without writing.
// Mirrors its order: an exact id is a duplicate, an audited incoming id a
// replay, one compatible cross-source fingerprint twin a merge, any other
// fingerprint collision a flagged candidate, otherwise an insert.
function classifyFunding(fundings, existingRows, auditedIds) {
  const byId = new Map(existingRows.map((row) => [row.external_id, row]));
  const byFingerprint = new Map();
  for (const row of existingRows) {
    if (!row.fingerprint) continue;
    byFingerprint.set(row.fingerprint, [...(byFingerprint.get(row.fingerprint) || []), row]);
  }
  const batchByFingerprint = new Map();
  for (const record of fundings) {
    if (!record.fingerprint) continue;
    batchByFingerprint.set(record.fingerprint, [...(batchByFingerprint.get(record.fingerprint) || []), record]);
  }

  return fundings.map((record) => {
    const existing = byId.get(record.external_id);
    if (existing) {
      const same = compareAmounts(String(existing.base_amount), record.base_amount) === 0
        && existing.base_asset === record.base_asset && existing.record_type === record.record_type;
      return { record, decision: same ? 'duplicate' : 'stored_differs', existing_id: existing.id };
    }
    if (auditedIds.has(record.external_id)) return { record, decision: 'replay' };
    const candidates = (byFingerprint.get(record.fingerprint) || [])
      .filter((row) => row.external_id !== record.external_id)
      .filter((row) => !isDistinctSameSourceEvent(row, record));
    const batch = (batchByFingerprint.get(record.fingerprint) || [])
      .filter((row) => row.external_id !== record.external_id)
      .filter((row) => !isDistinctSameSourceEvent(row, record));
    if (candidates.length === 1 && batch.length === 0
        && candidates[0].source && record.source && candidates[0].source !== record.source
        && conflictingDetails(candidates[0], record).length === 0
        && !candidates[0].duplicate_candidate && !candidates[0].needs_review && !record.needs_review) {
      return { record, decision: 'merge', existing_id: candidates[0].id };
    }
    if (candidates.length || batch.length) {
      return {
        record,
        decision: 'candidate',
        candidate_ids: candidates.map((row) => row.id),
        batch_ids: batch.map((row) => row.external_id),
      };
    }
    return { record, decision: 'insert' };
  });
}

// Records that land as rows change the derived balance; merges and replays do not.
function balanceEffect(decisions) {
  const effect = {};
  for (const { record, decision } of decisions) {
    if (decision !== 'insert' && decision !== 'candidate') continue;
    effect[record.base_asset] = addAmounts(effect[record.base_asset] ?? '0', record.base_amount);
  }
  return effect;
}

async function loadAccount(client, accountId, userId) {
  const result = await client.query(
    `SELECT id, user_id, name, exchange, provider_balance_snapshot,
            (sync_lock_token IS NOT NULL AND sync_lock_until > CURRENT_TIMESTAMP) AS sync_in_progress
     FROM exchange_accounts
     WHERE id = $1 AND user_id = $2`,
    [accountId, userId]
  );
  const account = result.rows[0];
  if (!account) throw new Error(`Exchange account ${accountId} does not belong to user ${userId}`);
  if (account.exchange !== 'coinbase') {
    throw new Error(`Exchange account ${accountId} is ${account.exchange}, not coinbase`);
  }
  return account;
}

async function loadTrades(client, accountId, userId) {
  const result = await client.query(
    `SELECT er.*
     FROM exchange_records er
     JOIN exchange_accounts ea ON ea.id = er.exchange_account_id
     WHERE er.exchange_account_id = $1 AND ea.user_id = $2
       AND er.record_type = 'trade'
       AND er.raw->>'_format' IN ('coinbase', 'coinbase_retail')
     ORDER BY er.occurred_at, er.id`,
    [accountId, userId]
  );
  return result.rows;
}

async function preview(client, accountId, fundings) {
  const existing = await client.query(
    `SELECT er.*
     FROM exchange_records er
     WHERE er.exchange_account_id = $1
       AND (er.external_id = ANY($2::text[]) OR er.fingerprint = ANY($3::text[]))`,
    [accountId, fundings.map((record) => record.external_id),
      fundings.map((record) => record.fingerprint).filter(Boolean)]
  );
  const audited = await client.query(
    `SELECT incoming_external_id
     FROM exchange_record_dedupe_events
     WHERE exchange_account_id = $1 AND incoming_external_id = ANY($2::text[])`,
    [accountId, fundings.map((record) => record.external_id)]
  );
  return classifyFunding(fundings, existing.rows,
    new Set(audited.rows.map((row) => row.incoming_external_id)));
}

function balanceSummary(derived, effect, snapshot) {
  const live = snapshot?.balances || {};
  return Object.fromEntries(Object.keys(effect).sort().map((asset) => {
    const before = derived[asset] ?? '0';
    const after = addAmounts(before, effect[asset]);
    const liveValue = live[asset] ?? null;
    return [asset, {
      derived_before: before,
      change: effect[asset],
      derived_after: after,
      live: liveValue,
      delta_before: liveValue === null ? null : addAmounts(before, negateAmount(String(liveValue))),
      delta_after: liveValue === null ? null : addAmounts(after, negateAmount(String(liveValue))),
    }];
  }));
}

function tally(decisions) {
  const counts = {};
  for (const { decision } of decisions) counts[decision] = (counts[decision] || 0) + 1;
  return counts;
}

async function run({ userId, accountId, apply }) {
  const client = await pool.connect();
  let plan;
  let decisions;
  let account;
  let derived;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    account = await loadAccount(client, accountId, userId);
    const trades = await loadTrades(client, accountId, userId);
    plan = planFunding(account.exchange, trades);
    plan.trades = trades.length;
    decisions = await preview(client, accountId, plan.fundings);
    derived = await ExchangeRecord.derivedBalances(accountId, userId, { client });
    await client.query('ROLLBACK');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) { void rollbackError; }
    throw error;
  } finally {
    client.release();
  }

  const report = {
    apply,
    user_id: userId,
    exchange_account: { id: account.id, name: account.name, exchange: account.exchange },
    counts: {
      stored_trades: plan.trades,
      funding_records: plan.fundings.length,
      deposits: plan.fundings.filter((record) => record.record_type === 'deposit').length,
      withdrawals: plan.fundings.filter((record) => record.record_type === 'withdrawal').length,
      by_source: plan.fundings.reduce((counts, record) => ({
        ...counts, [record.source || 'none']: (counts[record.source || 'none'] || 0) + 1,
      }), {}),
      decisions: tally(decisions),
    },
    skipped_trades: plan.skipped,
    by_payment_method: plan.fundings.reduce((methods, record) => {
      const name = record.raw.payment_method_name;
      const entry = methods[name] || { records: 0, net: {} };
      entry.records += 1;
      entry.net[record.base_asset] = addAmounts(entry.net[record.base_asset] ?? '0', record.base_amount);
      return { ...methods, [name]: entry };
    }, {}),
    balance_effect: balanceSummary(derived, balanceEffect(decisions), account.provider_balance_snapshot),
    attention: decisions
      .filter(({ decision }) => decision !== 'insert' && decision !== 'duplicate')
      .map(({ record, decision, existing_id: existingId, candidate_ids: candidateIds, batch_ids: batchIds }) => ({
        external_id: record.external_id,
        decision,
        occurred_at: record.occurred_at,
        asset: record.base_asset,
        amount: record.base_amount,
        ...(existingId ? { existing_id: existingId } : {}),
        ...(candidateIds ? { candidate_ids: candidateIds } : {}),
        ...(batchIds?.length ? { batch_ids: batchIds } : {}),
      })),
  };

  if (!apply) return report;
  if (account.sync_in_progress) throw new Error(`A sync for exchange account ${accountId} is running; retry after it finishes`);

  // Re-planned under the account lock: the dry-run plan above is advisory and
  // the stored trades may have changed since it was read.
  const stored = await ExchangeAccount.withImportTransaction(accountId, userId, async (lockedClient, locked) => {
    const trades = await loadTrades(lockedClient, accountId, userId);
    const { fundings } = planFunding(locked.exchange, trades);
    const result = await ExchangeRecord.bulkInsert(accountId, fundings, { client: lockedClient });
    const reconciliation = await ExchangeReconciliationService.recomputeForAccount(
      userId, accountId, { client: lockedClient, account: locked }
    );
    return { result, reconciliation };
  });

  // Loaded only on --apply: matching pulls in the activity stack, which a dry
  // run never needs.
  const ExchangeMatchService = require('../src/services/ExchangeMatchService');
  const TransactionClassificationService = require('../src/services/TransactionClassificationService');
  const matches = await ExchangeMatchService.rebuildForUserSafely(userId, { exchangeAccountId: accountId });
  await TransactionClassificationService.backfillForUser(userId);

  return {
    ...report,
    applied: {
      ...stored.result,
      reconciliation_status: stored.reconciliation.status,
      mismatch_count: stored.reconciliation.report?.mismatch_count ?? null,
      matched: matches?.matches ?? null,
      fiat_links: matches?.fiat ?? null,
    },
  };
}

async function main() {
  const userId = positiveInteger(option('--user-id'), '--user-id');
  const accountId = positiveInteger(option('--account-id'), '--account-id');
  const apply = process.argv.includes('--apply');
  const report = await run({ userId, accountId, apply });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(`Coinbase implied funding backfill failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(() => pool.end().catch(() => {}));
}

module.exports = { planFunding, classifyFunding, balanceEffect, skipReason };
