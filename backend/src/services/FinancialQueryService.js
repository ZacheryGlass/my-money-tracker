'use strict';

const pool = require('../config/database');
const DashboardService = require('./DashboardService');
const Holding = require('../models/Holding');
const SalaryHistory = require('../models/SalaryHistory');
const RecurringExpense = require('../models/RecurringExpense');
const {
  calculateReturns,
  correlationAndBeta,
  futureValue,
  percentChange,
  riskMetrics,
  round,
  summarizeSeries,
  timeWeightedReturn,
  toNumber,
  xirr,
} = require('../utils/financialMath');

const LIABILITY_TYPES = new Set(['credit', 'loan']);
const LIQUID_TYPES = new Set(['depository']);
const DEFAULT_TRANSACTION_DAYS = 90;
const MAX_ANALYSIS_ROWS = 25000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;

function isoDate(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

function defaultStartDate(days = DEFAULT_TRANSACTION_DAYS) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function clampLimit(limit, fallback = DEFAULT_PAGE_SIZE) {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, parsed));
}

function selectColumns(records, requestedColumns, allowedColumns) {
  if (!requestedColumns?.length) return { columns: allowedColumns, records };
  const columns = requestedColumns.filter((column) => allowedColumns.includes(column));
  if (!columns.length) throw new Error('No valid columns were requested.');
  return {
    columns,
    records: records.map((record) => Object.fromEntries(columns.map((column) => [column, record[column]]))),
  };
}

function normalizeAccountIds(accountIds) {
  if (!Array.isArray(accountIds)) return [];
  return accountIds.map((id) => Number.parseInt(id, 10)).filter((id) => Number.isInteger(id) && id > 0);
}

function transactionDirection(row) {
  if (row.direction) return row.direction;
  return toNumber(row.amount) > 0 ? 'spending' : 'income';
}

function normalizedTransaction(row) {
  const direction = transactionDirection(row);
  return {
    id: row.id,
    date: isoDate(row.date),
    accountId: row.account_id,
    accountName: row.account_name,
    name: row.name,
    merchant: row.merchant_name || row.name,
    amount: round(Math.abs(toNumber(row.amount))),
    sourceAmount: round(toNumber(row.amount)),
    currency: row.currency_code || 'USD',
    category: row.normalized_category || row.category || 'Uncategorized',
    direction,
    pending: Boolean(row.pending),
    isInternalTransfer: Boolean(row.is_internal_transfer || direction === 'internal_transfer'),
    isRefund: Boolean(row.is_refund || direction === 'refund'),
    isReimbursement: Boolean(row.is_reimbursement || direction === 'reimbursement'),
    isEssential: row.is_essential === null ? null : Boolean(row.is_essential),
    isOneTime: Boolean(row.is_one_time),
    hasSemanticClassification: Boolean(row.classification_transaction_id),
  };
}

function summarizeTransactions(rows) {
  const normalized = rows.map(normalizedTransaction);
  const spendingRows = normalized.filter((row) => row.direction === 'spending');
  const incomeRows = normalized.filter((row) => row.direction === 'income');
  const spending = spendingRows.reduce((sum, row) => sum + row.amount, 0);
  const income = incomeRows.reduce((sum, row) => sum + row.amount, 0);
  const essentialSpending = spendingRows
    .filter((row) => row.isEssential === true)
    .reduce((sum, row) => sum + row.amount, 0);
  const classifiedEssentialCount = spendingRows.filter((row) => row.isEssential !== null).length;

  return {
    transactionCount: normalized.length,
    spending: round(spending),
    income: round(income),
    netCashFlow: round(income - spending),
    savingsRatePercent: income > 0 ? round(((income - spending) / income) * 100, 4) : null,
    essentialSpending: classifiedEssentialCount ? round(essentialSpending) : null,
    discretionarySpending: classifiedEssentialCount ? round(spending - essentialSpending) : null,
    classificationCoveragePercent: normalized.length
      ? round((normalized.filter((row) => row.hasSemanticClassification).length / normalized.length) * 100, 2)
      : 100,
  };
}

function periodKey(dateString, interval) {
  const date = new Date(`${dateString}T00:00:00Z`);
  if (interval === 'day') return dateString;
  if (interval === 'year') return `${date.getUTCFullYear()}-01-01`;
  if (interval === 'quarter') {
    const month = Math.floor(date.getUTCMonth() / 3) * 3;
    return `${date.getUTCFullYear()}-${String(month + 1).padStart(2, '0')}-01`;
  }
  if (interval === 'week') {
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() - day + 1);
    return date.toISOString().slice(0, 10);
  }
  return `${dateString.slice(0, 7)}-01`;
}

function groupTransactions(rows, groupBy) {
  const groups = new Map();
  for (const row of rows.map(normalizedTransaction)) {
    let key;
    if (groupBy === 'merchant') key = row.merchant;
    else if (groupBy === 'account') key = row.accountName;
    else if (groupBy === 'direction') key = row.direction;
    else if (['day', 'week', 'month', 'quarter', 'year'].includes(groupBy)) key = periodKey(row.date, groupBy);
    else key = row.category;

    const current = groups.get(key) || { key, count: 0, spending: 0, income: 0 };
    current.count += 1;
    if (row.direction === 'spending') current.spending += row.amount;
    if (row.direction === 'income') current.income += row.amount;
    groups.set(key, current);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      spending: round(group.spending),
      income: round(group.income),
      netCashFlow: round(group.income - group.spending),
    }))
    .sort((a, b) => Math.max(b.spending, b.income) - Math.max(a.spending, a.income));
}

function recurringCandidates(rows) {
  const merchantGroups = new Map();
  for (const row of rows.map(normalizedTransaction).filter((item) => item.direction === 'spending')) {
    const group = merchantGroups.get(row.merchant) || [];
    group.push(row);
    merchantGroups.set(row.merchant, group);
  }

  const candidates = [];
  for (const [merchant, items] of merchantGroups.entries()) {
    if (items.length < 3) continue;
    const amounts = items.map((item) => item.amount);
    const average = amounts.reduce((sum, amount) => sum + amount, 0) / amounts.length;
    const variance = amounts.reduce((sum, amount) => sum + ((amount - average) ** 2), 0) / amounts.length;
    const sortedDates = items.map((item) => item.date).sort();
    const spanDays = (new Date(sortedDates.at(-1)) - new Date(sortedDates[0])) / (24 * 60 * 60 * 1000);
    if (Math.sqrt(variance) <= Math.max(5, average * 0.1) && spanDays >= 45) {
      candidates.push({
        merchant,
        occurrenceCount: items.length,
        averageAmount: round(average),
        firstCharge: sortedDates[0],
        lastCharge: sortedDates.at(-1),
        category: items.at(-1).category,
      });
    }
  }
  return candidates.sort((a, b) => b.averageAmount - a.averageAmount);
}

function toolMeta(extra = {}) {
  return {
    currency: 'USD',
    timezone: process.env.APP_TIMEZONE || 'America/Chicago',
    generatedAt: new Date().toISOString(),
    ...extra,
  };
}

