import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceDot,
} from 'recharts';
import { TrendingUp, TrendingDown, Check, Calendar } from 'lucide-react';
import LoadingState from '../components/LoadingState';
import { dashboard as dashboardAPI, history as historyAPI } from '../utils/api';
import { formatCurrency, formatPercent, formatDateAxis, formatDateDisplay } from '../utils/format';
import { GRID_STYLE, AXIS_STYLE, areaGradient } from '../utils/chartTheme';
import ChartTooltip from '../components/ChartTooltip';
import ResponsiveContainer from '../components/ResponsiveContainer';

const ACCENT = '#3994BC';

const DATE_RANGES = {
  '1M': { label: '1 Month', days: 30 },
  '3M': { label: '3 Months', days: 90 },
  '6M': { label: '6 Months', days: 180 },
  '1Y': { label: '1 Year', days: 365 },
  'YTD': { label: 'Year to Date', days: null },
  'ALL': { label: 'All Time', days: null },
};

const calculateDateRange = (range) => {
  const now = new Date();
  let startDate;
  if (range === 'YTD') {
    startDate = new Date(now.getFullYear(), 0, 1);
  } else if (range === 'ALL') {
    return { startDate: null, endDate: null };
  } else {
    const days = DATE_RANGES[range]?.days || 30;
    startDate = new Date(now);
    startDate.setDate(startDate.getDate() - days);
  }
  return { startDate: startDate.toISOString().split('T')[0], endDate: now.toISOString().split('T')[0] };
};

const calculateTrendLine = (data) => {
  if (!data || data.length < 2) return [];
  const n = data.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  data.forEach((point, i) => {
    const y = parseFloat(point.total_value) || 0;
    sumX += i; sumY += y; sumXY += i * y; sumX2 += i * i;
  });
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  return data.map((point, i) => ({ ...point, trend_value: intercept + slope * i }));
};

