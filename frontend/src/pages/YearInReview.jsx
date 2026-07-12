import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ReferenceLine, LabelList,
  AreaChart, Area,
} from 'recharts';
import { CalendarDays, TrendingUp, TrendingDown, Award, Target } from 'lucide-react';
import MetricCard from '../components/MetricCard';
import AllocationDonut from '../components/AllocationDonut';
import ChartTooltip from '../components/ChartTooltip';
import ResponsiveContainer from '../components/ResponsiveContainer';
import { GRID_STYLE, AXIS_STYLE, areaGradient } from '../utils/chartTheme';
import { formatCurrency, formatCompactCurrency, formatPercent, formatDateAxis } from '../utils/format';
import { analytics, dashboard, history as historyAPI } from '../utils/api';
import { useIsMobile } from '../hooks/useMediaQuery';
import useChartPreferences from '../hooks/useChartPreferences';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function buildMonthlyChartData(monthlyData) {
  return monthlyData.map((d) => {
    const monthIdx = new Date(d.month).getUTCMonth();
    return {
      month: MONTHS[monthIdx],
      change: parseFloat(d.change) || 0,
      end_value: parseFloat(d.end_value) || 0,
      change_percent: parseFloat(d.change_percent) || 0,
    };
  });
}

function calculateYearMetrics(chartData) {
  if (chartData.length === 0) return { startNW: 0, endNW: 0, growth: 0, growthPct: 0, bestMonth: null, worstMonth: null };
  const first = chartData[0];
  const last = chartData[chartData.length - 1];
  const startNW = first.end_value - (first.change || 0);
  const endNW = last.end_value;
  const growth = endNW - startNW;
  const growthPct = startNW > 0 ? (growth / startNW) * 100 : 0;
  const sorted = [...chartData].filter((d) => d.change !== null && d.change !== 0).sort((a, b) => b.change - a.change);
  const bestMonth = sorted[0] || null;
  const worstMonth = sorted[sorted.length - 1] || null;
  return { startNW, endNW, growth, growthPct, bestMonth, worstMonth };
}

function calculateSpendingMetrics(rows) {
  let totalIncome = 0, totalSpending = 0;
  for (const d of rows) {
    totalIncome += parseFloat(d.income) || 0;
    totalSpending += parseFloat(d.spending) || 0;
  }
  const savingsRate = totalIncome > 0 ? ((totalIncome - totalSpending) / totalIncome) * 100 : 0;
  return { totalIncome, totalSpending, savingsRate };
}

function getMonthIndex(row) {
  if (!row) return -1;
  if (row.month && MONTHS.includes(row.month)) return MONTHS.indexOf(row.month);
  return new Date(row.month).getUTCMonth();
}

function formatMonthSpan(chartData) {
  if (chartData.length === 0) return 'No months available';
  const first = chartData[0].month;
  const last = chartData[chartData.length - 1].month;
  return first === last ? first : `${first} - ${last}`;
}

function SwingLabel({ x, y, width, value, payload }) {
  if (!value) return null;
  const isPositive = (payload?.change || 0) >= 0;
  return (
    <text
      x={x + width / 2}
      y={isPositive ? y - 6 : y + 14}
      textAnchor="middle"
      fill="var(--text-secondary)"
      fontSize={10}
    >
      {value}
    </text>
  );
}

