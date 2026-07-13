import React, { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ArrowDownRight, ArrowUpRight, Eye, EyeOff, TrendingUp } from 'lucide-react';
import { useIsMobile } from '../hooks/useMediaQuery';
import { formatCompactCurrency, formatCurrency, formatDateAxis, formatDateDisplay, formatPercent } from '../utils/format';
import { CHART_COLORS, GRID_STYLE } from '../utils/chartTheme';
import ChartTooltip from './ChartTooltip';
import { getAccountDisplayName } from '../utils/accountDisplay';
import ResponsiveContainer from './ResponsiveContainer';

const PORTFOLIO_COLOR = '#3994BC';

const parseValue = (value) => parseFloat(value) || 0;

const getDateKey = (value) => String(value || '').split('T')[0];

const buildSeriesSummary = (series, chartData) => {
  const points = chartData
    .map((row) => ({ date: row.date, value: row[series.key] }))
    .filter((point) => Number.isFinite(point.value));

  if (points.length === 0) {
    return {
      ...series,
      points: 0,
      first: 0,
      last: 0,
      change: 0,
      percent: 0,
      high: 0,
      low: 0,
      startDate: null,
      endDate: null,
    };
  }

  const first = points[0].value;
  const last = points[points.length - 1].value;
  const values = points.map((point) => point.value);
  const change = last - first;
  const denominator = Math.abs(first);

  return {
    ...series,
    points: points.length,
    first,
    last,
    change,
    percent: denominator > 0 ? (change / denominator) * 100 : 0,
    high: Math.max(...values),
    low: Math.min(...values),
    startDate: points[0].date,
    endDate: points[points.length - 1].date,
  };
};

