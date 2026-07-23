'use strict';

const pool = require('../config/database');
const RecurringExpense = require('../models/RecurringExpense');
const IgnoredMerchant = require('../models/IgnoredMerchant');
const { SPEND_ELIGIBILITY_SQL } = require('../utils/spendFilters');
const logger = require('../config/logger');

const GROUP_WINDOW_DAYS = 400;
const DERIVE_WINDOW_DAYS = 183;
const AVG_WINDOW_DAYS = 92;
const MIN_CHARGES = 3;
const MIN_SPAN_DAYS = 60;
const FIXED_STDDEV_DOLLARS = 5;
const MONTHLY_MIN_DAYS = 20;
const MONTHLY_MAX_DAYS = 45;
// Auto-create requires the inter-charge gaps to be consistent, not just a
// median in the monthly band -- this separates real subscriptions ("billed
// on the 2nd every month") from routine discretionary spend a user happens
// to make roughly monthly (a liquor store, a favorite restaurant).
const GAP_TOLERANCE_DAYS = 7;
// Income is never an expense. Installment loans (mortgage, auto, personal)
// stay -- their payment is the only record of that obligation. Credit-card
// payments are already gone before this point: SPEND_ELIGIBILITY_SQL drops
// them from fetchEligibleCharges, and isCreditCardPayment re-checks the
// survivors below.
const AUTO_CREATE_EXCLUDED = new Set(['INCOME']);
// Generic tokens dropped when matching a payment merchant to a card account,
// so "Chase"/"Discover" identify the issuer but "card"/"visa" don't overmatch.
const CARD_TOKEN_STOPLIST = new Set([
  'card', 'cards', 'credit', 'visa', 'mastercard', 'amex', 'debit',
  'bank', 'account', 'payment', 'payments', 'autopay', 'the',
]);

const DAY_MS = 24 * 60 * 60 * 1000;

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function tokens(value) {
  return String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / DAY_MS);
}

// Score how likely an expense row and a transaction merchant group are the
// same obligation. Strong text matches win regardless of amount (the manual
// cost may simply be wrong); weaker text evidence needs amount agreement.
function scoreMatch(expense, group) {
  const cost = Number(expense.cost) || 0;
  const gap = Math.abs(cost - group.avgAmount) / Math.max(cost, group.avgAmount, 1);
  const expNorms = [normalize(expense.name), normalize(expense.company)].filter((s) => s.length >= 4);
  const merchNorm = normalize(group.merchantKey);
  const expTokens = new Set([...tokens(expense.name), ...tokens(expense.company)]);
  const merchTokens = tokens(group.merchantKey);
  const catTokens = tokens(String(group.category || '').replace(/_/g, ' '));

  if (expNorms.includes(merchNorm)) return 3;
  const contains = expNorms.some((n) =>
    (merchNorm.length >= 5 && n.includes(merchNorm)) || (n.length >= 5 && merchNorm.includes(n)));
  if (contains) return 2.5;

  const overlap = merchTokens.filter((t) => expTokens.has(t)).length;
  if (overlap > 0 && gap <= 0.3) return 1.5 + overlap * 0.1 - gap;

  const catOverlap = catTokens.filter((t) => expTokens.has(t)).length;
  if (catOverlap > 0 && gap <= 0.1) return 0.5 - gap;
  return null;
}

