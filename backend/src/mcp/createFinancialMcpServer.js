'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const z = require('zod/v4');
const FinancialQueryService = require('../services/FinancialQueryService');
const logger = require('../config/logger');

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Calendar date in YYYY-MM-DD format.');
const accountIds = z.array(z.number().int().positive()).max(100).optional()
  .describe('Optional stable account IDs. Obtain IDs from finance_get_context.');
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function toolResult(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function toolError(error, toolName) {
  logger.error({ err: error, toolName }, 'MCP financial tool failed');
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ error: error.message, tool: toolName }),
    }],
    isError: true,
  };
}

function register(server, name, config, handler) {
  server.registerTool(name, { ...config, annotations }, async (input) => {
    try {
      return toolResult(await handler(input || {}));
    } catch (error) {
      return toolError(error, name);
    }
  });
}

function createFinancialMcpServer() {
  const server = new McpServer({
    name: 'my-money-tracker',
    version: '1.0.0',
  });

  register(server, 'finance_get_context', {
    title: 'Describe available financial data',
    description: 'Use this first when account IDs, date coverage, supported metrics, or financial definitions are unknown. It describes the available accounts and semantic data without returning sensitive credentials or raw database structure. It also identifies whether benchmark, cash-flow, tax-lot, debt, and transaction-classification data exists so later analytical results can be interpreted correctly.',
    inputSchema: {
      include_hidden: z.boolean().default(false).describe('Include accounts hidden from normal financial calculations.'),
    },
  }, ({ include_hidden: includeHidden }) => FinancialQueryService.getContext({ includeHidden }));

  register(server, 'finance_get_overview', {
    title: 'Get a net-worth and account overview',
    description: 'Returns total assets, liabilities, net worth, and account balances for today or a requested historical date. Use this for balance-sheet and liquidity questions, or as the starting state for a scenario. Historical values use the latest snapshot on or before the date and explicitly warn when an exact-date snapshot is unavailable.',
    inputSchema: {
      as_of: date.optional().describe('Historical as-of date. Omit for live values.'),
      include_hidden: z.boolean().default(false),
    },
  }, ({ as_of: asOf, include_hidden: includeHidden }) => FinancialQueryService.getOverview({ asOf, includeHidden }));

  register(server, 'finance_query_positions', {
    title: 'Query and group financial positions',
    description: 'Searches current or historical holdings and liabilities, with deterministic server-side filtering, sorting, aggregation, and allocation percentages. Use it for questions about holdings, exposure, allocation, concentration, accounts, categories, or asset locations. Use group_by for compact analytical results and use ungrouped pagination only when individual positions are required.',
    inputSchema: {
      as_of: date.optional(),
      include_hidden: z.boolean().default(false),
      ticker: z.string().max(40).optional(),
      text: z.string().max(200).optional().describe('Case-insensitive search across position, ticker, and account names.'),
      account_ids: accountIds,
      account_types: z.array(z.enum(['investment', 'depository', 'credit', 'loan', 'crypto', 'property', 'other'])).optional(),
      categories: z.array(z.string().max(100)).max(50).optional(),
      group_by: z.enum(['none', 'account', 'account_type', 'ticker', 'category', 'location']).default('none'),
      limit: z.number().int().min(1).max(1000).default(100),
      offset: z.number().int().min(0).default(0),
    },
  }, (input) => FinancialQueryService.queryPositions({
    asOf: input.as_of,
    includeHidden: input.include_hidden,
    ticker: input.ticker,
    text: input.text,
    accountIds: input.account_ids,
    accountTypes: input.account_types,
    categories: input.categories,
    groupBy: input.group_by,
    limit: input.limit,
    offset: input.offset,
  }));

  register(server, 'finance_query_transactions', {
    title: 'Query or aggregate transactions',
    description: 'Returns normalized transaction records or server-computed summaries, grouped results, time series, and recurring-charge candidates. Amounts are positive and direction is returned separately so agents do not need to interpret Plaid sign conventions. Use summary, grouped, series, or recurring modes instead of retrieving raw rows when answering analytical questions.',
    inputSchema: {
      start_date: date.optional().describe('Defaults to 90 days ago, or roughly 400 days ago for recurring analysis.'),
      end_date: date.optional(),
      account_ids: accountIds,
      merchant: z.string().max(200).optional(),
      category: z.string().max(200).optional(),
      direction: z.enum(['income', 'spending', 'internal_transfer', 'investment_contribution', 'investment_withdrawal', 'refund', 'reimbursement', 'dividend', 'interest', 'fee', 'debt_payment', 'other']).optional(),
      min_amount: z.number().nonnegative().optional(),
      max_amount: z.number().nonnegative().optional(),
      include_pending: z.boolean().default(false),
      include_hidden: z.boolean().default(false),
      result_mode: z.enum(['rows', 'summary', 'grouped', 'series', 'recurring']).default('rows'),
      group_by: z.enum(['category', 'merchant', 'account', 'direction', 'day', 'week', 'month', 'quarter', 'year']).default('category'),
      limit: z.number().int().min(1).max(1000).default(100),
      offset: z.number().int().min(0).default(0),
    },
  }, (input) => FinancialQueryService.queryTransactions({
    startDate: input.start_date,
    endDate: input.end_date,
    accountIds: input.account_ids,
    merchant: input.merchant,
    category: input.category,
    direction: input.direction,
    minAmount: input.min_amount,
    maxAmount: input.max_amount,
    includePending: input.include_pending,
    includeHidden: input.include_hidden,
    resultMode: input.result_mode,
    groupBy: input.group_by,
    limit: input.limit,
    offset: input.offset,
  }));

  register(server, 'finance_get_time_series', {
    title: 'Get a normalized financial time series',
    description: 'Returns an aligned and aggregated time series with changes and summary statistics for balances, holdings, cash flow, compensation, or recurring commitments. The server performs date bucketing and financial sign normalization. Use this instead of raw snapshot exports whenever the question involves a trend, chart, growth rate, or historical comparison.',
    inputSchema: {
      metric: z.enum(['net_worth', 'total_assets', 'total_liabilities', 'account_value', 'holding_value', 'spending', 'income', 'net_cash_flow', 'savings_rate', 'salary', 'total_compensation', 'recurring_commitments']),
      start_date: date.optional(),
      end_date: date.optional(),
      interval: z.enum(['day', 'week', 'month', 'quarter', 'year']).default('month'),
      account_ids: accountIds,
      ticker: z.string().max(40).optional(),
    },
  }, (input) => FinancialQueryService.getTimeSeries({
    metric: input.metric,
    startDate: input.start_date,
    endDate: input.end_date,
    interval: input.interval,
    accountIds: input.account_ids,
    ticker: input.ticker,
  }));

  const periodSchema = z.object({ start: date, end: date });
  register(server, 'finance_compare_periods', {
    title: 'Compare two financial periods and rank drivers',
    description: 'Compares financial metrics between two explicit date ranges and ranks categories, merchants, or accounts that explain the difference. Use it for year-over-year spending, savings-rate changes, lifestyle inflation, and other driver questions. The server performs aggregation and percentage calculations so the agent receives a compact decomposition rather than transaction dumps.',
    inputSchema: {
      period_a: periodSchema,
      period_b: periodSchema,
      metrics: z.array(z.enum(['spending', 'income', 'netCashFlow', 'savingsRatePercent'])).min(1).optional(),
      group_by: z.enum(['category', 'merchant', 'account']).default('category'),
      driver_limit: z.number().int().min(1).max(100).default(20),
    },
  }, (input) => FinancialQueryService.comparePeriods({
    periodA: input.period_a,
    periodB: input.period_b,
    metrics: input.metrics,
    groupBy: input.group_by,
    driverLimit: input.driver_limit,
  }));

  register(server, 'finance_analyze_investments', {
    title: 'Analyze investment performance, risk, attribution, and tax lots',
    description: 'Performs reproducible investment analysis for the portfolio, one account, or one ticker. It calculates balance change, simple return, time-weighted return, XIRR, drawdown, volatility, and optional benchmark relationships; it can also return position attribution and tax lots. Results include coverage and warnings when cash flows, benchmark prices, trades, or tax lots are missing, and the tool never labels balance growth as true performance without disclosing the limitation.',
    inputSchema: {
      scope_type: z.enum(['portfolio', 'account', 'ticker']).default('portfolio'),
      account_id: z.number().int().positive().optional(),
      ticker: z.string().max(40).optional(),
      start_date: date.optional(),
      end_date: date.optional(),
      benchmark_symbol: z.string().max(40).optional().describe('Stored benchmark symbol, preferably a total-return or adjusted-price series.'),
      include_attribution: z.boolean().default(false),
      include_tax_lots: z.boolean().default(false),
    },
  }, (input) => FinancialQueryService.analyzeInvestments({
    scopeType: input.scope_type,
    accountId: input.account_id,
    ticker: input.ticker,
    startDate: input.start_date,
    endDate: input.end_date,
    benchmarkSymbol: input.benchmark_symbol,
    includeAttribution: input.include_attribution,
    includeTaxLots: input.include_tax_lots,
  }));

  register(server, 'finance_analyze_cash_flow', {
    title: 'Analyze spending, income, savings, recurrence, and runway',
    description: 'Produces a comprehensive cash-flow analysis over a date range, including income, spending, savings rate, category and merchant drivers, recurring-charge candidates, large anomalies, liquid assets, and emergency runway. It joins transaction classifications, account liquidity, salary history, and recurring obligations where available. Warnings identify when essential-spending or classification coverage is insufficient for a reliable conclusion.',
    inputSchema: {
      start_date: date.optional(),
      end_date: date.optional(),
    },
  }, (input) => FinancialQueryService.analyzeCashFlow({ startDate: input.start_date, endDate: input.end_date }));

  register(server, 'finance_run_scenario', {
    title: 'Run an explicit financial scenario',
    description: 'Runs deterministic what-if calculations using caller-supplied assumptions and current financial state. Supported scenarios include goal projection, allocation change, expense reduction, income loss, and debt versus investment. The tool returns assumptions, year-by-year results, and caveats; it does not choose investments, invent expected returns, or present projections as predictions.',
    inputSchema: {
      scenario_type: z.enum(['goal_projection', 'allocation_change', 'expense_reduction', 'income_loss', 'debt_vs_invest']),
      horizon_years: z.number().positive().max(100).default(10),
      assumptions: z.record(z.string(), z.unknown()).default({}).describe('Explicit assumptions. Goal projections may include starting_value, monthly_contribution, target_value, and annual_return_scenarios. Allocation changes require current_allocation, proposed_allocation, and expected_annual_returns maps whose values are decimal rates or weights.'),
      start_date: date.optional(),
      end_date: date.optional(),
    },
  }, (input) => FinancialQueryService.runScenario({
    scenarioType: input.scenario_type,
    horizonYears: input.horizon_years,
    assumptions: input.assumptions,
    startDate: input.start_date,
    endDate: input.end_date,
  }));

  register(server, 'finance_get_data_health', {
    title: 'Assess financial data freshness and analytical coverage',
    description: 'Reports stale snapshots, stale prices, Plaid synchronization issues, missing prices, unclassified transactions, missing investment cash flows, absent benchmark history, and missing tax lots. Use this before high-stakes or historical analysis, or whenever another tool returns a coverage warning. It helps distinguish a real financial result from a data ingestion or classification problem.',
    inputSchema: {},
  }, () => FinancialQueryService.getDataHealth());

  register(server, 'finance_export_dataset', {
    title: 'Export a bounded financial dataset',
    description: 'Provides paginated raw records for unusual questions that cannot be answered by the semantic and analytical tools. It only exposes curated datasets and allowlisted columns; arbitrary SQL is never accepted. Prefer the other tools first because they return smaller, normalized, and financially meaningful results.',
    inputSchema: {
      dataset: z.enum(['positions', 'transactions', 'account_snapshots', 'holding_snapshots', 'salary_history', 'recurring_expenses', 'benchmark_prices', 'investment_cash_flows', 'tax_lots', 'debt_terms']),
      columns: z.array(z.string().max(100)).max(50).optional(),
      start_date: date.optional(),
      end_date: date.optional(),
      limit: z.number().int().min(1).max(1000).default(100),
      offset: z.number().int().min(0).default(0),
    },
  }, (input) => FinancialQueryService.exportDataset({
    dataset: input.dataset,
    columns: input.columns,
    startDate: input.start_date,
    endDate: input.end_date,
    limit: input.limit,
    offset: input.offset,
  }));

  return server;
}

module.exports = createFinancialMcpServer;