export default function YearInReview() {
  const isMobile = useIsMobile();
  const { preferences: chartPreferences } = useChartPreferences();
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [loading, setLoading] = useState(true);
  const [monthlyData, setMonthlyData] = useState([]);
  const [priorMonthlyData, setPriorMonthlyData] = useState([]);
  const [ivsData, setIvsData] = useState([]);
  const [priorIvsData, setPriorIvsData] = useState([]);
  const [portfolioItems, setPortfolioItems] = useState([]);
  const [portfolioHistory, setPortfolioHistory] = useState([]);
  const [tickerStart, setTickerStart] = useState([]);
  const [tickerEnd, setTickerEnd] = useState([]);

  const availableYears = useMemo(() => {
    const years = [];
    for (let y = currentYear; y >= currentYear - 5; y--) years.push(y);
    return years;
  }, [currentYear]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const startDate = `${selectedYear}-01-01`;
      const endDate = `${selectedYear}-12-31`;
      const priorYear = selectedYear - 1;
      const priorStartDate = `${priorYear}-01-01`;
      const priorEndDate = `${priorYear}-12-31`;

      const [monthly, priorMonthly, ivs, priorIvs, dash, portfolio, tStart, tEnd] = await Promise.all([
        analytics.getNetWorthMonthly({ year: selectedYear }),
        analytics.getNetWorthMonthly({ year: priorYear }).catch(() => ({ data: [] })),
        analytics.getIncomeVsSpending({ startDate, endDate }),
        analytics.getIncomeVsSpending({ startDate: priorStartDate, endDate: priorEndDate }).catch(() => ({ data: [] })),
        dashboard.getPortfolio(),
        historyAPI.getPortfolio({ startDate, endDate, limit: 10000 }),
        historyAPI.getTickers({ startDate, endDate: `${selectedYear}-01-31`, limit: 10000 }),
        historyAPI.getTickers({ startDate: `${selectedYear}-12-01`, endDate, limit: 10000 }),
      ]);

      setMonthlyData(monthly.data || []);
      setPriorMonthlyData(priorMonthly.data || []);
      setIvsData(ivs.data || []);
      setPriorIvsData(priorIvs.data || []);
      setPortfolioItems(dash.items || []);
      setPortfolioHistory(portfolio.data || []);
      setTickerStart(tStart.data || []);
      setTickerEnd(tEnd.data || []);
    } catch (err) {
      console.error('Failed to load year in review data:', err);
    } finally {
      setLoading(false);
    }
  }, [selectedYear]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const chartData = useMemo(() => buildMonthlyChartData(monthlyData), [monthlyData]);
  const priorChartData = useMemo(() => buildMonthlyChartData(priorMonthlyData), [priorMonthlyData]);
  const lastVisibleMonthIndex = useMemo(() => getMonthIndex(chartData[chartData.length - 1]), [chartData]);
  const isPartialYear = selectedYear === currentYear && chartData.length > 0 && chartData.length < 12;
  const periodLabel = isPartialYear ? `${selectedYear} YTD` : `${selectedYear}`;
  const monthSpanLabel = formatMonthSpan(chartData);
  const missingMonths = chartData.length > 0 ? Math.max(12 - chartData.length, 0) : 0;

  const comparablePriorChartData = useMemo(() => {
    if (lastVisibleMonthIndex < 0) return priorChartData;
    return priorChartData.filter((row) => getMonthIndex(row) <= lastVisibleMonthIndex);
  }, [lastVisibleMonthIndex, priorChartData]);

  const comparablePriorIvsData = useMemo(() => {
    if (lastVisibleMonthIndex < 0) return priorIvsData;
    return priorIvsData.filter((row) => getMonthIndex(row) <= lastVisibleMonthIndex);
  }, [lastVisibleMonthIndex, priorIvsData]);

  const yearMetrics = useMemo(() => calculateYearMetrics(chartData), [chartData]);
  const priorYearMetrics = useMemo(() => calculateYearMetrics(comparablePriorChartData), [comparablePriorChartData]);

  const spendingMetrics = useMemo(() => calculateSpendingMetrics(ivsData), [ivsData]);
  const priorSpendingMetrics = useMemo(() => calculateSpendingMetrics(comparablePriorIvsData), [comparablePriorIvsData]);

  const comparisonMetrics = useMemo(() => ({
    growthDelta: yearMetrics.growth - priorYearMetrics.growth,
    savingsRateDelta: spendingMetrics.savingsRate - priorSpendingMetrics.savingsRate,
    incomeDelta: spendingMetrics.totalIncome - priorSpendingMetrics.totalIncome,
    spendingDelta: spendingMetrics.totalSpending - priorSpendingMetrics.totalSpending,
  }), [yearMetrics, priorYearMetrics, spendingMetrics, priorSpendingMetrics]);

  const narrative = useMemo(() => {
    if (chartData.length === 0) return `No ${selectedYear} net worth history is available yet.`;
    const direction = yearMetrics.growth >= 0 ? 'grew' : 'fell';
    const bestMonth = yearMetrics.bestMonth ? `${yearMetrics.bestMonth.month} added ${formatCurrency(yearMetrics.bestMonth.change)}` : 'No positive month stood out';
    const worstMonth = yearMetrics.worstMonth ? `${yearMetrics.worstMonth.month} moved ${formatCurrency(yearMetrics.worstMonth.change)}` : 'No negative month stood out';
    const valuePhrase = isPartialYear ? `latest value is ${formatCurrency(yearMetrics.endNW)}` : `ending at ${formatCurrency(yearMetrics.endNW)}`;
    return `${periodLabel} ${direction} by ${formatCurrency(Math.abs(yearMetrics.growth))}; ${valuePhrase}. ${bestMonth}; ${worstMonth}. Savings rate is ${formatPercent(spendingMetrics.savingsRate, 1)}.`;
  }, [chartData, isPartialYear, periodLabel, yearMetrics, spendingMetrics, selectedYear]);

  const annotatedChartData = useMemo(() =>
    chartData.map((row) => {
      const isBest = yearMetrics.bestMonth && row.month === yearMetrics.bestMonth.month;
      const isWorst = yearMetrics.worstMonth && row.month === yearMetrics.worstMonth.month;
      return {
        ...row,
        swingLabel: isBest ? 'Largest gain' : isWorst ? 'Largest drop' : '',
      };
    }),
  [chartData, yearMetrics]);

  const performers = useMemo(() => {
    if (tickerStart.length === 0 || tickerEnd.length === 0) return { gainers: [], losers: [] };

    const startMap = {};
    for (const s of tickerStart) {
      const key = s.ticker || s.name;
      if (!startMap[key]) startMap[key] = parseFloat(s.value);
    }

    const endMap = {};
    for (const s of tickerEnd) {
      const key = s.ticker || s.name;
      if (!endMap[key] || parseFloat(s.value) > endMap[key]) {
        endMap[key] = parseFloat(s.value);
      }
    }

    const deltas = Object.keys(endMap)
      .filter((k) => startMap[k] !== undefined)
      .map((k) => ({ name: k, delta: endMap[k] - startMap[k], endValue: endMap[k] }))
      .sort((a, b) => b.delta - a.delta);

    return {
      gainers: deltas.filter((d) => d.delta > 0).slice(0, 5),
      losers: deltas.filter((d) => d.delta < 0).slice(-5).reverse(),
    };
  }, [tickerStart, tickerEnd]);

  const sparklineData = useMemo(() =>
    portfolioHistory.map((d) => ({
      date: d.snapshot_date,
      value: parseFloat(d.total_value),
    })),
  [portfolioHistory]);

  const cumulativeGrowthData = useMemo(() => {
    return chartData.map((row, index) => ({
      month: row.month,
      cumulative: chartData
        .slice(0, index + 1)
        .reduce((sum, item) => sum + item.change, 0),
    }));
  }, [chartData]);

  const monthlyCashFlowData = useMemo(() => ivsData.map((row) => ({
    month: MONTHS[new Date(row.month).getUTCMonth()],
    income: parseFloat(row.income) || 0,
    spending: parseFloat(row.spending) || 0,
  })), [ivsData]);

  const visibleChartLinks = useMemo(() => [
    chartPreferences.monthlyChange && ['Monthly swings', '#monthly-change'],
    chartPreferences.cumulativeGrowth && ['Cumulative growth', '#cumulative-growth'],
    chartPreferences.trajectory && ['Trajectory', '#trajectory'],
    chartPreferences.allocation && ['Allocation', '#allocation'],
    chartPreferences.monthlyCashFlow && ['Monthly cash flow', '#monthly-cash-flow'],
    chartPreferences.cashFlow && ['Cash flow', '#cash-flow'],
  ].filter(Boolean), [chartPreferences]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        <span className="text-xs font-bold tracking-wide uppercase text-tertiary ">Compiling Year in Review</span>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 md:py-8 max-w-[1600px] space-y-8">
      {/* Hero */}
      <div className="sticky top-0 z-20 -mx-4 px-4 py-3 bg-base border-b border-border flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl md:text-5xl font-bold text-primary tracking-tighter">Year in Review</h1>
          <p className="text-sm text-secondary mt-1">{periodLabel} financial performance summary</p>
        </div>
        <div className="flex bg-surface-2 rounded border border-border p-1 gap-1">
          {availableYears.map((y) => (
            <button
              key={y}
              onClick={() => setSelectedYear(y)}
              className={`px-3 py-1.5 rounded text-xs font-bold tracking-wider transition-all ${
                selectedYear === y ? 'bg-accent/15 text-accent' : 'text-tertiary hover:text-secondary'
              }`}
            >
              {y}
            </button>
          ))}
        </div>
      </div>

      {/* Narrative Summary */}
      <div className="card p-4 md:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-caption text-tertiary uppercase tracking-wide mb-1">{periodLabel} Summary</p>
            <p className="text-body-md text-primary max-w-4xl">{narrative}</p>
            {isPartialYear && (
              <p className="text-caption text-accent mt-2">
                Partial-year view: showing {monthSpanLabel}; {missingMonths} future month{missingMonths === 1 ? '' : 's'} will appear as data arrives.
              </p>
            )}
          </div>
          <div className="grid w-full min-w-0 grid-cols-2 gap-2 sm:w-auto">
            <div className="border border-border bg-surface-2 p-2">
              <p className="text-caption text-tertiary uppercase">Best</p>
              <p className="text-body-sm font-semibold text-gain">{yearMetrics.bestMonth ? yearMetrics.bestMonth.month : '--'}</p>
            </div>
            <div className="border border-border bg-surface-2 p-2">
              <p className="text-caption text-tertiary uppercase">Worst</p>
              <p className="text-body-sm font-semibold text-loss">{yearMetrics.worstMonth ? yearMetrics.worstMonth.month : '--'}</p>
            </div>
            <div className="border border-border bg-surface-2 p-2">
              <p className="text-caption text-tertiary uppercase">Income</p>
              <p className="text-body-sm font-semibold text-gain">{formatCurrency(spendingMetrics.totalIncome)}</p>
            </div>
            <div className="border border-border bg-surface-2 p-2">
              <p className="text-caption text-tertiary uppercase">Spend</p>
              <p className="text-body-sm font-semibold text-loss">{formatCurrency(spendingMetrics.totalSpending)}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Starting Net Worth"
          value={formatCurrency(yearMetrics.startNW)}
          icon={Target}
          caption={`${monthSpanLabel} opening value`}
        />
        <MetricCard
          label={isPartialYear ? 'Latest Net Worth' : 'Ending Net Worth'}
          value={formatCurrency(yearMetrics.endNW)}
          icon={Award}
          valueColor="accent"
          caption={isPartialYear ? `${periodLabel} latest value` : 'Year-end value'}
        />
        <MetricCard
          label={isPartialYear ? 'YTD Growth' : 'Total Growth'}
          value={formatCurrency(yearMetrics.growth)}
          change={formatPercent(yearMetrics.growthPct, 1)}
          trend={yearMetrics.growth >= 0 ? 'up' : 'down'}
          icon={yearMetrics.growth >= 0 ? TrendingUp : TrendingDown}
          valueColor={yearMetrics.growth >= 0 ? 'gain' : 'loss'}
          caption={`vs ${selectedYear - 1} same months: ${formatCurrency(comparisonMetrics.growthDelta)}`}
        />
        <MetricCard
          label="Savings Rate"
          value={formatPercent(spendingMetrics.savingsRate, 1)}
          icon={CalendarDays}
          valueColor={spendingMetrics.savingsRate >= 0 ? 'gain' : 'loss'}
          caption={`vs ${selectedYear - 1} same months: ${formatPercent(comparisonMetrics.savingsRateDelta, 1)}`}
        />
      </div>

      {/* Prior Year Comparison */}
      <div className="grid md:grid-cols-4 gap-3">
        <div className="border border-border bg-surface p-3">
          <p className="text-caption text-tertiary uppercase tracking-wide">Growth vs {selectedYear - 1}</p>
          <p className={`font-mono text-lg font-semibold ${comparisonMetrics.growthDelta >= 0 ? 'text-gain' : 'text-loss'}`}>{formatCurrency(comparisonMetrics.growthDelta)}</p>
          <p className="text-caption text-tertiary">Same months prior growth {formatCurrency(priorYearMetrics.growth)}</p>
        </div>
        <div className="border border-border bg-surface p-3">
          <p className="text-caption text-tertiary uppercase tracking-wide">Savings Rate Delta</p>
          <p className={`font-mono text-lg font-semibold ${comparisonMetrics.savingsRateDelta >= 0 ? 'text-gain' : 'text-loss'}`}>{formatPercent(comparisonMetrics.savingsRateDelta, 1)}</p>
          <p className="text-caption text-tertiary">Same months prior rate {formatPercent(priorSpendingMetrics.savingsRate, 1)}</p>
        </div>
        <div className="border border-border bg-surface p-3">
          <p className="text-caption text-tertiary uppercase tracking-wide">Income Delta</p>
          <p className={`font-mono text-lg font-semibold ${comparisonMetrics.incomeDelta >= 0 ? 'text-gain' : 'text-loss'}`}>{formatCurrency(comparisonMetrics.incomeDelta)}</p>
          <p className="text-caption text-tertiary">Same months prior income {formatCurrency(priorSpendingMetrics.totalIncome)}</p>
        </div>
        <div className="border border-border bg-surface p-3">
          <p className="text-caption text-tertiary uppercase tracking-wide">Spend Delta</p>
          <p className={`font-mono text-lg font-semibold ${comparisonMetrics.spendingDelta <= 0 ? 'text-gain' : 'text-loss'}`}>{formatCurrency(comparisonMetrics.spendingDelta)}</p>
          <p className="text-caption text-tertiary">Same months prior spend {formatCurrency(priorSpendingMetrics.totalSpending)}</p>
        </div>
      </div>

      {visibleChartLinks.length > 0 && (
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {visibleChartLinks.map(([label, href]) => (
          <a
            key={href}
            href={href}
            className="border border-border bg-surface px-3 py-2 text-caption font-bold uppercase tracking-wide text-secondary transition-colors hover:border-accent/40 hover:text-primary"
          >
            {label}
          </a>
        ))}
      </div>
      )}

      {/* Monthly Net Worth Change Bar Chart */}
      {chartPreferences.monthlyChange && (
      <div id="monthly-change" className="card p-4 md:p-6 scroll-mt-24">
        <div className="flex flex-col gap-2 mb-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="text-[10px] font-bold tracking-wide uppercase text-tertiary">Monthly Net Worth Change</h2>
            <p className="text-caption text-tertiary">
              {yearMetrics.bestMonth ? `Best: ${yearMetrics.bestMonth.month} ${formatCurrency(yearMetrics.bestMonth.change)}` : 'Best: --'}
              {' / '}
              {yearMetrics.worstMonth ? `Worst: ${yearMetrics.worstMonth.month} ${formatCurrency(yearMetrics.worstMonth.change)}` : 'Worst: --'}
            </p>
          </div>
          <p className="text-caption text-secondary">
            {periodLabel} / {monthSpanLabel}
            {isPartialYear ? ` / ${missingMonths} months pending` : ''}
          </p>
        </div>
        <div style={{ height: isMobile ? 280 : 380 }}>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={annotatedChartData} margin={{ top: 24, right: 10, left: isMobile ? 0 : 10, bottom: 5 }}>
                <CartesianGrid {...GRID_STYLE} vertical={false} />
                <XAxis dataKey="month" {...AXIS_STYLE} />
                <YAxis {...AXIS_STYLE} tickFormatter={formatCompactCurrency} width={isMobile ? 45 : 60} />
                <Tooltip
                  content={<ChartTooltip formatValue={(v) => formatCurrency(v)} />}
                  cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                />
                <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="3 3" />
                <Bar dataKey="change" radius={[4, 4, 0, 0]} animationDuration={800} name="Change">
                  <LabelList dataKey="swingLabel" content={<SwingLabel />} />
                  {annotatedChartData.map((entry, i) => (
                    <Cell key={i} fill={entry.change >= 0 ? 'var(--gain)' : 'var(--loss)'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-tertiary text-sm">No data for {selectedYear}</div>
          )}
        </div>
      </div>
      )}

      {chartPreferences.cumulativeGrowth && (
        <div id="cumulative-growth" className="card scroll-mt-24 p-4 md:p-6">
          <div className="mb-4 flex flex-col gap-1 md:flex-row md:items-end md:justify-between">
            <div>
              <h2 className="text-[10px] font-bold uppercase tracking-wide text-tertiary">Cumulative Growth</h2>
              <p className="text-caption text-tertiary">Running net worth change from the start of {selectedYear}.</p>
            </div>
            <p className={`value-emphasis ${yearMetrics.growth >= 0 ? 'text-gain' : 'text-loss'}`}>
              {formatCurrency(yearMetrics.growth)}
            </p>
          </div>
          <div style={{ height: isMobile ? 220 : 300 }}>
            {cumulativeGrowthData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={cumulativeGrowthData} margin={{ top: 8, right: 10, left: 0, bottom: 5 }}>
                  <defs>{areaGradient('cumulativeGrowth', yearMetrics.growth >= 0 ? '#72C892' : '#f48771')}</defs>
                  <CartesianGrid {...GRID_STYLE} vertical={false} />
                  <XAxis dataKey="month" {...AXIS_STYLE} />
                  <YAxis {...AXIS_STYLE} tickFormatter={formatCompactCurrency} width={isMobile ? 45 : 60} />
                  <Tooltip content={<ChartTooltip formatValue={formatCurrency} />} cursor={{ stroke: 'var(--border)', strokeWidth: 1 }} />
                  <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="3 3" />
                  <Area type="monotone" dataKey="cumulative" stroke={yearMetrics.growth >= 0 ? 'var(--gain)' : 'var(--loss)'} strokeWidth={2} fill="url(#cumulativeGrowth)" name="Cumulative Growth" animationDuration={900} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-tertiary">No growth history for {selectedYear}</div>
            )}
          </div>
        </div>
      )}

      {/* Mini Charts Row */}
      {(chartPreferences.trajectory || chartPreferences.allocation) && (
      <div className="grid lg:grid-cols-2 gap-6">
        {/* Net Worth Trajectory */}
        {chartPreferences.trajectory && (
        <div id="trajectory" className="card p-4 md:p-6 scroll-mt-24">
          <h2 className="text-[10px] font-bold tracking-wide uppercase text-tertiary mb-4">Net Worth Trajectory</h2>
          <div style={{ height: isMobile ? 180 : 220 }}>
            {sparklineData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={sparklineData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                  <defs>{areaGradient('yearSparkline', '#00FFCC')}</defs>
                  <CartesianGrid {...GRID_STYLE} vertical={false} strokeOpacity={0.3} />
                  <XAxis dataKey="date" {...AXIS_STYLE} tickFormatter={formatDateAxis} />
                  <YAxis {...AXIS_STYLE} tickFormatter={formatCompactCurrency} width={isMobile ? 45 : 55} />
                  <Tooltip content={<ChartTooltip formatValue={formatCurrency} formatLabel={formatDateAxis} />} cursor={{ stroke: 'var(--border)', strokeWidth: 1 }} />
                  <Area type="monotone" dataKey="value" stroke="#00FFCC" strokeWidth={2} fill="url(#yearSparkline)" name="Net Worth" animationDuration={1000} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-tertiary text-sm">No data</div>
            )}
          </div>
        </div>
        )}

        {/* Year-End Allocation */}
        {chartPreferences.allocation && (
        <div id="allocation" className="card p-4 md:p-6 scroll-mt-24">
          <h2 className="text-[10px] font-bold tracking-wide uppercase text-tertiary mb-4">{isPartialYear ? 'Latest Allocation' : 'Year-End Allocation'}</h2>
          <div style={{ height: isMobile ? 180 : 220 }}>
            {portfolioItems.length > 0 ? (
              <AllocationDonut items={portfolioItems} />
            ) : (
              <div className="flex items-center justify-center h-full text-tertiary text-sm">No data</div>
            )}
          </div>
        </div>
        )}
      </div>
      )}

      {/* Best/Worst Months */}
      <div className="grid lg:grid-cols-2 gap-6">
        <div className="card p-4 md:p-6">
          <h2 className="text-[10px] font-bold tracking-wide uppercase text-tertiary mb-3">Best Month</h2>
          {yearMetrics.bestMonth ? (
            <div className="flex items-center gap-3">
              <div className="p-3 rounded bg-gain/10 text-gain"><TrendingUp size={20} /></div>
              <div>
                <p className="text-lg font-money font-bold text-gain">{formatCurrency(yearMetrics.bestMonth.change)}</p>
                <p className="text-xs text-secondary">{yearMetrics.bestMonth.month} {selectedYear}</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-tertiary">No data</p>
          )}
        </div>
        <div className="card p-4 md:p-6">
          <h2 className="text-[10px] font-bold tracking-wide uppercase text-tertiary mb-3">Worst Month</h2>
          {yearMetrics.worstMonth ? (
            <div className="flex items-center gap-3">
              <div className="p-3 rounded bg-loss/10 text-loss"><TrendingDown size={20} /></div>
              <div>
                <p className="text-lg font-money font-bold text-loss">{formatCurrency(yearMetrics.worstMonth.change)}</p>
                <p className="text-xs text-secondary">{yearMetrics.worstMonth.month} {selectedYear}</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-tertiary">No data</p>
          )}
        </div>
      </div>

      {/* Top Performers / Biggest Losers */}
      {(performers.gainers.length > 0 || performers.losers.length > 0) && (
        <div className="grid lg:grid-cols-2 gap-6">
          {performers.gainers.length > 0 && (
            <div className="card overflow-hidden">
              <div className="p-4 border-b border-border ">
                <span className="text-[10px] font-bold tracking-wide uppercase text-gain">Top Gainers</span>
              </div>
              <div className="divide-y divide-border">
                {performers.gainers.map((p, i) => (
                  <div key={p.name} className="flex items-center justify-between px-5 py-3">
                    <div className="flex items-center gap-3">
                      <span className="text-[10px] font-bold text-tertiary w-4">{i + 1}</span>
                      <span className="text-sm font-bold text-primary">{p.name}</span>
                    </div>
                    <span className="text-sm font-money font-bold text-gain">+{formatCurrency(p.delta)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {performers.losers.length > 0 && (
            <div className="card overflow-hidden">
              <div className="p-4 border-b border-border ">
                <span className="text-[10px] font-bold tracking-wide uppercase text-loss">Biggest Losers</span>
              </div>
              <div className="divide-y divide-border">
                {performers.losers.map((p, i) => (
                  <div key={p.name} className="flex items-center justify-between px-5 py-3">
                    <div className="flex items-center gap-3">
                      <span className="text-[10px] font-bold text-tertiary w-4">{i + 1}</span>
                      <span className="text-sm font-bold text-primary">{p.name}</span>
                    </div>
                    <span className="text-sm font-money font-bold text-loss">{formatCurrency(p.delta)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {chartPreferences.monthlyCashFlow && (
        <div id="monthly-cash-flow" className="card scroll-mt-24 p-4 md:p-6">
          <div className="mb-4 flex flex-col gap-1 md:flex-row md:items-end md:justify-between">
            <div>
              <h2 className="text-[10px] font-bold uppercase tracking-wide text-tertiary">Monthly Cash Flow</h2>
              <p className="text-caption text-tertiary">Income versus spending for each available month.</p>
            </div>
            <div className="flex gap-3 text-caption">
              <span className="inline-flex items-center gap-1.5 text-gain"><span className="h-2.5 w-2.5 bg-gain" />Income</span>
              <span className="inline-flex items-center gap-1.5 text-loss"><span className="h-2.5 w-2.5 bg-loss" />Spending</span>
            </div>
          </div>
          <div style={{ height: isMobile ? 240 : 320 }}>
            {monthlyCashFlowData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={monthlyCashFlowData} margin={{ top: 8, right: 10, left: 0, bottom: 5 }}>
                  <CartesianGrid {...GRID_STYLE} vertical={false} />
                  <XAxis dataKey="month" {...AXIS_STYLE} />
                  <YAxis {...AXIS_STYLE} tickFormatter={formatCompactCurrency} width={isMobile ? 45 : 60} />
                  <Tooltip content={<ChartTooltip formatValue={formatCurrency} />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                  <Bar dataKey="income" fill="var(--gain)" radius={[3, 3, 0, 0]} name="Income" animationDuration={800} />
                  <Bar dataKey="spending" fill="var(--loss)" radius={[3, 3, 0, 0]} name="Spending" animationDuration={800} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-tertiary">No cash flow data for {selectedYear}</div>
            )}
          </div>
        </div>
      )}

      {/* Annual Income vs Spending Summary */}
      {chartPreferences.cashFlow && spendingMetrics.totalIncome > 0 && (
        <div id="cash-flow" className="card p-4 md:p-6 scroll-mt-24">
          <h2 className="text-[10px] font-bold tracking-wide uppercase text-tertiary mb-4">{isPartialYear ? 'YTD Cash Flow' : 'Annual Cash Flow'}</h2>
          <div className="grid grid-cols-3 gap-6">
            <div>
              <p className="text-[10px] font-bold text-tertiary uppercase tracking-wide mb-1">Total Income</p>
              <p className="text-lg font-money font-bold text-gain">{formatCurrency(spendingMetrics.totalIncome)}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold text-tertiary uppercase tracking-wide mb-1">Total Spending</p>
              <p className="text-lg font-money font-bold text-loss">{formatCurrency(spendingMetrics.totalSpending)}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold text-tertiary uppercase tracking-wide mb-1">Net Saved</p>
              <p className={`text-lg font-money font-bold ${spendingMetrics.totalIncome - spendingMetrics.totalSpending >= 0 ? 'text-gain' : 'text-loss'}`}>
                {formatCurrency(spendingMetrics.totalIncome - spendingMetrics.totalSpending)}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
