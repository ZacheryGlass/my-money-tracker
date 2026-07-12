import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, BarChart,
} from 'recharts';
import { BarChart3, DollarSign, TrendingDown, Percent } from 'lucide-react';
import MetricCard from '../components/MetricCard';
import CalendarHeatmap from '../components/CalendarHeatmap';
import ChartTooltip from '../components/ChartTooltip';
import ResponsiveContainer from '../components/ResponsiveContainer';
import { CHART_COLORS, GRID_STYLE, AXIS_STYLE } from '../utils/chartTheme';
import { formatCurrency, formatCompactCurrency, formatDateDisplay, formatPercent } from '../utils/format';
import { transactions } from '../utils/api';
import { useIsMobile } from '../hooks/useMediaQuery';
import { classifyTransaction } from '../utils/transactionClassification';

const DATE_RANGES = [
  { id: '3m', label: '3M', days: 90 },
  { id: '6m', label: '6M', days: 180 },
  { id: '1y', label: '1Y', days: 365 },
  { id: 'ytd', label: 'YTD', days: null },
  { id: 'all', label: 'All', days: null },
];

function getDateRange(rangeId) {
  const range = DATE_RANGES.find((r) => r.id === rangeId);
  const end = new Date();
  if (rangeId === 'ytd') {
    return {
      startDate: `${end.getFullYear()}-01-01`,
      endDate: end.toISOString().slice(0, 10),
    };
  }
  if (!range || !range.days) return {};
  const start = new Date();
  start.setDate(start.getDate() - range.days);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function formatMonth(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

function formatRangeLabel(range, heatmapRows, monthlyRows) {
  const start = range.startDate || heatmapRows[0]?.date || monthlyRows[0]?.month;
  const end = range.endDate || heatmapRows[heatmapRows.length - 1]?.date || monthlyRows[monthlyRows.length - 1]?.month;
  if (!start || !end) return 'No transactions in range';
  return `${formatDateDisplay(start)} to ${formatDateDisplay(end)}`;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function getMonthKey(dateString) {
  return `${String(dateString).slice(0, 7)}-01`;
}

function buildIncomeVsSpending(spendingRows, incomeRows) {
  const months = new Map();
  const ensureMonth = (month) => {
    if (!months.has(month)) {
      months.set(month, { month, income: 0, spending: 0, savings_rate: 0 });
    }
    return months.get(month);
  };

  spendingRows.forEach((txn) => {
    ensureMonth(getMonthKey(txn.date)).spending += txn.spend;
  });

  incomeRows.forEach((txn) => {
    ensureMonth(getMonthKey(txn.date)).income += txn.income;
  });

  return Array.from(months.values())
    .sort((a, b) => String(a.month).localeCompare(String(b.month)))
    .map((row) => ({
      ...row,
      income: roundMoney(row.income),
      spending: roundMoney(row.spending),
      savings_rate: row.income > 0 ? roundMoney(((row.income - row.spending) / row.income) * 100) : 0,
    }));
}

function buildCategoryData(spendingRows) {
  const totals = new Map();

  spendingRows.forEach((txn) => {
    const key = `${getMonthKey(txn.date)}|${txn.categoryLabel}`;
    const row = totals.get(key) || {
      period: getMonthKey(txn.date),
      category: txn.categoryLabel,
      total: 0,
      tx_count: 0,
    };
    row.total += txn.spend;
    row.tx_count += 1;
    totals.set(key, row);
  });

  return Array.from(totals.values()).map((row) => ({
    ...row,
    total: roundMoney(row.total),
  }));
}

function buildHeatmapData(spendingRows) {
  const totals = new Map();

  spendingRows.forEach((txn) => {
    const date = String(txn.date).slice(0, 10);
    const row = totals.get(date) || { date, total: 0, tx_count: 0 };
    row.total += txn.spend;
    row.tx_count += 1;
    totals.set(date, row);
  });

  return Array.from(totals.values())
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((row) => ({ ...row, total: roundMoney(row.total) }));
}

export default function SpendingAnalytics({ embedded = false }) {
  const isMobile = useIsMobile();
  const [dateRange, setDateRange] = useState('6m');
  const [loading, setLoading] = useState(true);
  const [incomeVsSpending, setIncomeVsSpending] = useState([]);
  const [categoryData, setCategoryData] = useState([]);
  const [heatmapData, setHeatmapData] = useState([]);
  const [activeCategory, setActiveCategory] = useState(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const range = getDateRange(dateRange);
      const txnResult = await transactions.getAll({ ...range, limit: 10000 });
      const classifiedRows = (txnResult.data || [])
        .filter((txn) => !txn.pending)
        .map(classifyTransaction);
      const everydaySpending = classifiedRows.filter((txn) => txn.spend > 0 && txn.isEveryday);
      const incomeRows = classifiedRows.filter((txn) => txn.income > 0 && txn.isLikelyIncome);

      setIncomeVsSpending(buildIncomeVsSpending(everydaySpending, incomeRows));
      setCategoryData(buildCategoryData(everydaySpending));
      setHeatmapData(buildHeatmapData(everydaySpending));
    } catch (err) {
      console.error('Failed to load spending analytics:', err);
    } finally {
      setLoading(false);
    }
  }, [dateRange]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => { setActiveCategory(null); }, [dateRange]);

  const ivsChartData = useMemo(() =>
    incomeVsSpending.map((d) => ({
      month: formatMonth(d.month),
      income: parseFloat(d.income),
      spending: parseFloat(d.spending),
      savings_rate: parseFloat(d.savings_rate),
    })),
  [incomeVsSpending]);

  const categoryTotals = useMemo(() => {
    const totals = {};
    for (const row of categoryData) {
      const cat = row.category;
      totals[cat] = (totals[cat] || 0) + parseFloat(row.total);
    }
    return Object.entries(totals)
      .map(([name, value]) => ({ name, value: Math.round(value * 100) / 100 }))
      .sort((a, b) => b.value - a.value);
  }, [categoryData]);

  const activeCategoryTotal = useMemo(
    () => categoryTotals.find((category) => category.name === activeCategory),
    [categoryTotals, activeCategory]
  );

  const totalSpending = useMemo(() =>
    ivsChartData.reduce((sum, d) => sum + d.spending, 0),
  [ivsChartData]);

  const totalIncome = useMemo(() =>
    ivsChartData.reduce((sum, d) => sum + d.income, 0),
  [ivsChartData]);

  const avgSavingsRate = useMemo(() => {
    if (totalIncome <= 0) return 0;
    return ((totalIncome - totalSpending) / totalIncome) * 100;
  }, [totalIncome, totalSpending]);

  const avgMonthlySpend = useMemo(() => {
    if (ivsChartData.length === 0) return 0;
    return totalSpending / ivsChartData.length;
  }, [totalSpending, ivsChartData]);

  const range = useMemo(() => getDateRange(dateRange), [dateRange]);
  const selectedRange = DATE_RANGES.find((item) => item.id === dateRange);
  const visibleRangeLabel = useMemo(
    () => formatRangeLabel(range, heatmapData, incomeVsSpending),
    [range, heatmapData, incomeVsSpending]
  );

  if (loading) {
    return (
      <div className={`flex flex-col items-center justify-center gap-4 ${embedded ? 'min-h-[260px]' : 'min-h-[400px]'}`}>
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        <span className="text-xs font-bold tracking-wide uppercase text-tertiary ">Analyzing Spending</span>
      </div>
    );
  }

  return (
    <div className={embedded ? 'space-y-6' : 'container mx-auto px-4 py-6 md:py-8 max-w-[1600px] space-y-8'}>
      {/* Hero */}
      {!embedded && (
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-3xl md:text-5xl font-bold text-primary tracking-tighter">Spending Analytics</h1>
          <p className="text-sm text-secondary mt-1">Everyday outflows, likely income, and savings rate</p>
        </div>
        <div className="border border-border bg-surface p-3 min-w-[240px]">
          <p className="text-caption text-tertiary uppercase tracking-wide">Showing</p>
          <p className="font-semibold text-primary">{selectedRange?.label || 'Custom'} period</p>
          <p className="text-caption text-tertiary">{visibleRangeLabel}</p>
        </div>
      </div>
      )}

      {/* Metrics Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard label="Everyday Spend" value={formatCurrency(totalSpending)} icon={DollarSign} valueColor="loss" caption="Classified everyday outflows" />
        <MetricCard label="Total Income" value={formatCurrency(totalIncome)} icon={TrendingDown} valueColor="gain" caption="Likely income deposits" />
        <MetricCard label="Avg Monthly Spend" value={formatCurrency(avgMonthlySpend)} icon={BarChart3} caption={`Across ${ivsChartData.length} months`} />
        <MetricCard label="Savings Rate" value={formatPercent(avgSavingsRate, 1)} icon={Percent} valueColor={avgSavingsRate >= 0 ? 'gain' : 'loss'} caption="Income minus everyday spend" />
      </div>

      {/* Date Range Controls */}
      <div className="flex flex-col gap-3 border border-border bg-surface p-3 md:flex-row md:items-center md:justify-between">
        <div className="flex bg-surface-2 rounded border border-border p-1 gap-1">
          {DATE_RANGES.map((r) => (
            <button
              key={r.id}
              onClick={() => setDateRange(r.id)}
              className={`px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wider transition-all ${
                dateRange === r.id ? 'bg-accent/15 text-accent' : 'text-tertiary hover:text-secondary'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="text-caption text-tertiary">
          <span className="uppercase tracking-wide">Period</span>
          <span className="ml-2 text-secondary">{visibleRangeLabel}</span>
        </div>
      </div>

      {/* Income vs Expenses Chart */}
      <div className="card p-4 md:p-6">
        <div className="flex flex-col gap-3 mb-4 md:flex-row md:items-start md:justify-between">
          <div>
            <h2 className="text-[10px] font-bold tracking-wide uppercase text-tertiary">Income vs Everyday Spend</h2>
            <p className="text-caption text-tertiary mt-1">Dollar bars use the left axis. Savings rate uses the right percent axis.</p>
          </div>
          <div className="flex flex-wrap gap-2 text-caption">
            <span className="inline-flex items-center gap-1.5 text-gain"><span className="h-2.5 w-2.5 bg-gain" />Income</span>
            <span className="inline-flex items-center gap-1.5 text-loss"><span className="h-2.5 w-2.5 bg-loss" />Everyday spend</span>
            <span className="inline-flex items-center gap-1.5 text-accent"><span className="h-0.5 w-4 bg-accent" />Savings rate</span>
          </div>
        </div>
        <div style={{ height: isMobile ? 280 : 380 }}>
          {ivsChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={ivsChartData} margin={{ top: 10, right: 10, left: isMobile ? 0 : 10, bottom: 5 }}>
                <CartesianGrid {...GRID_STYLE} vertical={false} />
                <XAxis dataKey="month" {...AXIS_STYLE} />
                <YAxis
                  yAxisId="left"
                  {...AXIS_STYLE}
                  tickFormatter={formatCompactCurrency}
                  width={isMobile ? 45 : 60}
                  label={isMobile ? undefined : { value: 'USD', angle: -90, position: 'insideLeft', style: { fill: 'var(--text-tertiary)', fontSize: 10 } }}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  {...AXIS_STYLE}
                  tickFormatter={(v) => `${v}%`}
                  width={48}
                  label={isMobile ? undefined : { value: 'Savings %', angle: 90, position: 'insideRight', style: { fill: 'var(--text-tertiary)', fontSize: 10 } }}
                />
                <Tooltip
                  content={<ChartTooltip formatValue={(val, name) => {
                    if (name === 'savings_rate') return formatPercent(val, 1);
                    return formatCurrency(val);
                  }} />}
                  cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                />
                <Bar yAxisId="left" dataKey="income" fill="var(--gain)" radius={[4, 4, 0, 0]} barSize={isMobile ? 12 : 20} name="Income" />
                <Bar yAxisId="left" dataKey="spending" fill="var(--loss)" radius={[4, 4, 0, 0]} barSize={isMobile ? 12 : 20} name="Everyday Spend" />
                <Line yAxisId="right" type="monotone" dataKey="savings_rate" stroke="var(--accent)" strokeWidth={2} dot={false} name="Savings Rate" />
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-tertiary text-sm">No transaction data</div>
          )}
        </div>
      </div>

      {/* Category Breakdown */}
      <div className="grid lg:grid-cols-2 gap-6">
        {/* Donut */}
        <div className="card p-4 md:p-6">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <h2 className="text-[10px] font-bold tracking-wide uppercase text-tertiary">Everyday Spending by Category</h2>
              <p className="text-caption text-tertiary mt-1">
                {activeCategoryTotal
                  ? `${activeCategoryTotal.name}: ${formatCurrency(activeCategoryTotal.value)}`
                  : 'Category totals use classified everyday outflows.'}
              </p>
            </div>
            {activeCategory && (
              <button onClick={() => setActiveCategory(null)} className="text-caption text-accent hover:text-accent-hover">
                Clear
              </button>
            )}
          </div>
          <div style={{ height: isMobile ? 250 : 320 }}>
            {categoryTotals.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={categoryTotals}
                    dataKey="value"
                    nameKey="name"
                    innerRadius="60%"
                    outerRadius="85%"
                    paddingAngle={3}
                    strokeWidth={2}
                    stroke="var(--bg-surface)"
                    animationDuration={1000}
                    onMouseLeave={() => setActiveCategory(null)}
                  >
                    {categoryTotals.map((category, i) => (
                      <Cell
                        key={category.name}
                        fill={CHART_COLORS[i % CHART_COLORS.length]}
                        opacity={!activeCategory || activeCategory === category.name ? 1 : 0.28}
                        onMouseEnter={() => setActiveCategory(category.name)}
                      />
                    ))}
                  </Pie>
                  <Tooltip
                    content={<ChartTooltip formatValue={(v) => formatCurrency(v)} />}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-tertiary text-sm">No category data</div>
            )}
          </div>
          {/* Legend */}
          <div className="flex flex-wrap gap-x-4 gap-y-2 mt-4">
            {categoryTotals.slice(0, 10).map((cat, i) => (
              <button
                key={cat.name}
                onMouseEnter={() => setActiveCategory(cat.name)}
                onMouseLeave={() => setActiveCategory(null)}
                onClick={() => setActiveCategory(activeCategory === cat.name ? null : cat.name)}
                className={`flex items-center gap-1.5 text-xs border px-1.5 py-1 transition-colors ${activeCategory === cat.name ? 'border-accent/40 bg-accent-muted' : 'border-transparent hover:border-border'}`}
              >
                <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }} />
                <span className="text-secondary">{cat.name}</span>
                <span className="font-money text-primary">{formatCompactCurrency(cat.value)}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Horizontal Bar */}
        <div className="card p-4 md:p-6">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <h2 className="text-[10px] font-bold tracking-wide uppercase text-tertiary">Top Categories</h2>
              <p className="text-caption text-tertiary mt-1">Same category colors as the donut chart.</p>
            </div>
            {activeCategoryTotal && (
              <p className="text-caption text-secondary">{formatCurrency(activeCategoryTotal.value)}</p>
            )}
          </div>
          <div style={{ height: isMobile ? 250 : 320 }}>
            {categoryTotals.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={categoryTotals.slice(0, 10)} layout="vertical" margin={{ top: 5, right: 30, left: isMobile ? 60 : 100, bottom: 16 }} onMouseLeave={() => setActiveCategory(null)}>
                  <CartesianGrid {...GRID_STYLE} horizontal={false} />
                  <XAxis
                    type="number"
                    {...AXIS_STYLE}
                    tickFormatter={formatCompactCurrency}
                    label={isMobile ? undefined : { value: 'Everyday spend', position: 'insideBottom', offset: -8, style: { fill: 'var(--text-tertiary)', fontSize: 10 } }}
                  />
                  <YAxis type="category" dataKey="name" {...AXIS_STYLE} tick={{ ...AXIS_STYLE, fontSize: isMobile ? 9 : 11 }} width={isMobile ? 55 : 95} />
                  <Tooltip content={<ChartTooltip formatValue={(v) => formatCurrency(v)} />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]} animationDuration={800} name="Total">
                    {categoryTotals.slice(0, 10).map((category, i) => (
                      <Cell
                        key={category.name}
                        fill={CHART_COLORS[i % CHART_COLORS.length]}
                        opacity={!activeCategory || activeCategory === category.name ? 1 : 0.28}
                        onMouseEnter={() => setActiveCategory(category.name)}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-tertiary text-sm">No category data</div>
            )}
          </div>
        </div>
      </div>

      {/* Spending Heatmap */}
      <div className="card p-4 md:p-6">
        <div className="flex flex-col gap-1 mb-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="text-[10px] font-bold tracking-wide uppercase text-tertiary">Spending Heatmap</h2>
            <p className="text-caption text-tertiary mt-1">Color intensity reflects daily classified everyday spend.</p>
          </div>
          <p className="text-caption text-secondary">{visibleRangeLabel}</p>
        </div>
        {heatmapData.length > 0 ? (
          <div className="overflow-x-auto">
            <CalendarHeatmap
              data={heatmapData}
              startDate={range.startDate}
              endDate={range.endDate}
            />
          </div>
        ) : (
          <div className="flex items-center justify-center h-[120px] text-tertiary text-sm">No spending data for heatmap</div>
        )}
      </div>
    </div>
  );
}