class FinancialQueryService {
  static async getContext({ includeHidden = false } = {}) {
    const hiddenFilter = includeHidden ? '' : 'WHERE is_hidden = FALSE';
    const [accounts, snapshotRange, transactionRange, semanticCounts] = await Promise.all([
      pool.query(
        `SELECT id, COALESCE(NULLIF(TRIM(display_name), ''), name) AS name,
                type, is_hidden
         FROM accounts ${hiddenFilter}
         ORDER BY type, name`
      ),
      pool.query(
        `SELECT MIN(snapshot_date) AS earliest, MAX(snapshot_date) AS latest,
                COUNT(DISTINCT snapshot_date)::int AS dates
         FROM account_snapshots`
      ),
      pool.query(
        `SELECT MIN(t.date) AS earliest, MAX(t.date) AS latest, COUNT(*)::int AS records
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         ${includeHidden ? '' : 'WHERE a.is_hidden = FALSE'}`
      ),
      pool.query(
        `SELECT
          (SELECT COUNT(*)::int FROM investment_cash_flows) AS investment_cash_flows,
          (SELECT COUNT(*)::int FROM benchmark_prices) AS benchmark_prices,
          (SELECT COUNT(*)::int FROM tax_lots) AS tax_lots,
          (SELECT COUNT(*)::int FROM debt_terms) AS debt_terms,
          (SELECT COUNT(*)::int FROM transaction_classifications) AS transaction_classifications`
      ),
    ]);

    return {
      meta: toolMeta(),
      accounts: accounts.rows.map((row) => ({ ...row, is_hidden: Boolean(row.is_hidden) })),
      coverage: {
        snapshots: {
          earliest: isoDate(snapshotRange.rows[0]?.earliest),
          latest: isoDate(snapshotRange.rows[0]?.latest),
          dates: snapshotRange.rows[0]?.dates || 0,
        },
        transactions: {
          earliest: isoDate(transactionRange.rows[0]?.earliest),
          latest: isoDate(transactionRange.rows[0]?.latest),
          records: transactionRange.rows[0]?.records || 0,
        },
        semanticData: semanticCounts.rows[0],
      },
      supportedMetrics: [
        'net_worth', 'total_assets', 'total_liabilities', 'account_value', 'holding_value',
        'spending', 'income', 'net_cash_flow', 'savings_rate', 'salary',
        'total_compensation', 'recurring_commitments',
      ],
      supportedDimensions: [
        'account', 'account_type', 'ticker', 'asset_class', 'category', 'merchant',
        'direction', 'essential', 'recurring', 'day', 'month', 'year',
      ],
      definitions: {
        netWorth: 'Total visible assets minus the absolute value of visible credit and loan liabilities.',
        balanceChange: 'Ending balance minus starting balance. It is not investment return when external cash flows exist.',
        timeWeightedReturn: 'Chain-linked return with external flows removed from each valuation period.',
        moneyWeightedReturn: 'Annualized XIRR using dated external flows and ending value.',
        transactionSigns: 'MCP output normalizes amounts to positive values and exposes direction separately.',
      },
    };
  }

  static async getOverview({ asOf = null, includeHidden = false } = {}) {
    if (!asOf) {
      const portfolio = await DashboardService.getCurrentPortfolio();
      const accounts = new Map();
      for (const item of portfolio.items) {
        const current = accounts.get(item.account_id) || {
          accountId: item.account_id,
          accountName: item.account,
          accountType: item.account_type,
          value: 0,
        };
        current.value += toNumber(item.value);
        accounts.set(item.account_id, current);
      }
      return {
        meta: toolMeta({ dataAsOf: new Date().toISOString().slice(0, 10), valuation: 'live' }),
        summary: {
          totalAssets: round(portfolio.summary.totalAssets),
          totalLiabilities: round(portfolio.summary.totalLiabilities),
          netWorth: round(portfolio.summary.netWorth),
        },
        accounts: [...accounts.values()]
          .map((account) => ({ ...account, value: round(account.value) }))
          .sort((a, b) => Math.abs(b.value) - Math.abs(a.value)),
        freshness: portfolio.freshness,
      };
    }

    const params = [asOf];
    const hiddenFilter = includeHidden ? '' : 'AND a.is_hidden = FALSE';
    const result = await pool.query(
      `SELECT DISTINCT ON (a.id)
              a.id AS account_id,
              COALESCE(NULLIF(TRIM(a.display_name), ''), a.name) AS account_name,
              a.type AS account_type,
              acs.snapshot_date,
              acs.total_value
       FROM accounts a
       JOIN account_snapshots acs ON acs.account_id = a.id
       WHERE acs.snapshot_date <= $1 ${hiddenFilter}
       ORDER BY a.id, acs.snapshot_date DESC`,
      params
    );
    const accounts = result.rows.map((row) => ({
      accountId: row.account_id,
      accountName: row.account_name,
      accountType: row.account_type,
      value: round(toNumber(row.total_value)),
      snapshotDate: isoDate(row.snapshot_date),
    }));
    const totalAssets = accounts
      .filter((account) => !LIABILITY_TYPES.has(account.accountType))
      .reduce((sum, account) => sum + account.value, 0);
    const totalLiabilities = accounts
      .filter((account) => LIABILITY_TYPES.has(account.accountType))
      .reduce((sum, account) => sum + Math.abs(account.value), 0);

    return {
      meta: toolMeta({ dataAsOf: asOf, valuation: 'latest_snapshot_on_or_before_date' }),
      summary: {
        totalAssets: round(totalAssets),
        totalLiabilities: round(totalLiabilities),
        netWorth: round(totalAssets - totalLiabilities),
      },
      accounts: accounts.sort((a, b) => Math.abs(b.value) - Math.abs(a.value)),
      warnings: accounts.some((account) => account.snapshotDate !== asOf)
        ? ['At least one account uses its latest snapshot before the requested date.']
        : [],
    };
  }

