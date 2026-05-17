import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine,
  AreaChart, Area,
} from 'recharts';
import { CalendarDays, TrendingUp, TrendingDown, Award, Target } from 'lucide-react';
import MetricCard from '../components/MetricCard';
import AllocationDonut from '../components/AllocationDonut';
import ChartTooltip from '../components/ChartTooltip';
import { GRID_STYLE, AXIS_STYLE, areaGradient } from '../utils/chartTheme';
import { formatCurrency, formatCompactCurrency, formatPercent, formatDateAxis } from '../utils/format';
import { analytics, dashboard, history as historyAPI } from '../utils/api';
import { useIsMobile } from '../hooks/useMediaQuery';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function YearInReview() {
  const isMobile = useIsMobile();
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [loading, setLoading] = useState(true);
  const [monthlyData, setMonthlyData] = useState([]);
  const [ivsData, setIvsData] = useState([]);
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

      const [monthly, ivs, dash, portfolio, tStart, tEnd] = await Promise.all([
        analytics.getNetWorthMonthly({ year: selectedYear }),
        analytics.getIncomeVsSpending({ startDate, endDate }),
        dashboard.getPortfolio(),
        historyAPI.getPortfolio({ startDate, endDate, limit: 10000 }),
        historyAPI.getTickers({ startDate, endDate: `${selectedYear}-01-31`, limit: 10000 }),
        historyAPI.getTickers({ startDate: `${selectedYear}-12-01`, endDate, limit: 10000 }),
      ]);

      setMonthlyData(monthly.data || []);
      setIvsData(ivs.data || []);
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

  const chartData = useMemo(() =>
    monthlyData.map((d) => {
      const monthIdx = new Date(d.month).getUTCMonth();
      return {
        month: MONTHS[monthIdx],
        change: parseFloat(d.change) || 0,
        end_value: parseFloat(d.end_value) || 0,
        change_percent: parseFloat(d.change_percent) || 0,
      };
    }),
  [monthlyData]);

  const yearMetrics = useMemo(() => {
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
  }, [chartData]);

  const spendingMetrics = useMemo(() => {
    let totalIncome = 0, totalSpending = 0;
    for (const d of ivsData) {
      totalIncome += parseFloat(d.income) || 0;
      totalSpending += parseFloat(d.spending) || 0;
    }
    const savingsRate = totalIncome > 0 ? ((totalIncome - totalSpending) / totalIncome) * 100 : 0;
    return { totalIncome, totalSpending, savingsRate };
  }, [ivsData]);

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

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <div className="w-10 h-10 border-4 border-accent border-t-transparent rounded-full animate-spin shadow-glow" />
        <span className="text-xs font-bold tracking-widest uppercase text-tertiary animate-pulse">Compiling Year in Review</span>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 md:py-8 max-w-[1600px] space-y-8">
      {/* Hero */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl md:text-5xl font-bold text-primary tracking-tighter">Year in Review</h1>
          <p className="text-sm text-secondary mt-1">Annual financial performance summary</p>
        </div>
        <div className="flex bg-surface-2 rounded-xl border border-border p-1 gap-1">
          {availableYears.map((y) => (
            <button
              key={y}
              onClick={() => setSelectedYear(y)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold tracking-wider transition-all ${
                selectedYear === y ? 'bg-accent/15 text-accent' : 'text-tertiary hover:text-secondary'
              }`}
            >
              {y}
            </button>
          ))}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Starting Net Worth"
          value={formatCurrency(yearMetrics.startNW)}
          icon={Target}
        />
        <MetricCard
          label="Ending Net Worth"
          value={formatCurrency(yearMetrics.endNW)}
          icon={Award}
          valueColor="accent"
        />
        <MetricCard
          label="Total Growth"
          value={formatCurrency(yearMetrics.growth)}
          change={formatPercent(yearMetrics.growthPct, 1)}
          trend={yearMetrics.growth >= 0 ? 'up' : 'down'}
          icon={yearMetrics.growth >= 0 ? TrendingUp : TrendingDown}
          valueColor={yearMetrics.growth >= 0 ? 'gain' : 'loss'}
        />
        <MetricCard
          label="Savings Rate"
          value={formatPercent(spendingMetrics.savingsRate, 1)}
          icon={CalendarDays}
          valueColor={spendingMetrics.savingsRate >= 0 ? 'gain' : 'loss'}
        />
      </div>

      {/* Monthly Net Worth Change Bar Chart */}
      <div className="card p-4 md:p-6">
        <h2 className="text-[10px] font-bold tracking-widest uppercase text-tertiary mb-4">Monthly Net Worth Change</h2>
        <div style={{ height: isMobile ? 280 : 380 }}>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 10, right: 10, left: isMobile ? 0 : 10, bottom: 5 }}>
                <CartesianGrid {...GRID_STYLE} vertical={false} />
                <XAxis dataKey="month" {...AXIS_STYLE} />
                <YAxis {...AXIS_STYLE} tickFormatter={formatCompactCurrency} width={isMobile ? 45 : 60} />
                <Tooltip
                  content={<ChartTooltip formatValue={(v) => formatCurrency(v)} />}
                  cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                />
                <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="3 3" />
                <Bar dataKey="change" radius={[4, 4, 0, 0]} animationDuration={800} name="Change">
                  {chartData.map((entry, i) => (
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

      {/* Mini Charts Row */}
      <div className="grid lg:grid-cols-2 gap-6">
        {/* Net Worth Trajectory */}
        <div className="card p-4 md:p-6">
          <h2 className="text-[10px] font-bold tracking-widest uppercase text-tertiary mb-4">Net Worth Trajectory</h2>
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

        {/* Year-End Allocation */}
        <div className="card p-4 md:p-6">
          <h2 className="text-[10px] font-bold tracking-widest uppercase text-tertiary mb-4">Portfolio Allocation</h2>
          <div style={{ height: isMobile ? 180 : 220 }}>
            {portfolioItems.length > 0 ? (
              <AllocationDonut items={portfolioItems} />
            ) : (
              <div className="flex items-center justify-center h-full text-tertiary text-sm">No data</div>
            )}
          </div>
        </div>
      </div>

      {/* Best/Worst Months */}
      <div className="grid lg:grid-cols-2 gap-6">
        <div className="card p-4 md:p-6">
          <h2 className="text-[10px] font-bold tracking-widest uppercase text-tertiary mb-3">Best Month</h2>
          {yearMetrics.bestMonth ? (
            <div className="flex items-center gap-3">
              <div className="p-3 rounded-2xl bg-gain/10 text-gain"><TrendingUp size={20} /></div>
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
          <h2 className="text-[10px] font-bold tracking-widest uppercase text-tertiary mb-3">Worst Month</h2>
          {yearMetrics.worstMonth ? (
            <div className="flex items-center gap-3">
              <div className="p-3 rounded-2xl bg-loss/10 text-loss"><TrendingDown size={20} /></div>
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
              <div className="p-4 border-b border-border bg-surface-2/50">
                <span className="text-[10px] font-bold tracking-widest uppercase text-gain">Top Gainers</span>
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
              <div className="p-4 border-b border-border bg-surface-2/50">
                <span className="text-[10px] font-bold tracking-widest uppercase text-loss">Biggest Losers</span>
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

      {/* Annual Income vs Spending Summary */}
      {spendingMetrics.totalIncome > 0 && (
        <div className="card p-4 md:p-6">
          <h2 className="text-[10px] font-bold tracking-widest uppercase text-tertiary mb-4">Annual Cash Flow</h2>
          <div className="grid grid-cols-3 gap-6">
            <div>
              <p className="text-[10px] font-bold text-tertiary uppercase tracking-widest mb-1">Total Income</p>
              <p className="text-lg font-money font-bold text-gain">{formatCurrency(spendingMetrics.totalIncome)}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold text-tertiary uppercase tracking-widest mb-1">Total Spending</p>
              <p className="text-lg font-money font-bold text-loss">{formatCurrency(spendingMetrics.totalSpending)}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold text-tertiary uppercase tracking-widest mb-1">Net Saved</p>
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