const AccountHistoryChart = ({
  accountData,
  portfolioData,
  accounts,
  selectedAccounts,
  showPortfolio,
  loading,
  error,
}) => {
  const isMobile = useIsMobile();
  const [hiddenSeries, setHiddenSeries] = useState([]);
  const [chartMode, setChartMode] = useState('change');

  const {
    chartData,
    displayData,
    seriesSummaries,
    dateRangeLabel,
    mainSummary,
    bestMover,
    worstMover,
  } = useMemo(() => {
    const accountMap = new Map(accounts.map((account) => [account.id, account]));
    const selectedSet = new Set(selectedAccounts);
    const selectedAccountSeries = accounts
      .filter((account) => selectedSet.has(account.id))
      .map((account, index) => ({
        key: `account_${account.id}`,
        accountId: account.id,
        name: getAccountDisplayName(account),
        type: account.type,
        color: CHART_COLORS[index % CHART_COLORS.length],
        isPortfolio: false,
      }));

    const series = [
      ...(showPortfolio
        ? [{
          key: 'portfolio',
          name: 'Total Portfolio',
          color: PORTFOLIO_COLOR,
          isPortfolio: true,
        }]
        : []),
      ...selectedAccountSeries,
    ];

    const dateMap = {};

    if (Array.isArray(portfolioData) && showPortfolio) {
      portfolioData.forEach((item) => {
        const date = getDateKey(item.snapshot_date);
        if (!date) return;
        if (!dateMap[date]) dateMap[date] = { date };
        dateMap[date].portfolio = parseValue(item.total_value);
      });
    }

    if (Array.isArray(accountData) && selectedAccounts.length > 0) {
      accountData.forEach((item) => {
        if (!selectedSet.has(item.account_id)) return;
        const date = getDateKey(item.snapshot_date);
        if (!date) return;
        const account = accountMap.get(item.account_id);
        if (!account) return;
        if (!dateMap[date]) dateMap[date] = { date };
        dateMap[date][`account_${item.account_id}`] = parseValue(item.total_value);
      });
    }

    const rows = Object.values(dateMap).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const summaries = series.map((item) => buildSeriesSummary(item, rows));
    const summaryMap = new Map(summaries.map((summary) => [summary.key, summary]));

    const renderedRows = rows.map((row) => {
      const next = { date: row.date };
      summaries.forEach((summary) => {
        const value = row[summary.key];
        if (!Number.isFinite(value)) return;
        if (chartMode === 'change') {
          const denominator = Math.abs(summary.first);
          next[summary.key] = denominator > 0 ? ((value - summary.first) / denominator) * 100 : null;
        } else {
          next[summary.key] = value;
        }
      });
      return next;
    });

    const accountSummaries = summaries.filter((summary) => !summary.isPortfolio && summary.points > 0);
    const sortedMovers = [...accountSummaries].sort((a, b) => b.change - a.change);
    const portfolioSummary = summaryMap.get('portfolio');
    const primary = portfolioSummary?.points > 0
      ? portfolioSummary
      : summaries.find((summary) => summary.points > 0);
    const firstDate = rows[0]?.date;
    const lastDate = rows[rows.length - 1]?.date;

    return {
      chartData: rows,
      displayData: renderedRows,
      seriesSummaries: summaries,
      dateRangeLabel: firstDate && lastDate ? `${formatDateDisplay(firstDate)} to ${formatDateDisplay(lastDate)}` : 'No dated snapshots',
      mainSummary: primary || null,
      bestMover: sortedMovers[0] || null,
      worstMover: sortedMovers[sortedMovers.length - 1] || null,
    };
  }, [accountData, portfolioData, accounts, selectedAccounts, showPortfolio, chartMode]);

  useEffect(() => {
    const validKeys = new Set(seriesSummaries.map((series) => series.key));
    setHiddenSeries((prev) => prev.filter((key) => validKeys.has(key)));
  }, [seriesSummaries]);

  const toggleSeries = (key) => {
    setHiddenSeries((prev) => (
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]
    ));
  };

  const emptyContainer = (children) => (
    <div className="card flex h-72 items-center justify-center md:h-96">
      <div className="px-4 text-center text-body-sm text-secondary">{children}</div>
    </div>
  );

  if (loading) return emptyContainer('Loading account history...');
  if (error) {
    return (
      <div className="card flex h-72 items-center justify-center md:h-96">
        <div className="px-4 text-center text-body-sm text-loss">{error}</div>
      </div>
    );
  }
  if (selectedAccounts.length === 0 && !showPortfolio) {
    return emptyContainer('Choose at least one account or enable Total Portfolio.');
  }
  if (chartData.length === 0) {
    return emptyContainer('No account snapshots match this setup.');
  }

  const visibleSummaries = seriesSummaries.filter((series) => series.points > 0);
  const activeSeries = visibleSummaries.filter((series) => !hiddenSeries.includes(series.key));
  const activeSeriesCount = activeSeries.length;
  const bestMoverLabel = bestMover ? (bestMover.change >= 0 ? 'Largest Account Gain' : 'Smallest Account Drop') : 'Largest Account Gain';
  const worstMoverLabel = worstMover ? (worstMover.change < 0 ? 'Largest Account Drop' : 'Smallest Account Gain') : 'Largest Account Drop';
  const formatChartValue = chartMode === 'change'
    ? (value) => formatPercent(value, 1)
    : (value) => formatCompactCurrency(value);
  const axisStyle = {
    stroke: 'var(--text-secondary)',
    fontSize: 13,
    tickLine: false,
    axisLine: { stroke: 'var(--border)' },
  };

  return (
    <section className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="card min-w-0 overflow-hidden p-3 sm:p-4 md:p-5">
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-accent">
              <TrendingUp size={17} />
              <span className="text-caption-upper uppercase">History Chart</span>
            </div>
            <h2 className="text-title-md text-primary">
              {chartMode === 'change' ? 'Percent Change Since Start' : 'Account Values Over Time'}
            </h2>
            <p className="mt-1 text-body-sm text-secondary">{dateRangeLabel}</p>
          </div>

          <div className="flex w-fit rounded border border-border bg-surface-2 p-1">
            {[
              { id: 'value', label: 'Value' },
              { id: 'change', label: 'Change %' },
            ].map((mode) => (
              <button
                key={mode.id}
                type="button"
                onClick={() => setChartMode(mode.id)}
                className={`rounded px-3 py-2 text-caption-upper uppercase transition-colors ${
                  chartMode === mode.id
                    ? 'bg-accent/20 text-accent'
                    : 'text-secondary hover:bg-surface-3 hover:text-primary'
                }`}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </div>

        <div className="h-[300px] min-w-0 w-full overflow-hidden sm:h-[360px] md:h-[480px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={displayData}
              margin={{ top: 12, right: isMobile ? 8 : 20, left: isMobile ? 0 : 8, bottom: 10 }}
            >
              <CartesianGrid {...GRID_STYLE} vertical={false} strokeOpacity={0.65} />
              <XAxis
                dataKey="date"
                tickFormatter={formatDateAxis}
                {...axisStyle}
                padding={{ left: 10, right: 10 }}
                minTickGap={isMobile ? 48 : 32}
              />
              <YAxis
                tickFormatter={formatChartValue}
                {...axisStyle}
                width={isMobile ? 58 : 78}
                axisLine={false}
              />
              <Tooltip
                content={
                  <ChartTooltip
                    formatValue={(value) => (
                      chartMode === 'change'
                        ? formatPercent(value, 1)
                        : formatCurrency(value)
                    )}
                    formatLabel={formatDateAxis}
                  />
                }
                cursor={{ stroke: 'var(--text-secondary)', strokeWidth: 1, strokeOpacity: 0.5 }}
              />
              {visibleSummaries.map((series) => (
                <Line
                  key={series.key}
                  type="monotone"
                  dataKey={series.key}
                  name={series.name}
                  stroke={series.color}
                  strokeWidth={series.isPortfolio ? 3 : 2.25}
                  dot={false}
                  activeDot={{ r: series.isPortfolio ? 5 : 4, strokeWidth: 0, fill: series.color }}
                  connectNulls
                  hide={hiddenSeries.includes(series.key)}
                  animationDuration={750}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="mt-3 flex min-w-0 flex-col gap-1 border-t border-border pt-3 text-caption text-secondary sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-2">
          <span>{activeSeriesCount} visible series</span>
          <span className="min-w-0 leading-relaxed">{chartMode === 'change' ? 'Change view normalizes each line to its own starting value.' : 'Value view shows actual dollar balances.'}</span>
        </div>
      </div>

      <aside className="min-w-0 space-y-4">
        <div className="card p-4">
          <h3 className="text-caption-upper uppercase text-primary">Period Summary</h3>
          <div className="mt-4 space-y-4">
            <SummaryRow
              label={mainSummary?.isPortfolio ? 'Portfolio Ending Value' : 'Ending Value'}
              value={mainSummary ? formatCurrency(mainSummary.last) : '--'}
              change={mainSummary ? `${formatCurrency(mainSummary.change)} (${formatPercent(mainSummary.percent, 1)})` : '--'}
              positive={mainSummary ? mainSummary.change >= 0 : true}
            />
            <SummaryRow
              label={bestMoverLabel}
              value={bestMover?.name || '--'}
              change={bestMover ? `${formatCurrency(bestMover.change)} (${formatPercent(bestMover.percent, 1)})` : '--'}
              positive={bestMover ? bestMover.change >= 0 : true}
            />
            <SummaryRow
              label={worstMoverLabel}
              value={worstMover?.name || '--'}
              change={worstMover ? `${formatCurrency(worstMover.change)} (${formatPercent(worstMover.percent, 1)})` : '--'}
              positive={worstMover ? worstMover.change >= 0 : true}
            />
          </div>
        </div>

        <div className="card overflow-hidden">
          <div className="border-b border-border p-4">
            <h3 className="text-caption-upper uppercase text-primary">Visible Series</h3>
            <p className="mt-1 text-caption text-secondary">{activeSeriesCount} active lines in this view.</p>
          </div>
          <div className="max-h-[520px] divide-y divide-border overflow-y-auto">
            {visibleSummaries.map((series) => {
              const hidden = hiddenSeries.includes(series.key);
              return (
                <button
                  key={series.key}
                  type="button"
                  onClick={() => toggleSeries(series.key)}
                  className={`flex w-full items-start justify-between gap-3 p-4 text-left transition-colors hover:bg-surface-2 ${
                    hidden ? 'opacity-50' : ''
                  }`}
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: series.color }} />
                      <span className="truncate text-body-sm font-semibold text-primary">{series.name}</span>
                    </span>
                    <span className="mt-1 block text-caption text-secondary">
                      {formatCurrency(series.change)} ({formatPercent(series.percent, 1)}) over {series.points} snapshots
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block font-money text-body-sm font-semibold text-primary">{formatCompactCurrency(series.last)}</span>
                    {hidden ? <EyeOff size={15} className="ml-auto mt-1 text-secondary" /> : <Eye size={15} className="ml-auto mt-1 text-accent" />}
                  </span>
                </button>
              );
            })}
            {visibleSummaries.length === 0 && (
              <div className="p-4 text-body-sm text-secondary">No visible account series.</div>
            )}
          </div>
        </div>
      </aside>
    </section>
  );
};

const SummaryRow = ({ label, value, change, positive }) => {
  const Icon = positive ? ArrowUpRight : ArrowDownRight;
  return (
    <div className="min-w-0">
      <p className="text-caption-upper uppercase text-secondary">{label}</p>
      <p className="mt-1 break-words text-body-sm font-semibold text-primary" title={String(value)}>{value}</p>
      <p className={`mt-1 flex min-w-0 items-start gap-1 text-caption font-semibold ${positive ? 'text-gain' : 'text-loss'}`}>
        <Icon size={14} className="mt-0.5 shrink-0" />
        <span className="min-w-0 break-words">{change}</span>
      </p>
    </div>
  );
};

export default AccountHistoryChart;