  static async queryPositions(options = {}) {
    const {
      asOf = null,
      includeHidden = false,
      ticker = null,
      text = null,
      accountTypes = [],
      categories = [],
      accountIds = [],
      groupBy = 'none',
      limit = DEFAULT_PAGE_SIZE,
      offset = 0,
    } = options;
    let rows;

    if (asOf) {
      const result = await pool.query(
        `SELECT DISTINCT ON (ts.account_id, COALESCE(ts.ticker, ts.name))
                ts.account_id, ts.ticker, ts.name, ts.value AS current_value,
                ts.snapshot_date,
                COALESCE(NULLIF(TRIM(a.display_name), ''), a.name) AS account_name,
                a.type AS account_type,
                NULL::varchar AS category, NULL::varchar AS location
         FROM ticker_snapshots ts
         JOIN accounts a ON a.id = ts.account_id
         WHERE ts.snapshot_date <= $1 ${includeHidden ? '' : 'AND a.is_hidden = FALSE'}
         ORDER BY ts.account_id, COALESCE(ts.ticker, ts.name), ts.snapshot_date DESC`,
        [asOf]
      );
      rows = result.rows;
    } else {
      rows = await Holding.findAll({ includeHidden });
    }

    const accountIdSet = new Set(normalizeAccountIds(accountIds));
    const accountTypeSet = new Set(accountTypes);
    const categorySet = new Set(categories);
    const normalizedTicker = ticker?.trim().toUpperCase();
    const search = text?.trim().toLowerCase();
    const filtered = rows
      .filter((row) => !accountIdSet.size || accountIdSet.has(row.account_id))
      .filter((row) => !accountTypeSet.size || accountTypeSet.has(row.account_type))
      .filter((row) => !categorySet.size || categorySet.has(row.category || 'Uncategorized'))
      .filter((row) => !normalizedTicker || row.ticker?.toUpperCase() === normalizedTicker)
      .filter((row) => !search || `${row.name} ${row.ticker || ''} ${row.account_name}`.toLowerCase().includes(search))
      .map((row) => ({
        id: row.id || null,
        accountId: row.account_id,
        accountName: row.account_name,
        accountType: row.account_type,
        ticker: row.ticker || null,
        name: row.name,
        category: row.category || 'Uncategorized',
        location: row.location || null,
        value: round(toNumber(row.current_value)),
        snapshotDate: isoDate(row.snapshot_date),
      }))
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    const totalValue = filtered.reduce((sum, row) => sum + row.value, 0);

    if (groupBy !== 'none') {
      const groups = new Map();
      for (const position of filtered) {
        const keyMap = {
          account: position.accountName,
          account_type: position.accountType,
          ticker: position.ticker || position.name,
          category: position.category,
          location: position.location || 'Unknown',
        };
        const key = keyMap[groupBy] || 'Unknown';
        const group = groups.get(key) || { key, value: 0, positionCount: 0 };
        group.value += position.value;
        group.positionCount += 1;
        groups.set(key, group);
      }
      return {
        meta: toolMeta({ dataAsOf: asOf || new Date().toISOString().slice(0, 10), groupBy }),
        summary: { totalValue: round(totalValue), positionCount: filtered.length },
        groups: [...groups.values()]
          .map((group) => ({
            ...group,
            value: round(group.value),
            sharePercent: totalValue ? round((group.value / totalValue) * 100, 4) : null,
          }))
          .sort((a, b) => Math.abs(b.value) - Math.abs(a.value)),
      };
    }

    const pageLimit = clampLimit(limit);
    const pageOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
    return {
      meta: toolMeta({ dataAsOf: asOf || new Date().toISOString().slice(0, 10) }),
      summary: { totalValue: round(totalValue), positionCount: filtered.length },
      positions: filtered.slice(pageOffset, pageOffset + pageLimit),
      pagination: {
        total: filtered.length,
        limit: pageLimit,
        offset: pageOffset,
        nextOffset: pageOffset + pageLimit < filtered.length ? pageOffset + pageLimit : null,
      },
    };
  }

  static buildTransactionQuery(options = {}) {
    const conditions = [];
    const params = [];
    const add = (condition, value) => {
      params.push(value);
      conditions.push(condition.replace('?', `$${params.length}`));
    };

    add('t.date >= ?', options.startDate || defaultStartDate());
    if (options.endDate) add('t.date <= ?', options.endDate);
    if (!options.includeHidden) conditions.push('a.is_hidden = FALSE');
    if (!options.includePending) conditions.push('t.pending = FALSE');
    const accountIds = normalizeAccountIds(options.accountIds);
    if (accountIds.length) add('t.account_id = ANY(?::int[])', accountIds);
    if (options.merchant) add("COALESCE(t.merchant_name, t.name) ILIKE '%' || ? || '%'", options.merchant);
    if (options.category) add("COALESCE(tc.normalized_category, t.category, 'Uncategorized') = ?", options.category);
    if (options.direction) {
      add("COALESCE(tc.direction, CASE WHEN t.amount > 0 THEN 'spending' ELSE 'income' END) = ?", options.direction);
    }
    if (Number.isFinite(options.minAmount)) add('ABS(t.amount) >= ?', options.minAmount);
    if (Number.isFinite(options.maxAmount)) add('ABS(t.amount) <= ?', options.maxAmount);

    return {
      where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
      params,
    };
  }

  static async fetchTransactionRows(options = {}, maxRows = MAX_ANALYSIS_ROWS) {
    const { where, params } = this.buildTransactionQuery(options);
    params.push(maxRows);
    const result = await pool.query(
      `SELECT t.id, t.account_id, t.date, t.name, t.merchant_name, t.amount,
              t.currency_code, t.category, t.pending,
              COALESCE(NULLIF(TRIM(a.display_name), ''), a.name) AS account_name,
              tc.transaction_id AS classification_transaction_id,
              tc.direction, tc.normalized_category, tc.is_internal_transfer,
              tc.is_refund, tc.is_reimbursement, tc.is_essential, tc.is_one_time
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN transaction_classifications tc ON tc.transaction_id = t.id
       ${where}
       ORDER BY t.date DESC, t.id DESC
       LIMIT $${params.length}`,
      params
    );
    return result.rows;
  }

  static async queryTransactions(options = {}) {
    const resultMode = options.resultMode || 'rows';
    const effectiveOptions = resultMode === 'recurring' && !options.startDate
      ? { ...options, startDate: defaultStartDate(400) }
      : options;
    const rows = await this.fetchTransactionRows(effectiveOptions);
    const summary = summarizeTransactions(rows);
    const warnings = [
      ...(rows.length === MAX_ANALYSIS_ROWS
        ? [`Analysis was limited to ${MAX_ANALYSIS_ROWS} matching transactions; narrow the date range for complete results.`]
        : []),
      ...(summary.classificationCoveragePercent < 100
        ? [`Only ${summary.classificationCoveragePercent}% of matching transactions have semantic classifications; transfers, refunds, and reimbursements may be miscategorized.`]
        : []),
    ];

    if (resultMode === 'summary') {
      return { meta: toolMeta({ startDate: options.startDate || defaultStartDate(), endDate: options.endDate || null }), summary, warnings };
    }
    if (resultMode === 'grouped' || resultMode === 'series') {
      const groupBy = resultMode === 'series' ? (options.groupBy || 'month') : (options.groupBy || 'category');
      return {
        meta: toolMeta({ startDate: options.startDate || defaultStartDate(), endDate: options.endDate || null, groupBy }),
        summary,
        groups: groupTransactions(rows, groupBy),
        warnings,
      };
    }
    if (resultMode === 'recurring') {
      return {
        meta: toolMeta({ startDate: effectiveOptions.startDate, endDate: options.endDate || null }),
        summary,
        candidates: recurringCandidates(rows),
        warnings,
      };
    }

    const limit = clampLimit(options.limit);
    const offset = Math.max(0, Number.parseInt(options.offset, 10) || 0);
    const normalized = rows.map(normalizedTransaction);
    return {
      meta: toolMeta({ startDate: options.startDate || defaultStartDate(), endDate: options.endDate || null }),
      summary,
      transactions: normalized.slice(offset, offset + limit),
      pagination: {
        returnedFromAnalyzedRows: normalized.length,
        limit,
        offset,
        nextOffset: offset + limit < normalized.length ? offset + limit : null,
      },
      warnings,
    };
  }