// Greedy best-score assignment; each expense and each group link at most once.
function matchExpenses(expenses, groups) {
  const candidates = [];
  for (const expense of expenses) {
    for (const group of groups) {
      const score = scoreMatch(expense, group);
      if (score !== null) candidates.push({ expense, group, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const usedExpenses = new Set();
  const usedGroups = new Set();
  const links = [];
  for (const { expense, group, score } of candidates) {
    if (usedExpenses.has(expense.id) || usedGroups.has(group.merchantKey)) continue;
    usedExpenses.add(expense.id);
    usedGroups.add(group.merchantKey);
    links.push({ expenseId: expense.id, expenseName: expense.name, merchantKey: group.merchantKey, score });
  }
  return links;
}

// Derive expense fields from a merchant's charges (asc by date) within the
// derivation window. Low amount variance means a fixed rate billed at the
// latest amount; otherwise cost is the recent average.
function deriveFields(charges, today) {
  const recent = charges.filter((c) => daysBetween(c.date, today) <= DERIVE_WINDOW_DAYS);
  if (!recent.length) return null;
  const amounts = recent.map((c) => c.amount);
  const sd = stddev(amounts);
  const isFixed = sd < FIXED_STDDEV_DOLLARS;
  const last = recent[recent.length - 1];
  const avgWindow = recent.filter((c) => daysBetween(c.date, today) <= AVG_WINDOW_DAYS);
  const avgSource = avgWindow.length ? avgWindow : recent;
  const avg = avgSource.reduce((s, c) => s + c.amount, 0) / avgSource.length;
  const gaps = [];
  for (let i = 1; i < recent.length; i++) gaps.push(daysBetween(recent[i - 1].date, recent[i].date));
  const intervalDays = gaps.length ? Math.round(median(gaps)) : null;
  // Regular = every gap is within tolerance of the median. Needs >=2 gaps to
  // be meaningful; consumed only by the auto-create gate, not by refresh.
  const intervalRegular = gaps.length >= 2
    && gaps.every((g) => Math.abs(g - intervalDays) <= GAP_TOLERANCE_DAYS);
  return {
    cost: Math.round((isFixed ? last.amount : avg) * 100) / 100,
    isFixed,
    dueDay: Math.round(median(recent.map((c) => new Date(c.date).getUTCDate()))),
    intervalDays,
    intervalRegular,
    lastChargeDate: last.date,
    accountId: last.account_id,
    company: last.merchant_name || null,
    payAccount: last.account_display || last.account_name || null,
  };
}

function isMonthlyCadence(intervalDays) {
  return intervalDays !== null && intervalDays >= MONTHLY_MIN_DAYS && intervalDays <= MONTHLY_MAX_DAYS;
}

// Distinctive name tokens of the user's tracked credit-card accounts (e.g.
// "chase", "discover"), used to recognize a payment TO one of those cards.
async function fetchCreditCardTokens() {
  const result = await pool.query(
    "SELECT name FROM accounts WHERE type = 'credit' AND is_hidden = FALSE"
  );
  const set = new Set();
  for (const row of result.rows) {
    for (const token of tokens(row.name)) {
      if (!CARD_TOKEN_STOPLIST.has(token)) set.add(token);
    }
  }
  return set;
}

// A credit-card payment double-counts (the card's purchases are already
// tracked), so it must not become a recurring expense. Installment loans
// (Lightstream, mortgage) share the LOAN_PAYMENTS category but match no card
// account, so they are correctly kept.
//
// NOT redundant with SPEND_ELIGIBILITY_SQL, which excludes card payments by
// Plaid's detailed category: this catches rows Plaid never enriched, whose
// detailed category is NULL. It guards auto-creation only -- Top Merchants and
// the charge list have no equivalent backstop, so an unenriched card payment
// can still rank there.
function isCreditCardPayment(group, cardTokens) {
  if (!String(group.category || '').toUpperCase().includes('LOAN_PAYMENT')) return false;
  return tokens(group.merchantKey).some((token) => cardTokens.has(token));
}

function buildGroups(rows) {
  const byKey = new Map();
  for (const row of rows) {
    if (!byKey.has(row.merchant_key)) byKey.set(row.merchant_key, []);
    byKey.get(row.merchant_key).push(row);
  }
  const groups = [];
  for (const [merchantKey, charges] of byKey) {
    if (charges.length < MIN_CHARGES) continue;
    const span = daysBetween(charges[0].date, charges[charges.length - 1].date);
    if (span <= MIN_SPAN_DAYS) continue;
    const amounts = charges.map((c) => c.amount);
    groups.push({
      merchantKey,
      charges,
      count: charges.length,
      avgAmount: amounts.reduce((s, v) => s + v, 0) / amounts.length,
      sd: stddev(amounts),
      category: charges[charges.length - 1].category || null,
    });
  }
  return groups;
}

async function fetchEligibleCharges() {
  const result = await pool.query(`
    SELECT t.date::text AS date, t.amount::float8 AS amount, t.account_id,
           t.merchant_name, t.category,
           COALESCE(t.merchant_name, t.name) AS merchant_key,
           a.display_name AS account_display, a.name AS account_name
    FROM transactions t
    JOIN accounts a ON t.account_id = a.id
    WHERE ${SPEND_ELIGIBILITY_SQL}
      AND t.date >= CURRENT_DATE - make_interval(days => $1)
    ORDER BY t.date ASC
  `, [GROUP_WINDOW_DAYS]);
  return result.rows;
}

async function run() {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await fetchEligibleCharges();
  const groups = buildGroups(rows);
  const groupByKey = new Map(groups.map((g) => [g.merchantKey, g]));
  const linkable = await RecurringExpense.findAll();

  const usedKeys = new Set(linkable.map((e) => e.merchant_key).filter(Boolean));
  const links = matchExpenses(
    linkable.filter((e) => !e.merchant_key),
    groups.filter((g) => !usedKeys.has(g.merchantKey))
  );
  for (const link of links) {
    await RecurringExpense.setMerchantKey(link.expenseId, link.merchantKey);
    usedKeys.add(link.merchantKey);
  }

  const refreshed = [];
  for (const expense of linkable) {
    const merchantKey = expense.merchant_key
      || (links.find((l) => l.expenseId === expense.id) || {}).merchantKey;
    const group = merchantKey ? groupByKey.get(merchantKey) : null;
    if (!group) continue;
    const derived = deriveFields(group.charges, today);
    if (!derived) continue;
    await RecurringExpense.updateDerived(expense.id, {
      cost: derived.cost,
      is_fixed_rate: derived.isFixed,
      pay_account: derived.payAccount,
      company: derived.company || merchantKey,
      account_id: derived.accountId,
      due_day: derived.dueDay,
      last_charge_date: derived.lastChargeDate,
      // A single charge inside the derive window yields no gaps and so no
      // cadence. Passing that null through would erase a cadence earlier runs
      // established, and findAll's COALESCE(..., 30) would silently reset the
      // stale/drop clock. undefined leaves the column alone.
      charge_interval_days: derived.intervalDays ?? undefined,
    });
    if (Math.abs(Number(expense.cost) - derived.cost) > 0.005) {
      await RecurringExpense.appendHistory(expense.id, derived.cost);
    }
    refreshed.push({ id: expense.id, name: expense.name, merchantKey, cost: derived.cost });
  }

  const created = [];
  const skipped = [];
  const ignoredKeys = await IgnoredMerchant.allKeys('expenses');
  const cardTokens = await fetchCreditCardTokens();
  for (const group of groups) {
    if (usedKeys.has(group.merchantKey)) continue;
    if (ignoredKeys.has(group.merchantKey)) {
      skipped.push({ merchantKey: group.merchantKey, reason: 'ignored by user' });
      continue;
    }
    if (AUTO_CREATE_EXCLUDED.has(group.category)) {
      skipped.push({ merchantKey: group.merchantKey, reason: `excluded category ${group.category}` });
      continue;
    }
    if (isCreditCardPayment(group, cardTokens)) {
      skipped.push({ merchantKey: group.merchantKey, reason: 'credit-card payment (double-counts card spend)' });
      continue;
    }
    // Recurrence test: a monthly-band cadence AND regular gaps (variable
    // amounts are fine, so utilities and loan autopays still qualify).
    const derived = deriveFields(group.charges, today);
    if (!derived || !isMonthlyCadence(derived.intervalDays) || !derived.intervalRegular) continue;
    const row = await RecurringExpense.createAutoTracked({
      name: group.merchantKey,
      cost: derived.cost,
      is_fixed_rate: derived.isFixed,
      pay_account: derived.payAccount,
      company: derived.company || group.merchantKey,
      merchant_key: group.merchantKey,
      account_id: derived.accountId,
      due_day: derived.dueDay,
      last_charge_date: derived.lastChargeDate,
      charge_interval_days: derived.intervalDays,
    });
    // A concurrent run won the insert; skip without double-recording.
    if (!row) continue;
    await RecurringExpense.appendHistory(row.id, derived.cost);
    usedKeys.add(group.merchantKey);
    created.push({ id: row.id, name: group.merchantKey, cost: derived.cost });
  }

  const summary = { matched: links, refreshed, created, skipped, groupCount: groups.length };
  logger.info({ ...summary, refreshed: refreshed.length }, 'Expense sync completed');
  return summary;
}

module.exports = {
  run,
  // exported for tests
  normalize,
  tokens,
  median,
  stddev,
  scoreMatch,
  matchExpenses,
  deriveFields,
  isMonthlyCadence,
  isCreditCardPayment,
  buildGroups,
};
