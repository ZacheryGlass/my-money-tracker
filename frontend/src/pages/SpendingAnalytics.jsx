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
import { formatCurrency, formatCompactCurrency, formatPercent } from '../utils/format';
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

export default function SpendingAnalytics() {
  const isMobile = useIsMobile();
  const [dateRange, setDateRange] = useState('6m');
  const [loading, setLoading] = useState(true);
  const [incomeVsSpending, setIncomeVsSpending] = useState([]);
  const [categoryData, setCategoryData] = useState([]);
  const [heatmapData, setHeatmapData] = useState([]);

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

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        <span className="text-xs font-bold tracking-wide uppercase text-tertiary ">Analyzing Spending</span>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 md:py-8 max-w-[1600px] space-y-8">
      {/* Hero */}
      <div>
        <h1 className="text-3xl md:text-5xl font-bold text-primary tracking-tighter">Spending Analytics</h1>
        <p className="text-sm text-secondary mt-1">Income, expenses, and spending patterns</p>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard label="Everyday Spend" value={formatCurrency(totalSpending)} icon={DollarSign} valueColor="loss" />
        <MetricCard label="Total Income" value={formatCurrency(totalIncome)} icon={TrendingDown} valueColor="gain" />
        <MetricCard label="Avg Monthly Spend" value={formatCurrency(avgMonthlySpend)} icon={BarChart3} />
        <MetricCard label="Savings Rate" value={formatPercent(avgSavingsRate, 1)} icon={Percent} valueColor={avgSavingsRate >= 0 ? 'gain' : 'loss'} />
      </div>

      {/* Date Range Controls */}
      <div className="flex gap-3 items-center">
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
      </div>

      {/* Income vs Expenses Chart */}
      <div className="card p-4 md:p-6">
        <h2 className="text-[10px] font-bold tracking-wide uppercase text-tertiary mb-4">Income vs Expenses</h2>
        <div style={{ height: isMobile ? 280 : 380 }}>
          {ivsChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={ivsChartData} margin={{ top: 10, right: 10, left: isMobile ? 0 : 10, bottom: 5 }}>
                <CartesianGrid {...GRID_STYLE} vertical={false} />
                <XAxis dataKey="month" {...AXIS_STYLE} />
                <YAxis yAxisId="left" {...AXIS_STYLE} tickFormatter={formatCompactCurrency} width={isMobile ? 45 : 60} />
                <YAxis yAxisId="right" orientation="right" {...AXIS_STYLE} tickFormatter={(v) => `${v}%`} width={40} />
                <Tooltip
                  content={<ChartTooltip formatValue={(val, name) => {
                    if (name === 'savings_rate') return formatPercent(val, 1);
                    return formatCurrency(val);
                  }} />}
                  cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                />
                <Bar yAxisId="left" dataKey="income" fill="var(--gain)" radius={[4, 4, 0, 0]} barSize={isMobile ? 12 : 20} name="Income" />
                <Bar yAxisId="left" dataKey="spending" fill="var(--loss)" radius={[4, 4, 0, 0]} barSize={isMobile ? 12 : 20} name="Spending" />
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
          <h2 className="text-[10px] font-bold tracking-wide uppercase text-tertiary mb-4">Everyday Spending by Category</h2>
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
                  >
                    {categoryTotals.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
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
              <div key={cat.name} className="flex items-center gap-1.5 text-xs">
                <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }} />
                <span className="text-secondary">{cat.name}</span>
                <span className="font-money text-primary">{formatCompactCurrency(cat.value)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Horizontal Bar */}
        <div className="card p-4 md:p-6">
          <h2 className="text-[10px] font-bold tracking-wide uppercase text-tertiary mb-4">Top Categories</h2>
          <div style={{ height: isMobile ? 250 : 320 }}>
            {categoryTotals.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={categoryTotals.slice(0, 10)} layout="vertical" margin={{ top: 5, right: 30, left: isMobile ? 60 : 100, bottom: 5 }}>
                  <CartesianGrid {...GRID_STYLE} horizontal={false} />
                  <XAxis type="number" {...AXIS_STYLE} tickFormatter={formatCompactCurrency} />
                  <YAxis type="category" dataKey="name" {...AXIS_STYLE} tick={{ ...AXIS_STYLE, fontSize: isMobile ? 9 : 11 }} width={isMobile ? 55 : 95} />
                  <Tooltip content={<ChartTooltip formatValue={(v) => formatCurrency(v)} />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]} animationDuration={800} name="Total">
                    {categoryTotals.slice(0, 10).map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
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
        <h2 className="text-[10px] font-bold tracking-wide uppercase text-tertiary mb-4">Spending Heatmap</h2>
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

      {/* Day of Week Summary */}
      {heatmapData.length > 0 && (
        <div className="card p-4 md:p-6">
          <h2 className="text-[10px] font-bold tracking-wide uppercase text-tertiary mb-4">Average Spending by Day of Week</h2>
          <DayOfWeekChart data={heatmapData} isMobile={isMobile} />
        </div>
      )}
    </div>
  );
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function DayOfWeekChart({ data = [], isMobile }) {
  const chartData = useMemo(() => {
    const buckets = Array.from({ length: 7 }, () => ({ total: 0, count: 0 }));
    for (const d of data) {
      if (!d || !d.date) continue;
      const dateStr = String(d.date).slice(0, 10);
      const parsed = new Date(dateStr + 'T12:00:00Z');
      const day = parsed.getUTCDay();
      if (isNaN(day)) continue;
      buckets[day].total += parseFloat(d.total) || 0;
      buckets[day].count += 1;
    }
    return DAY_NAMES.map((name, i) => ({
      name,
      avg: buckets[i].count > 0 ? Math.round((buckets[i].total / buckets[i].count) * 100) / 100 : 0,
    }));
  }, [data]);

  return (
    <div style={{ height: isMobile ? 200 : 250 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 10, right: 10, left: isMobile ? 0 : 10, bottom: 5 }}>
          <CartesianGrid {...GRID_STYLE} vertical={false} />
          <XAxis dataKey="name" {...AXIS_STYLE} />
          <YAxis {...AXIS_STYLE} tickFormatter={formatCompactCurrency} width={isMobile ? 45 : 60} />
          <Tooltip content={<ChartTooltip formatValue={(v) => formatCurrency(v)} />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
          <Bar dataKey="avg" fill="var(--accent)" radius={[4, 4, 0, 0]} animationDuration={800} name="Avg Spending">
            {chartData.map((_, i) => (
              <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