  static async getTimeSeries(options = {}) {
    const metric = options.metric || 'net_worth';
    const interval = options.interval || 'month';
    const truncMap = { day: 'day', week: 'week', month: 'month', quarter: 'quarter', year: 'year' };
    const trunc = truncMap[interval] || 'month';
    const startDate = options.startDate || defaultStartDate(365);
    const endDate = options.endDate || new Date().toISOString().slice(0, 10);
    const accountIds = normalizeAccountIds(options.accountIds);
    let rows;

    if (['net_worth', 'total_assets', 'total_liabilities', 'account_value'].includes(metric)) {
      const params = [startDate, endDate];
      let accountFilter = '';
      if (accountIds.length) {
        params.push(accountIds);
        accountFilter = `AND acs.account_id = ANY($${params.length}::int[])`;
      }
      const valueExpression = metric === 'total_assets'
        ? "SUM(CASE WHEN a.type NOT IN ('credit', 'loan') THEN acs.total_value ELSE 0 END)"
        : metric === 'total_liabilities'
          ? "SUM(CASE WHEN a.type IN ('credit', 'loan') THEN ABS(acs.total_value) ELSE 0 END)"
          : 'SUM(acs.total_value)';
      const result = await pool.query(
        `WITH daily AS (
           SELECT acs.snapshot_date, ${valueExpression} AS value
           FROM account_snapshots acs
           JOIN accounts a ON a.id = acs.account_id
           WHERE a.is_hidden = FALSE
             AND acs.snapshot_date BETWEEN $1 AND $2
             ${accountFilter}
           GROUP BY acs.snapshot_date
         )
         SELECT DATE_TRUNC('${trunc}', snapshot_date)::date AS date,
                (ARRAY_AGG(value ORDER BY snapshot_date DESC))[1] AS value
         FROM daily
         GROUP BY DATE_TRUNC('${trunc}', snapshot_date)
         ORDER BY date`,
        params
      );
      rows = result.rows;
    } else if (metric === 'holding_value') {
      const params = [startDate, endDate];
      let filter = '';
      if (options.ticker) {
        params.push(options.ticker.toUpperCase());
        filter = `AND UPPER(ts.ticker) = $${params.length}`;
      }
      const result = await pool.query(
        `WITH daily AS (
           SELECT ts.snapshot_date, SUM(ts.value) AS value
           FROM ticker_snapshots ts
           JOIN accounts a ON a.id = ts.account_id
           WHERE a.is_hidden = FALSE AND ts.snapshot_date BETWEEN $1 AND $2 ${filter}
           GROUP BY ts.snapshot_date
         )
         SELECT DATE_TRUNC('${trunc}', snapshot_date)::date AS date,
                (ARRAY_AGG(value ORDER BY snapshot_date DESC))[1] AS value
         FROM daily GROUP BY DATE_TRUNC('${trunc}', snapshot_date) ORDER BY date`,
        params
      );
      rows = result.rows;
    } else if (['spending', 'income', 'net_cash_flow', 'savings_rate'].includes(metric)) {
      const transactions = await this.fetchTransactionRows({
        startDate,
        endDate,
        accountIds,
        includePending: false,
      });
      const groups = groupTransactions(transactions, interval);
      rows = groups.map((group) => ({
        date: group.key,
        value: metric === 'spending'
          ? group.spending
          : metric === 'income'
            ? group.income
            : metric === 'net_cash_flow'
              ? group.netCashFlow
              : group.income > 0 ? ((group.income - group.spending) / group.income) * 100 : 0,
      })).sort((a, b) => a.date.localeCompare(b.date));
    } else if (['salary', 'total_compensation'].includes(metric)) {
      const column = metric === 'salary' ? 'salary_amount' : 'total_comp';
      const result = await pool.query(
        `SELECT effective_date AS date, ${column} AS value
         FROM salary_history
         WHERE effective_date BETWEEN $1 AND $2
         ORDER BY effective_date`,
        [startDate, endDate]
      );
      rows = result.rows;
    } else if (metric === 'recurring_commitments') {
      const result = await pool.query(
        `SELECT reh.effective_date AS date, SUM(reh.cost) AS value
         FROM recurring_expense_history reh
         WHERE reh.effective_date BETWEEN $1 AND $2
         GROUP BY reh.effective_date ORDER BY reh.effective_date`,
        [startDate, endDate]
      );
      rows = result.rows;
    } else {
      throw new Error(`Unsupported metric: ${metric}`);
    }

    const points = rows.map((row) => ({ date: isoDate(row.date), value: round(toNumber(row.value), 4) }));
    return {
      meta: toolMeta({ metric, interval, startDate, endDate }),
      summary: summarizeSeries(points),
      series: points.map((point, index) => ({
        ...point,
        change: index ? round(point.value - points[index - 1].value, 4) : null,
        changePercent: index ? percentChange(point.value, points[index - 1].value) : null,
      })),
      warnings: points.length ? [] : ['No observations were available for the requested metric and date range.'],
    };
  }

  static async comparePeriods(options = {}) {
    const periodA = options.periodA;
    const periodB = options.periodB;
    if (!periodA?.start || !periodA?.end || !periodB?.start || !periodB?.end) {
      throw new Error('Both periods require start and end dates.');
    }
    const [rowsA, rowsB] = await Promise.all([
      this.fetchTransactionRows({ startDate: periodA.start, endDate: periodA.end, includePending: false }),
      this.fetchTransactionRows({ startDate: periodB.start, endDate: periodB.end, includePending: false }),
    ]);
    const summaryA = summarizeTransactions(rowsA);
    const summaryB = summarizeTransactions(rowsB);
    const metrics = options.metrics?.length ? options.metrics : ['spending', 'income', 'netCashFlow', 'savingsRatePercent'];
    const comparisons = {};
    for (const metric of metrics) {
      const before = toNumber(summaryA[metric], NaN);
      const after = toNumber(summaryB[metric], NaN);
      comparisons[metric] = {
        periodA: Number.isFinite(before) ? round(before, 4) : null,
        periodB: Number.isFinite(after) ? round(after, 4) : null,
        change: Number.isFinite(before) && Number.isFinite(after) ? round(after - before, 4) : null,
        changePercent: percentChange(after, before),
      };
    }
    const groupBy = options.groupBy || 'category';
    const groupedA = new Map(groupTransactions(rowsA, groupBy).map((group) => [group.key, group]));
    const groupedB = new Map(groupTransactions(rowsB, groupBy).map((group) => [group.key, group]));
    const keys = new Set([...groupedA.keys(), ...groupedB.keys()]);
    const drivers = [...keys].map((key) => {
      const before = groupedA.get(key)?.spending || 0;
      const after = groupedB.get(key)?.spending || 0;
      return { key, periodA: before, periodB: after, change: round(after - before), changePercent: percentChange(after, before) };
    }).sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

    return {
      meta: toolMeta({ periodA, periodB, groupBy }),
      comparisons,
      drivers: drivers.slice(0, clampLimit(options.driverLimit || 20, 20)),
      warnings: [
        ...(rowsA.length === MAX_ANALYSIS_ROWS || rowsB.length === MAX_ANALYSIS_ROWS
          ? ['At least one comparison period hit the analysis row limit.']
          : []),
        ...(summaryA.classificationCoveragePercent < 100 || summaryB.classificationCoveragePercent < 100
          ? [`Semantic classification coverage is ${summaryA.classificationCoveragePercent}% for period A and ${summaryB.classificationCoveragePercent}% for period B; transfers, refunds, and reimbursements may distort the comparison.`]
          : []),
      ],
    };
  }