const PortfolioTimeline = () => {
  const [portfolioData, setPortfolioData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedRange, setSelectedRange] = useState('1Y');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [useCustomRange, setUseCustomRange] = useState(false);
  const [customControlsOpen, setCustomControlsOpen] = useState(false);
  const [showTrendLine, setShowTrendLine] = useState(true);
  const [showDrawdown, setShowDrawdown] = useState(false);

  const fetchPortfolioData = useCallback(async () => {
    setLoading(true);
    try {
      let startDate, endDate;
      if (useCustomRange && customStartDate && customEndDate) {
        startDate = customStartDate; endDate = customEndDate;
      } else {
        const range = calculateDateRange(selectedRange);
        startDate = range.startDate; endDate = range.endDate;
      }
      const today = new Date().toISOString().split('T')[0];
      const shouldAppendLivePoint = !endDate || endDate >= today;
      const livePortfolioPromise = shouldAppendLivePoint
        ? dashboardAPI.getPortfolio().catch(() => null)
        : Promise.resolve(null);
      const response = await historyAPI.getPortfolio({ startDate, endDate, limit: 10000, withCount: false });
      let allData = response.data || [];

      // The endpoint returns rows in ascending date order; sort defensively
      // before any first/last-date calculations or chart rendering.
      allData.sort((a, b) => (
        String(a.snapshot_date).localeCompare(String(b.snapshot_date))
      ));

      const livePortfolio = await livePortfolioPromise;
      const liveValue = livePortfolio?.summary?.netWorth;
      const latestDate = allData[allData.length - 1]?.snapshot_date?.slice(0, 10);
      if (Number.isFinite(liveValue) && latestDate !== today) {
        allData = [
          ...allData,
          { snapshot_date: today, total_value: liveValue, is_live: true },
        ];
      }
      setPortfolioData(allData);
    } catch (err) {
      console.error('Error fetching portfolio data:', err);
    } finally {
      setLoading(false);
    }
  }, [selectedRange, customStartDate, customEndDate, useCustomRange]);

  useEffect(() => { fetchPortfolioData(); }, [fetchPortfolioData]);

  const metrics = useMemo(() => {
    if (!portfolioData || portfolioData.length === 0) {
      return { currentValue: 0, startValue: 0, totalGrowth: 0, percentChange: 0, avgMonthlyChange: 0, allTimeHigh: 0, allTimeLow: 0, peakDate: null, troughDate: null };
    }
    const values = portfolioData.map(d => parseFloat(d.total_value) || 0);
    const currentValue = values[values.length - 1];
    const startValue = values[0];
    const totalGrowth = currentValue - startValue;
    const percentChange = startValue !== 0 ? ((currentValue - startValue) / startValue) * 100 : 0;
    const allTimeHigh = Math.max(...values);
    const allTimeLow = Math.min(...values);
    const peakIndex = values.indexOf(allTimeHigh);
    const troughIndex = values.indexOf(allTimeLow);
    const peakDate = portfolioData[peakIndex]?.snapshot_date;
    const troughDate = portfolioData[troughIndex]?.snapshot_date;
    let avgMonthlyChange = 0;
    if (portfolioData.length >= 2) {
      const firstDate = new Date(portfolioData[0].snapshot_date);
      const lastDate = new Date(portfolioData[portfolioData.length - 1].snapshot_date);
      const months = (lastDate - firstDate) / (1000 * 60 * 60 * 24 * 30.44);
      if (months > 0) avgMonthlyChange = totalGrowth / months;
    }
    return { currentValue, startValue, totalGrowth, percentChange, avgMonthlyChange, allTimeHigh, allTimeLow, peakDate, troughDate };
  }, [portfolioData]);

  const chartData = useMemo(() => {
    if (!portfolioData || portfolioData.length === 0) return [];
    return showTrendLine ? calculateTrendLine(portfolioData) : portfolioData;
  }, [portfolioData, showTrendLine]);

  const drawdownData = useMemo(() => {
    if (!portfolioData || portfolioData.length === 0) return [];
    let runningMax = 0;
    return portfolioData.map((d) => {
      const val = parseFloat(d.total_value) || 0;
      runningMax = Math.max(runningMax, val);
      const drawdown = runningMax > 0 ? ((val - runningMax) / runningMax) * 100 : 0;
      return { snapshot_date: d.snapshot_date, drawdown };
    });
  }, [portfolioData]);

  const maxDrawdownValue = useMemo(() => {
    if (drawdownData.length === 0) return 0;
    return Math.min(...drawdownData.map((d) => d.drawdown));
  }, [drawdownData]);

  const maxDrawdownPoint = useMemo(() => {
    if (drawdownData.length === 0) return null;
    return drawdownData.reduce((lowest, point) => (
      !lowest || point.drawdown < lowest.drawdown ? point : lowest
    ), null);
  }, [drawdownData]);

  const visiblePeriodLabel = useMemo(() => {
    if (!portfolioData || portfolioData.length === 0) return 'No data';
    const start = portfolioData[0].snapshot_date;
    const end = portfolioData[portfolioData.length - 1].snapshot_date;
    return `${formatDateDisplay(start)} to ${formatDateDisplay(end)}`;
  }, [portfolioData]);

  const handleRangeChange = (range) => {
    setUseCustomRange(false);
    setCustomControlsOpen(false);
    setSelectedRange(range);
  };
  const handleCustomRangeApply = () => {
    if (customStartDate && customEndDate) {
      setUseCustomRange(true);
      setCustomControlsOpen(true);
    }
  };

  if (loading) {
    return <LoadingState label="Loading timeline" />;
  }

  return (
    <div className="px-4 py-4">
      {/* Header */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between mb-4 gap-3">
        <div>
          <h1 className="text-display-md text-primary">Portfolio Timeline</h1>
          <p className="text-body-sm text-tertiary">{visiblePeriodLabel}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex bg-surface border border-border">
            {Object.keys(DATE_RANGES).map((range) => (
              <button
                key={range}
                onClick={() => handleRangeChange(range)}
                className={`px-2 py-1 text-caption transition-colors ${
                  selectedRange === range && !useCustomRange
                    ? 'bg-accent text-white'
                    : 'text-tertiary hover:text-secondary'
                }`}
              >{range}</button>
            ))}
            <button
              onClick={() => setCustomControlsOpen((open) => !open)}
              className={`flex items-center gap-1 px-2 py-1 text-caption transition-colors ${
                useCustomRange
                  ? 'bg-accent text-white'
                  : customControlsOpen ? 'bg-accent-muted text-accent' : 'text-tertiary hover:text-secondary'
              }`}
            >
              <Calendar size={12} /> Custom
            </button>
          </div>
        </div>
      </div>

      {/* Controls Panel */}
      <div className="card mb-4">
        <div className="p-3 space-y-3">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-caption text-tertiary uppercase tracking-wide">Chart Modes</p>
              <p className="text-body-sm text-secondary">
                {showTrendLine ? 'Trend line on' : 'Trend line off'} / {showDrawdown ? 'drawdown panel shown' : 'drawdown panel hidden'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setShowTrendLine(!showTrendLine)}
                className={`flex items-center gap-1.5 border px-2 py-1 text-caption transition-colors ${
                  showTrendLine ? 'bg-accent-muted border-accent/30 text-accent' : 'bg-surface border-border text-tertiary hover:text-secondary'
                }`}
              >
                <TrendingUp size={12} />
                Trend Line
                {showTrendLine && <Check size={12} />}
              </button>
              <button
                onClick={() => setShowDrawdown(!showDrawdown)}
                className={`flex items-center gap-1.5 border px-2 py-1 text-caption transition-colors ${
                  showDrawdown ? 'bg-loss-bg border-loss/30 text-loss' : 'bg-surface border-border text-tertiary hover:text-secondary'
                }`}
              >
                <TrendingDown size={12} />
                Drawdown
                {showDrawdown && <Check size={12} />}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="border border-border bg-surface-3 p-2">
              <p className="text-caption text-tertiary uppercase mb-0.5">Current Value</p>
              <p className="value-emphasis text-primary">{formatCurrency(metrics.currentValue)}</p>
            </div>
            <div className="border border-border bg-surface-3 p-2">
              <p className="text-caption text-tertiary uppercase mb-0.5">Period Growth</p>
              <div className="flex items-end gap-1.5">
                <p className={`value-emphasis ${metrics.totalGrowth >= 0 ? 'text-gain' : 'text-loss'}`}>{formatCurrency(metrics.totalGrowth)}</p>
                <p className={`text-caption font-mono ${metrics.percentChange >= 0 ? 'text-gain' : 'text-loss'}`}>{formatPercent(metrics.percentChange)}</p>
              </div>
            </div>
            <div className="border border-border bg-surface-3 p-2">
              <p className="text-caption text-tertiary uppercase mb-0.5">All-Time High</p>
              <p className="value-emphasis text-gain">{formatCurrency(metrics.allTimeHigh)}</p>
              <p className="text-caption text-tertiary">{formatDateDisplay(metrics.peakDate)}</p>
            </div>
          </div>

          {customControlsOpen && (
            <div className="grid grid-cols-1 gap-2 border-t border-border pt-3 lg:grid-cols-[1fr_1fr_auto] lg:items-end">
              <div>
                <label className="text-caption text-tertiary uppercase block mb-1">Custom Start</label>
                <input type="date" value={customStartDate} onChange={(e) => setCustomStartDate(e.target.value)} className="w-full bg-surface-3 border-border px-2 py-1 text-caption" />
              </div>
              <div>
                <label className="text-caption text-tertiary uppercase block mb-1">Custom End</label>
                <input type="date" value={customEndDate} onChange={(e) => setCustomEndDate(e.target.value)} className="w-full bg-surface-3 border-border px-2 py-1 text-caption" />
              </div>
              <button onClick={handleCustomRangeApply} disabled={!customStartDate || !customEndDate} className="px-3 py-1 border border-border bg-surface-3 text-caption text-tertiary hover:bg-accent hover:text-white hover:border-accent disabled:opacity-30 transition-colors">
                Apply
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Main Chart */}
      <div className="card p-4 mb-4">
        <div className="flex flex-col gap-1 mb-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-caption text-tertiary uppercase tracking-wide">Portfolio Value</p>
            <p className="text-body-sm text-secondary">
              Starts at {formatCurrency(metrics.startValue)} with {formatCurrency(metrics.totalGrowth)} period growth.
            </p>
          </div>
          <p className="text-caption text-tertiary">{visiblePeriodLabel}</p>
        </div>
        <div className="h-64 md:h-[500px] w-full">
          {portfolioData.length === 0 ? (
            <div className="flex items-center justify-center h-full text-caption text-tertiary">No data for this range</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 24, right: 16, left: 0, bottom: 0 }}>
                <defs>{areaGradient('colorValue', ACCENT)}</defs>
                <CartesianGrid {...GRID_STYLE} vertical={false} strokeOpacity={0.5} />
                <XAxis dataKey="snapshot_date" tickFormatter={formatDateAxis} {...AXIS_STYLE} interval="preserveStartEnd" padding={{ left: 10, right: 10 }} minTickGap={40} />
                <YAxis tickFormatter={formatCurrency} {...AXIS_STYLE} width={80} axisLine={false} />
                <Tooltip content={<ChartTooltip formatValue={formatCurrency} formatLabel={formatDateAxis} />} cursor={{ stroke: 'var(--border)', strokeWidth: 1 }} />
                <Area type="monotone" dataKey="total_value" stroke={ACCENT} strokeWidth={2} fill="url(#colorValue)" name="Portfolio Value" animationDuration={800} />
                {showTrendLine && (
                  <Area type="monotone" dataKey="trend_value" stroke="var(--text-tertiary)" strokeWidth={1} strokeDasharray="6 4" fill="none" name="Trend Line" animationDuration={800} />
                )}
                {metrics.peakDate && (
                  <ReferenceDot
                    x={metrics.peakDate}
                    y={metrics.allTimeHigh}
                    r={4}
                    fill="var(--gain)"
                    stroke="var(--bg-surface)"
                    strokeWidth={2}
                    label={{ value: 'High', position: 'top', fill: 'var(--gain)', fontSize: 12 }}
                  />
                )}
                {metrics.troughDate && metrics.troughDate !== metrics.peakDate && (
                  <ReferenceDot
                    x={metrics.troughDate}
                    y={metrics.allTimeLow}
                    r={4}
                    fill="var(--loss)"
                    stroke="var(--bg-surface)"
                    strokeWidth={2}
                    label={{ value: 'Low', position: 'bottom', fill: 'var(--loss)', fontSize: 12 }}
                  />
                )}
                {portfolioData.length > 0 && (
                  <ReferenceLine
                    y={metrics.startValue}
                    stroke="var(--text-tertiary)"
                    strokeDasharray="4 4"
                    strokeOpacity={0.5}
                    label={{ value: 'Start', position: 'insideTopLeft', fill: 'var(--text-tertiary)', fontSize: 12 }}
                  />
                )}
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Drawdown Chart */}
      {showDrawdown && drawdownData.length > 0 && (
        <div className="card p-4 mb-4">
          <div className="flex items-center justify-between gap-3 mb-2">
            <p className="text-caption text-tertiary uppercase">Drawdown from Peak</p>
            <p className="text-caption text-loss">Max {formatPercent(maxDrawdownValue, 1)}</p>
          </div>
          <div className="h-28 md:h-36 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={drawdownData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="drawdownFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--loss)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="var(--loss)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...GRID_STYLE} vertical={false} strokeOpacity={0.3} />
                <XAxis dataKey="snapshot_date" tickFormatter={formatDateAxis} {...AXIS_STYLE} hide />
                <YAxis {...AXIS_STYLE} tickFormatter={(v) => `${v.toFixed(0)}%`} width={50} axisLine={false} />
                <Tooltip content={<ChartTooltip formatValue={(v) => formatPercent(v, 2)} formatLabel={formatDateAxis} />} cursor={{ stroke: 'var(--border)', strokeWidth: 1 }} />
                <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="3 3" />
                <Area type="monotone" dataKey="drawdown" stroke="var(--loss)" strokeWidth={1.5} fill="url(#drawdownFill)" name="Drawdown" animationDuration={800} />
                {maxDrawdownPoint && (
                  <ReferenceDot
                    x={maxDrawdownPoint.snapshot_date}
                    y={maxDrawdownPoint.drawdown}
                    r={3}
                    fill="var(--loss)"
                    stroke="var(--bg-surface)"
                    strokeWidth={2}
                    label={{ value: 'Max', position: 'bottom', fill: 'var(--loss)', fontSize: 12 }}
                  />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Period Summary */}
      {portfolioData.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-border">
          <div className="card p-3">
            <p className="text-caption text-tertiary uppercase mb-0.5">Period Start</p>
            <p className="text-body-sm font-semibold text-primary">{formatDateDisplay(portfolioData[0].snapshot_date)}</p>
            <p className="text-caption font-mono text-tertiary">{formatCurrency(metrics.startValue)}</p>
          </div>
          <div className="card p-3">
            <p className="text-caption text-tertiary uppercase mb-0.5">Period End</p>
            <p className="text-body-sm font-semibold text-primary">{formatDateDisplay(portfolioData[portfolioData.length - 1].snapshot_date)}</p>
            <p className="text-caption font-mono text-tertiary">{formatCurrency(metrics.currentValue)}</p>
          </div>
          <div className="card p-3">
            <p className="text-caption text-tertiary uppercase mb-0.5">Avg Monthly Delta</p>
            <p className={`text-body-sm font-semibold font-mono ${metrics.avgMonthlyChange >= 0 ? 'text-gain' : 'text-loss'}`}>{formatCurrency(metrics.avgMonthlyChange)}</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default PortfolioTimeline;