  static async getInvestmentSeries({ scopeType = 'portfolio', accountId = null, ticker = null, startDate, endDate }) {
    if (scopeType === 'ticker') {
      const result = await pool.query(
        `SELECT ts.snapshot_date AS date, SUM(ts.value) AS value
         FROM ticker_snapshots ts JOIN accounts a ON a.id = ts.account_id
         WHERE a.is_hidden = FALSE AND UPPER(ts.ticker) = UPPER($1)
           AND ts.snapshot_date BETWEEN $2 AND $3
         GROUP BY ts.snapshot_date ORDER BY ts.snapshot_date`,
        [ticker, startDate, endDate]
      );
      return result.rows.map((row) => ({ date: isoDate(row.date), value: toNumber(row.value) }));
    }
    const params = [startDate, endDate];
    let accountFilter = '';
    if (scopeType === 'account') {
      params.push(accountId);
      accountFilter = `AND acs.account_id = $${params.length}`;
    }
    const result = await pool.query(
      `SELECT acs.snapshot_date AS date, SUM(acs.total_value) AS value
       FROM account_snapshots acs JOIN accounts a ON a.id = acs.account_id
       WHERE a.is_hidden = FALSE AND a.type IN ('investment', 'crypto')
         AND acs.snapshot_date BETWEEN $1 AND $2 ${accountFilter}
       GROUP BY acs.snapshot_date ORDER BY acs.snapshot_date`,
      params
    );
    return result.rows.map((row) => ({ date: isoDate(row.date), value: toNumber(row.value) }));
  }

  static async analyzeInvestments(options = {}) {
    const startDate = options.startDate || defaultStartDate(365);
    const endDate = options.endDate || new Date().toISOString().slice(0, 10);
    const scopeType = options.scopeType || 'portfolio';
    if (scopeType === 'account' && !options.accountId) throw new Error('account_id is required for account scope.');
    if (scopeType === 'ticker' && !options.ticker) throw new Error('ticker is required for ticker scope.');
    const series = await this.getInvestmentSeries({
      scopeType,
      accountId: options.accountId,
      ticker: options.ticker,
      startDate,
      endDate,
    });
    const warnings = [];
    if (series.length < 2) {
      return {
        meta: toolMeta({ startDate, endDate, scopeType }),
        summary: summarizeSeries(series),
        warnings: ['Insufficient valuation history for investment analysis.'],
      };
    }

    let externalFlows = [];
    if (scopeType === 'ticker') {
      warnings.push('Ticker-level external cash flows are not stored, so ticker returns assume there were none.');
    } else {
      const flowParams = [startDate, endDate];
      let flowFilter = '';
      if (scopeType === 'account') {
        flowParams.push(options.accountId);
        flowFilter = `AND account_id = $${flowParams.length}`;
      }
      const flowResult = await pool.query(
        `SELECT flow_date, amount, flow_type, is_external
         FROM investment_cash_flows
         WHERE flow_date BETWEEN $1 AND $2 ${flowFilter}
         ORDER BY flow_date`,
        flowParams
      );
      externalFlows = flowResult.rows.filter((row) => row.is_external);
      if (!externalFlows.length) warnings.push('No external investment cash flows are recorded for this scope; return calculations assume there were none.');
    }
    const flowsByDate = new Map();
    for (const flow of externalFlows) {
      const date = isoDate(flow.flow_date);
      flowsByDate.set(date, toNumber(flowsByDate.get(date)) + toNumber(flow.amount));
    }
    const baseSummary = summarizeSeries(series);
    const twr = timeWeightedReturn(series, flowsByDate);
    const datedCashFlows = [
      { date: series[0].date, amount: -series[0].value },
      ...externalFlows.map((flow) => ({ date: isoDate(flow.flow_date), amount: -toNumber(flow.amount) })),
      { date: series.at(-1).date, amount: series.at(-1).value },
    ];
    const investmentReturns = calculateReturns(series, flowsByDate);
    const result = {
      meta: toolMeta({ startDate, endDate, scopeType }),
      summary: {
        ...baseSummary,
        // null (not 0) when no flows are recorded: an untracked value must not
        // present as a measured zero.
        externalNetFlows: externalFlows.length
          ? round(externalFlows.reduce((sum, flow) => sum + toNumber(flow.amount), 0))
          : null,
        simpleReturnPercent: baseSummary.changePercent,
        timeWeightedReturnPercent: twr,
        moneyWeightedReturnPercent: xirr(datedCashFlows),
      },
      risk: riskMetrics(series, flowsByDate),
      methodology: {
        balanceChange: 'end_value - start_value',
        timeWeightedReturn: 'Daily chain-linked return with recorded external flows removed on the flow date.',
        moneyWeightedReturn: 'Annualized XIRR over beginning value, dated external flows, and ending value.',
      },
      warnings,
    };

    if (options.benchmarkSymbol) {
      const benchmarkResult = await pool.query(
        `SELECT price_date AS date, COALESCE(total_return_index, adjusted_close) AS value
         FROM benchmark_prices
         WHERE UPPER(symbol) = UPPER($1) AND price_date BETWEEN $2 AND $3
         ORDER BY price_date`,
        [options.benchmarkSymbol, startDate, endDate]
      );
      const benchmarkPrices = benchmarkResult.rows.map((row) => ({ date: isoDate(row.date), value: toNumber(row.value) }));
      if (benchmarkPrices.length < 2) {
        warnings.push(`Benchmark ${options.benchmarkSymbol} does not have enough stored history for comparison.`);
      } else {
        const benchmarkReturns = calculateReturns(benchmarkPrices);
        const benchmarkSummary = summarizeSeries(benchmarkPrices);
        const relationship = correlationAndBeta(investmentReturns, benchmarkReturns);
        result.benchmark = {
          symbol: options.benchmarkSymbol,
          returnPercent: benchmarkSummary.changePercent,
          excessReturnPercent: twr === null ? null : round(twr - benchmarkSummary.changePercent, 6),
          ...relationship,
          coverage: { start: benchmarkPrices[0].date, end: benchmarkPrices.at(-1).date },
        };
      }
    }

    if (options.includeAttribution) {
      const attributionParams = [startDate, endDate];
      let attributionFilter = '';
      if (scopeType === 'account') {
        attributionParams.push(options.accountId);
        attributionFilter = `AND ts.account_id = $${attributionParams.length}`;
      } else if (scopeType === 'ticker') {
        attributionParams.push(options.ticker);
        attributionFilter = `AND UPPER(ts.ticker) = UPPER($${attributionParams.length})`;
      }
      const attributionResult = await pool.query(
        `WITH bounds AS (
           SELECT ts.account_id, COALESCE(ts.ticker, ts.name) AS position,
                  (ARRAY_AGG(ts.value ORDER BY ts.snapshot_date ASC))[1] AS start_value,
                  (ARRAY_AGG(ts.value ORDER BY ts.snapshot_date DESC))[1] AS end_value
           FROM ticker_snapshots ts JOIN accounts a ON a.id = ts.account_id
           WHERE a.is_hidden = FALSE AND ts.snapshot_date BETWEEN $1 AND $2 ${attributionFilter}
           GROUP BY ts.account_id, COALESCE(ts.ticker, ts.name)
         )
         SELECT position, SUM(start_value) AS start_value, SUM(end_value) AS end_value
         FROM bounds GROUP BY position`,
        attributionParams
      );
      result.attribution = attributionResult.rows.map((row) => ({
        position: row.position,
        startValue: round(toNumber(row.start_value)),
        endValue: round(toNumber(row.end_value)),
        change: round(toNumber(row.end_value) - toNumber(row.start_value)),
      })).sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
      warnings.push('Position attribution is balance-change attribution until holding-level trade and cash-flow history is complete.');
    }

    if (options.includeTaxLots) {
      const taxParams = [];
      const taxConditions = ['tl.remaining_quantity > 0'];
      if (scopeType === 'account') {
        taxParams.push(options.accountId);
        taxConditions.push(`tl.account_id = $${taxParams.length}`);
      } else if (scopeType === 'ticker') {
        taxParams.push(options.ticker);
        taxConditions.push(`UPPER(tl.symbol) = UPPER($${taxParams.length})`);
      }
      const taxResult = await pool.query(
        `SELECT tl.id, tl.account_id, tl.symbol, tl.acquired_date, tl.remaining_quantity,
                tl.cost_basis, pc.price_usd,
                (tl.remaining_quantity * pc.price_usd) AS market_value,
                (tl.remaining_quantity * pc.price_usd - tl.cost_basis) AS unrealized_gain
         FROM tax_lots tl
         LEFT JOIN price_cache pc ON UPPER(pc.ticker) = UPPER(tl.symbol)
         WHERE ${taxConditions.join(' AND ')}
         ORDER BY unrealized_gain ASC NULLS LAST`,
        taxParams
      );
      result.taxLots = taxResult.rows.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        symbol: row.symbol,
        acquiredDate: isoDate(row.acquired_date),
        quantity: toNumber(row.remaining_quantity),
        costBasis: round(toNumber(row.cost_basis)),
        marketValue: row.market_value === null ? null : round(toNumber(row.market_value)),
        unrealizedGain: row.unrealized_gain === null ? null : round(toNumber(row.unrealized_gain)),
      }));
      if (!result.taxLots.length) warnings.push('No tax-lot data is stored; tax-aware analysis is unavailable.');
    }

    return result;
  }

  static async analyzeCashFlow(options = {}) {
    const startDate = options.startDate || defaultStartDate(365);
    const endDate = options.endDate || new Date().toISOString().slice(0, 10);
    const rows = await this.fetchTransactionRows({ startDate, endDate, includePending: false });
    const summary = summarizeTransactions(rows);
    const months = Math.max(1, (new Date(endDate) - new Date(startDate)) / (30.44 * 24 * 60 * 60 * 1000));
    const overview = await this.getOverview();
    const liquidAssets = overview.accounts
      .filter((account) => LIQUID_TYPES.has(account.accountType))
      .reduce((sum, account) => sum + Math.max(0, account.value), 0);
    const monthlyEssential = summary.essentialSpending === null ? null : summary.essentialSpending / months;
    const monthlySpending = summary.spending / months;
    const [recurring, savedRecurring] = await Promise.all([
      Promise.resolve(recurringCandidates(rows)),
      RecurringExpense.findAll(),
    ]);
    const categoryDrivers = groupTransactions(rows, 'category');
    const merchantDrivers = groupTransactions(rows, 'merchant');
    const spendingRows = rows.map(normalizedTransaction).filter((row) => row.direction === 'spending');
    const averageSpend = spendingRows.length ? summary.spending / spendingRows.length : 0;
    const anomalies = spendingRows
      .filter((row) => row.isOneTime || row.amount >= Math.max(averageSpend * 4, 500))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 20);
    const salaries = await SalaryHistory.findAll();

    return {
      meta: toolMeta({ startDate, endDate }),
      summary: {
        ...summary,
        averageMonthlySpending: round(monthlySpending),
        averageMonthlyEssentialSpending: monthlyEssential === null ? null : round(monthlyEssential),
        liquidAssets: round(liquidAssets),
        runwayMonths: monthlyEssential
          ? round(liquidAssets / monthlyEssential, 2)
          : monthlySpending ? round(liquidAssets / monthlySpending, 2) : null,
      },
      drivers: {
        categories: categoryDrivers.slice(0, 20),
        merchants: merchantDrivers.slice(0, 20),
      },
      recurringCandidates: recurring,
      savedRecurringExpenses: savedRecurring.map((expense) => ({
        id: expense.id,
        name: expense.name,
        monthlyCost: round(toNumber(expense.cost)),
        fixedRate: Boolean(expense.is_fixed_rate),
      })),
      anomalies,
      compensation: salaries.map((row) => ({
        effectiveDate: isoDate(row.effective_date),
        title: row.title,
        salary: round(toNumber(row.salary_amount)),
        totalCompensation: round(toNumber(row.total_comp)),
      })),
      warnings: [
        ...(summary.classificationCoveragePercent < 100
          ? [`Only ${summary.classificationCoveragePercent}% of matching transactions have semantic classifications; transfers, refunds, and reimbursements may distort cash-flow metrics.`]
          : []),
        ...(summary.essentialSpending === null ? ['Essential/discretionary classifications are incomplete; runway uses total spending.'] : []),
        ...(rows.length === MAX_ANALYSIS_ROWS ? ['Transaction analysis reached the row limit.'] : []),
      ],
    };
  }

  static async runScenario(options = {}) {
    const scenarioType = options.scenarioType;
    const assumptions = options.assumptions || {};
    const horizonYears = Math.max(0.1, toNumber(options.horizonYears, 10));
    const overview = await this.getOverview();
    const warnings = ['Scenario results are mathematical projections, not predictions or financial advice.'];

    if (scenarioType === 'goal_projection') {
      const principal = toNumber(assumptions.starting_value, overview.summary.netWorth);
      const monthlyContribution = toNumber(assumptions.monthly_contribution, 0);
      const target = toNumber(assumptions.target_value, 0);
      const returns = Array.isArray(assumptions.annual_return_scenarios)
        ? assumptions.annual_return_scenarios
        : [0.03, 0.06, 0.09];
      const scenarios = returns.map((annualReturn) => ({
        annualReturnPercent: round(toNumber(annualReturn) * 100, 3),
        ...futureValue({ principal, monthlyContribution, annualReturn: toNumber(annualReturn), years: horizonYears }),
      }));
      return {
        meta: toolMeta({ scenarioType, horizonYears }),
        assumptions: { principal, monthlyContribution, target, annualReturns: returns },
        scenarios,
        targetReached: target ? scenarios.map((scenario) => scenario.endingValue >= target) : null,
        warnings,
      };
    }

    if (scenarioType === 'allocation_change') {
      const currentAllocation = assumptions.current_allocation || {};
      const proposedAllocation = assumptions.proposed_allocation || {};
      const expectedReturns = assumptions.expected_annual_returns || {};
      const assetClasses = new Set([
        ...Object.keys(currentAllocation),
        ...Object.keys(proposedAllocation),
      ]);
      if (!assetClasses.size || !Object.keys(expectedReturns).length) {
        throw new Error('allocation_change requires current_allocation, proposed_allocation, and expected_annual_returns assumptions.');
      }
      const allocationTotal = (allocation) => [...assetClasses]
        .reduce((sum, assetClass) => sum + toNumber(allocation[assetClass]), 0);
      const weightedReturn = (allocation) => [...assetClasses]
        .reduce((sum, assetClass) => sum + (toNumber(allocation[assetClass]) * toNumber(expectedReturns[assetClass])), 0);
      const currentTotal = allocationTotal(currentAllocation);
      const proposedTotal = allocationTotal(proposedAllocation);
      if (currentTotal <= 0 || proposedTotal <= 0) throw new Error('Allocation weights must have positive totals.');
      const normalizedCurrent = Object.fromEntries([...assetClasses].map((assetClass) => [
        assetClass,
        round(toNumber(currentAllocation[assetClass]) / currentTotal, 6),
      ]));
      const normalizedProposed = Object.fromEntries([...assetClasses].map((assetClass) => [
        assetClass,
        round(toNumber(proposedAllocation[assetClass]) / proposedTotal, 6),
      ]));
      const currentReturn = weightedReturn(normalizedCurrent);
      const proposedReturn = weightedReturn(normalizedProposed);
      const principal = toNumber(assumptions.starting_value, overview.summary.netWorth);
      const monthlyContribution = toNumber(assumptions.monthly_contribution, 0);
      const currentProjection = futureValue({ principal, monthlyContribution, annualReturn: currentReturn, years: horizonYears });
      const proposedProjection = futureValue({ principal, monthlyContribution, annualReturn: proposedReturn, years: horizonYears });
      return {
        meta: toolMeta({ scenarioType, horizonYears }),
        assumptions: {
          principal,
          monthlyContribution,
          currentAllocation: normalizedCurrent,
          proposedAllocation: normalizedProposed,
          expectedAnnualReturns: expectedReturns,
        },
        result: {
          currentWeightedReturnPercent: round(currentReturn * 100, 4),
          proposedWeightedReturnPercent: round(proposedReturn * 100, 4),
          currentProjection,
          proposedProjection,
          projectedDifference: round(proposedProjection.endingValue - currentProjection.endingValue),
        },
        warnings: [
          ...warnings,
          'The allocation model assumes constant annual returns, monthly compounding, no taxes or fees, and annual rebalancing.',
        ],
      };
    }

    if (scenarioType === 'expense_reduction') {
      const monthlySavings = toNumber(assumptions.monthly_expense_reduction, 0);
      const annualReturn = toNumber(assumptions.annual_return, 0);
      return {
        meta: toolMeta({ scenarioType, horizonYears }),
        assumptions: { monthlySavings, annualReturn },
        result: futureValue({ principal: 0, monthlyContribution: monthlySavings, annualReturn, years: horizonYears }),
        warnings,
      };
    }

    if (scenarioType === 'income_loss') {
      const cashFlow = await this.analyzeCashFlow({ startDate: options.startDate, endDate: options.endDate });
      const monthlyExpense = toNumber(assumptions.monthly_expenses, cashFlow.summary.averageMonthlyEssentialSpending || cashFlow.summary.averageMonthlySpending);
      const liquidAssets = toNumber(assumptions.liquid_assets, cashFlow.summary.liquidAssets);
      return {
        meta: toolMeta({ scenarioType }),
        assumptions: { monthlyExpense, liquidAssets },
        result: { runwayMonths: monthlyExpense > 0 ? round(liquidAssets / monthlyExpense, 2) : null },
        warnings: [...warnings, ...cashFlow.warnings],
      };
    }

    if (scenarioType === 'debt_vs_invest') {
      const debtResult = await pool.query(
        `SELECT dt.account_id, dt.apr, dt.minimum_payment,
                COALESCE(NULLIF(TRIM(a.display_name), ''), a.name) AS account_name,
                ABS(COALESCE(latest.total_value, 0)) AS balance
         FROM debt_terms dt JOIN accounts a ON a.id = dt.account_id
         LEFT JOIN LATERAL (
           SELECT total_value FROM account_snapshots
           WHERE account_id = dt.account_id ORDER BY snapshot_date DESC LIMIT 1
         ) latest ON TRUE
         ORDER BY dt.apr DESC NULLS LAST`
      );
      const extraCash = toNumber(assumptions.extra_cash, 0);
      const investmentReturn = toNumber(assumptions.expected_annual_return, 0.06);
      const debtApr = toNumber(assumptions.debt_apr, debtResult.rows[0]?.apr);
      return {
        meta: toolMeta({ scenarioType, horizonYears }),
        assumptions: { extraCash, investmentReturn, debtApr },
        result: {
          estimatedDebtInterestAvoided: round(extraCash * (((1 + debtApr) ** horizonYears) - 1)),
          estimatedInvestmentGrowth: round(extraCash * (((1 + investmentReturn) ** horizonYears) - 1)),
          spreadAtHorizon: round(extraCash * (((1 + investmentReturn) ** horizonYears) - ((1 + debtApr) ** horizonYears))),
        },
        debts: debtResult.rows.map((row) => ({
          accountId: row.account_id,
          accountName: row.account_name,
          balance: round(toNumber(row.balance)),
          aprPercent: round(toNumber(row.apr) * 100, 4),
          minimumPayment: round(toNumber(row.minimum_payment)),
        })),
        warnings: debtResult.rows.length ? warnings : [...warnings, 'No debt terms are stored; assumptions supplied by the caller were used.'],
      };
    }

    throw new Error(`Unsupported scenario type: ${scenarioType}`);
  }

  static async getDataHealth() {
    const portfolio = await DashboardService.getCurrentPortfolio();
    const result = await pool.query(
      `SELECT
        (SELECT COUNT(*)::int FROM holdings h
         JOIN accounts a ON a.id = h.account_id
         LEFT JOIN price_cache pc ON UPPER(pc.ticker) = UPPER(h.ticker)
         WHERE a.is_hidden = FALSE AND h.ticker IS NOT NULL AND h.quantity > 0 AND pc.ticker IS NULL) AS missing_prices,
        (SELECT COUNT(*)::int FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN transaction_classifications tc ON tc.transaction_id = t.id
         WHERE a.is_hidden = FALSE AND tc.transaction_id IS NULL) AS unclassified_transactions,
        (SELECT COUNT(*)::int FROM holdings h
         JOIN accounts a ON a.id = h.account_id
         LEFT JOIN tax_lots tl ON tl.account_id = h.account_id AND UPPER(tl.symbol) = UPPER(h.ticker)
         WHERE a.is_hidden = FALSE AND a.type = 'investment' AND h.ticker IS NOT NULL AND tl.id IS NULL) AS positions_without_tax_lots,
        (SELECT COUNT(*)::int FROM benchmark_prices) AS benchmark_observations,
        (SELECT COUNT(*)::int FROM investment_cash_flows WHERE is_external) AS recorded_investment_flows,
        (SELECT MAX(date) FROM transactions) AS latest_transaction_date,
        (SELECT MAX(snapshot_date) FROM account_snapshots) AS latest_snapshot_date`
    );
    const counts = result.rows[0];
    const issues = [];
    if (counts.missing_prices) issues.push({ severity: 'warning', code: 'missing_prices', count: counts.missing_prices });
    if (counts.unclassified_transactions) issues.push({ severity: 'info', code: 'unclassified_transactions', count: counts.unclassified_transactions });
    if (counts.positions_without_tax_lots) issues.push({ severity: 'info', code: 'missing_tax_lots', count: counts.positions_without_tax_lots });
    if (!counts.benchmark_observations) issues.push({ severity: 'info', code: 'missing_benchmark_history', count: 0 });
    if (!counts.recorded_investment_flows) issues.push({ severity: 'warning', code: 'missing_investment_cash_flows', count: 0 });

    return {
      meta: toolMeta(),
      status: portfolio.freshness.status === 'warning' || issues.some((issue) => issue.severity === 'warning') ? 'warning' : 'ok',
      freshness: portfolio.freshness,
      coverage: {
        latestTransactionDate: isoDate(counts.latest_transaction_date),
        latestSnapshotDate: isoDate(counts.latest_snapshot_date),
        benchmarkObservations: counts.benchmark_observations,
        recordedInvestmentFlows: counts.recorded_investment_flows,
      },
      issues,
    };
  }

  static async exportDataset(options = {}) {
    const datasets = {
      account_snapshots: {
        table: 'account_snapshots', date: 'snapshot_date', columns: ['id', 'snapshot_date', 'account_id', 'total_value'],
      },
      holding_snapshots: {
        table: 'ticker_snapshots', date: 'snapshot_date', columns: ['id', 'snapshot_date', 'account_id', 'ticker', 'name', 'value', 'quantity', 'price_usd'],
      },
      salary_history: {
        table: 'salary_history', date: 'effective_date', columns: ['id', 'effective_date', 'title', 'salary_amount', 'psu', 'rsu', 'total_comp', 'change_amount', 'change_percent'],
      },
      recurring_expenses: {
        table: 'recurring_expenses', date: null, columns: ['id', 'name', 'cost', 'is_fixed_rate', 'pay_account', 'company', 'merchant_key', 'due_day', 'last_charge_date', 'tag'],
      },
      benchmark_prices: {
        table: 'benchmark_prices', date: 'price_date', columns: ['symbol', 'price_date', 'adjusted_close', 'total_return_index', 'source'],
      },
      investment_cash_flows: {
        table: 'investment_cash_flows', date: 'flow_date', columns: ['id', 'account_id', 'flow_date', 'amount', 'flow_type', 'is_external', 'transaction_id', 'notes'],
      },
      tax_lots: {
        table: 'tax_lots', date: 'acquired_date', columns: ['id', 'account_id', 'symbol', 'acquired_date', 'quantity', 'remaining_quantity', 'cost_basis', 'source_trade_id'],
      },
      debt_terms: {
        table: 'debt_terms', date: null, columns: ['account_id', 'apr', 'minimum_payment', 'due_day', 'maturity_date', 'is_tax_deductible', 'notes'],
      },
    };
    if (options.dataset === 'transactions') {
      const result = await this.queryTransactions({ ...options, resultMode: 'rows' });
      const allowedColumns = [
        'id', 'date', 'accountId', 'accountName', 'name', 'merchant', 'amount', 'sourceAmount',
        'currency', 'category', 'direction', 'pending', 'isInternalTransfer', 'isRefund',
        'isReimbursement', 'isEssential', 'isOneTime', 'hasSemanticClassification',
      ];
      const selected = selectColumns(result.transactions, options.columns, allowedColumns);
      return {
        ...result,
        meta: { ...result.meta, dataset: 'transactions', columns: selected.columns },
        transactions: selected.records,
      };
    }
    if (options.dataset === 'positions') {
      const result = await this.queryPositions({ ...options, groupBy: 'none' });
      const allowedColumns = [
        'id', 'accountId', 'accountName', 'accountType', 'ticker', 'name', 'category',
        'location', 'value', 'snapshotDate',
      ];
      const selected = selectColumns(result.positions, options.columns, allowedColumns);
      return {
        ...result,
        meta: { ...result.meta, dataset: 'positions', columns: selected.columns },
        positions: selected.records,
      };
    }
    const config = datasets[options.dataset];
    if (!config) throw new Error(`Unsupported dataset: ${options.dataset}`);
    const requestedColumns = options.columns?.length
      ? options.columns.filter((column) => config.columns.includes(column))
      : config.columns;
    if (!requestedColumns.length) throw new Error('No valid columns were requested.');
    const params = [];
    const conditions = [];
    if (config.date && options.startDate) {
      params.push(options.startDate);
      conditions.push(`${config.date} >= $${params.length}`);
    }
    if (config.date && options.endDate) {
      params.push(options.endDate);
      conditions.push(`${config.date} <= $${params.length}`);
    }
    const limit = clampLimit(options.limit);
    const offset = Math.max(0, Number.parseInt(options.offset, 10) || 0);
    params.push(limit, offset);
    const result = await pool.query(
      `SELECT ${requestedColumns.join(', ')} FROM ${config.table}
       ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
       ${config.date ? `ORDER BY ${config.date} ASC` : ''}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return {
      meta: toolMeta({ dataset: options.dataset, columns: requestedColumns }),
      records: result.rows,
      pagination: { limit, offset, nextOffset: result.rows.length === limit ? offset + limit : null },
    };
  }

  static async getIncomeObligations() {
    const [salary, recurring] = await Promise.all([SalaryHistory.findAll(), RecurringExpense.findAll()]);
    const monthlyRecurring = recurring.reduce((sum, expense) => sum + toNumber(expense.cost), 0);
    const latestSalary = salary[0];
    return {
      meta: toolMeta(),
      summary: {
        monthlyRecurring: round(monthlyRecurring),
        annualRecurring: round(monthlyRecurring * 12),
        latestAnnualSalary: latestSalary ? round(toNumber(latestSalary.salary_amount)) : null,
        latestTotalCompensation: latestSalary ? round(toNumber(latestSalary.total_comp)) : null,
        recurringShareOfGrossSalaryPercent: latestSalary && toNumber(latestSalary.salary_amount) > 0
          ? round(((monthlyRecurring * 12) / toNumber(latestSalary.salary_amount)) * 100, 4)
          : null,
      },
      salaryHistory: salary.map((row) => ({
        effectiveDate: isoDate(row.effective_date),
        title: row.title,
        salary: round(toNumber(row.salary_amount)),
        psu: round(toNumber(row.psu)),
        rsu: round(toNumber(row.rsu)),
        totalCompensation: round(toNumber(row.total_comp)),
      })),
      recurringExpenses: recurring.map((row) => ({
        id: row.id,
        name: row.name,
        monthlyCost: round(toNumber(row.cost)),
        fixedRate: Boolean(row.is_fixed_rate),
        payAccount: row.pay_account,
        company: row.company,
      })),
    };
  }
}

module.exports = FinancialQueryService;
