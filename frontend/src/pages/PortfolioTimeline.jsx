import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceDot,
} from 'recharts';
import { history as historyAPI } from '../utils/api';
import { formatCurrency, formatPercent, formatDateAxis, formatDateDisplay } from '../utils/format';
import { GRID_STYLE, AXIS_STYLE, areaGradient } from '../utils/chartTheme';
import ChartTooltip from '../components/ChartTooltip';

const PAGE_SIZE = 100;

const DATE_RANGES = {
  '1M': { label: '1 Month', days: 30 },
  '3M': { label: '3 Months', days: 90 },
  '6M': { label: '6 Months', days: 180 },
  '1Y': { label: '1 Year', days: 365 },
  'YTD': { label: 'Year to Date', days: null },
  'ALL': { label: 'All Time', days: null },
};

const ACCENT = '#00D4AA';

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

  return {
    startDate: startDate.toISOString().split('T')[0],
    endDate: now.toISOString().split('T')[0],
  };
};

const calculateTrendLine = (data) => {
  if (!data || data.length < 2) return [];

  const n = data.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

  data.forEach((point, i) => {
    const y = parseFloat(point.total_value) || 0;
    sumX += i;
    sumY += y;
    sumXY += i * y;
    sumX2 += i * i;
  });

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  return data.map((point, i) => ({
    ...point,
    trend_value: intercept + slope * i,
  }));
};

const PortfolioTimeline = () => {
  const [portfolioData, setPortfolioData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedRange, setSelectedRange] = useState('1Y');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [useCustomRange, setUseCustomRange] = useState(false);
  const [showTrendLine, setShowTrendLine] = useState(true);

  const fetchPortfolioData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      let startDate, endDate;

      if (useCustomRange && customStartDate && customEndDate) {
        startDate = customStartDate;
        endDate = customEndDate;
      } else {
        const range = calculateDateRange(selectedRange);
        startDate = range.startDate;
        endDate = range.endDate;
      }

      const response = await historyAPI.getPortfolio({ startDate, endDate, limit: PAGE_SIZE });
      let allData = response.data || [];
      let offset = PAGE_SIZE;
      const total = response.pagination?.total || 0;

      while (offset < total) {
        const moreResponse = await historyAPI.getPortfolio({ startDate, endDate, limit: PAGE_SIZE, offset });
        allData = [...allData, ...(moreResponse.data || [])];
        offset += PAGE_SIZE;
      }

      setPortfolioData(allData);
    } catch (err) {
      console.error('Error fetching portfolio data:', err);
      setError(err.response?.data?.error || 'Failed to load portfolio data');
    } finally {
      setLoading(false);
    }
  }, [selectedRange, customStartDate, customEndDate, useCustomRange]);

  useEffect(() => {
    fetchPortfolioData();
  }, [fetchPortfolioData]);

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

  const exportToCSV = useCallback(() => {
    if (!portfolioData || portfolioData.length === 0) return;

    const headers = ['Date', 'Total Value'];
    const rows = portfolioData.map(d => [d.snapshot_date, d.total_value]);
    const csvContent = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `portfolio-history-${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [portfolioData]);

  const handleRangeChange = (range) => {
    setUseCustomRange(false);
    setSelectedRange(range);
  };

  const handleCustomRangeApply = () => {
    if (customStartDate && customEndDate) setUseCustomRange(true);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-xl text-secondary">Loading portfolio data...</div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-4 md:py-8 animate-fade-in">
      <div className="mb-4 md:mb-6">
        <h1 className="text-2xl md:text-3xl font-bold text-primary mb-1">Portfolio Timeline</h1>
        <p className="text-sm text-secondary">Track your portfolio value over time</p>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-loss-bg border border-loss rounded text-loss text-sm">
          {error}
          <button onClick={fetchPortfolioData} className="ml-4 underline hover:no-underline">
            Retry
          </button>
        </div>
      )}

      <div className="card p-3 md:p-4 mb-4 md:mb-6">
        <div className="flex flex-col gap-3 md:gap-4">
          <div className="flex flex-wrap gap-2">
            {Object.entries(DATE_RANGES).map(([key, { label }]) => (
              <button
                key={key}
                onClick={() => handleRangeChange(key)}
                className={`px-3 md:px-4 py-2 rounded-md text-xs md:text-sm font-medium transition-colors touch-manipulation min-h-[44px] ${
                  selectedRange === key && !useCustomRange
                    ? 'bg-accent text-inverse'
                    : 'bg-surface-3 text-secondary hover:text-primary'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pt-3 border-t border-border">
            <input
              type="date"
              value={customStartDate}
              onChange={(e) => setCustomStartDate(e.target.value)}
              className="flex-1 px-3 py-2 border border-input-border rounded-md text-sm min-h-[44px] touch-manipulation"
            />
            <span className="text-secondary text-center sm:px-2">to</span>
            <input
              type="date"
              value={customEndDate}
              onChange={(e) => setCustomEndDate(e.target.value)}
              className="flex-1 px-3 py-2 border border-input-border rounded-md text-sm min-h-[44px] touch-manipulation"
            />
            <button
              onClick={handleCustomRangeApply}
              disabled={!customStartDate || !customEndDate}
              className="px-4 py-2 bg-surface-3 text-secondary rounded-md text-sm hover:bg-accent hover:text-inverse disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px] touch-manipulation transition-colors"
            >
              Apply
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 md:gap-4 mb-4 md:mb-6">
        <div className="card p-3 md:p-4">
          <h3 className="text-xs md:text-sm font-medium text-secondary mb-1">Current Value</h3>
          <p className="text-xl md:text-2xl font-bold font-mono text-primary break-words">{formatCurrency(metrics.currentValue)}</p>
        </div>
        <div className="card p-3 md:p-4">
          <h3 className="text-xs md:text-sm font-medium text-secondary mb-1">Total Gain/Loss</h3>
          <p className={`text-xl md:text-2xl font-bold font-mono break-words ${metrics.totalGrowth >= 0 ? 'text-gain' : 'text-loss'}`}>
            {formatCurrency(metrics.totalGrowth)}
          </p>
          <p className={`text-xs md:text-sm font-mono ${metrics.percentChange >= 0 ? 'text-gain' : 'text-loss'}`}>
            {formatPercent(metrics.percentChange)}
          </p>
        </div>
        <div className="card p-3 md:p-4">
          <h3 className="text-xs md:text-sm font-medium text-secondary mb-1">Avg Monthly Change</h3>
          <p className={`text-xl md:text-2xl font-bold font-mono break-words ${metrics.avgMonthlyChange >= 0 ? 'text-gain' : 'text-loss'}`}>
            {formatCurrency(metrics.avgMonthlyChange)}
          </p>
        </div>
        <div className="card p-3 md:p-4">
          <h3 className="text-xs md:text-sm font-medium text-secondary mb-1">All-Time High</h3>
          <p className="text-xl md:text-2xl font-bold font-mono text-gain break-words">{formatCurrency(metrics.allTimeHigh)}</p>
          {metrics.peakDate && (
            <p className="text-xs text-tertiary">{formatDateDisplay(metrics.peakDate)}</p>
          )}
        </div>
        <div className="card p-3 md:p-4">
          <h3 className="text-xs md:text-sm font-medium text-secondary mb-1">All-Time Low</h3>
          <p className="text-xl md:text-2xl font-bold font-mono text-loss break-words">{formatCurrency(metrics.allTimeLow)}</p>
          {metrics.troughDate && (
            <p className="text-xs text-tertiary">{formatDateDisplay(metrics.troughDate)}</p>
          )}
        </div>
      </div>

      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 mb-4">
        <label className="flex items-center gap-2 cursor-pointer min-h-[44px]">
          <input
            type="checkbox"
            checked={showTrendLine}
            onChange={(e) => setShowTrendLine(e.target.checked)}
            className="w-5 h-5 touch-manipulation"
            style={{ accentColor: 'var(--accent)' }}
          />
          <span className="text-sm text-secondary">Show Trend Line</span>
        </label>
        <button
          onClick={exportToCSV}
          disabled={portfolioData.length === 0}
          className="px-4 py-2 bg-surface-3 text-secondary rounded-md text-sm hover:bg-accent hover:text-inverse disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px] touch-manipulation transition-colors"
        >
          Export CSV
        </button>
      </div>

      <div className="card p-3 md:p-4">
        {portfolioData.length === 0 ? (
          <div className="flex items-center justify-center h-[300px] md:h-[400px] text-secondary text-sm md:text-base">
            No data available for the selected date range
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={300} className="md:!h-[400px]">
            <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <defs>
                {areaGradient('colorValue', ACCENT)}
              </defs>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis
                dataKey="snapshot_date"
                tickFormatter={formatDateAxis}
                {...AXIS_STYLE}
                interval="preserveStartEnd"
              />
              <YAxis
                tickFormatter={formatCurrency}
                {...AXIS_STYLE}
                width={75}
              />
              <Tooltip
                content={<ChartTooltip formatValue={formatCurrency} formatLabel={formatDateAxis} />}
              />
              <Area
                type="monotone"
                dataKey="total_value"
                stroke={ACCENT}
                strokeWidth={2}
                fill="url(#colorValue)"
                name="Portfolio Value"
              />
              {showTrendLine && (
                <Area
                  type="monotone"
                  dataKey="trend_value"
                  stroke="#525D6E"
                  strokeWidth={1}
                  strokeDasharray="5 5"
                  fill="none"
                  name="Trend"
                />
              )}
              {metrics.peakDate && (
                <ReferenceDot
                  x={metrics.peakDate}
                  y={metrics.allTimeHigh}
                  r={4}
                  fill="var(--gain)"
                  stroke="var(--bg-surface)"
                  strokeWidth={2}
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
                />
              )}
              {portfolioData.length > 0 && (
                <ReferenceLine
                  y={metrics.startValue}
                  stroke="#525D6E"
                  strokeDasharray="5 5"
                  label={{
                    value: 'Start',
                    position: 'insideTopRight',
                    fill: '#525D6E',
                    fontSize: 10,
                  }}
                />
              )}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {portfolioData.length > 0 && (
        <div className="mt-6 card p-4">
          <h3 className="text-lg font-semibold text-primary mb-4">Period Summary</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <p className="text-sm text-secondary">Start Date</p>
              <p className="text-lg font-medium text-primary">
                {formatDateDisplay(portfolioData[0].snapshot_date)}
              </p>
              <p className="text-sm font-mono text-secondary">{formatCurrency(metrics.startValue)}</p>
            </div>
            <div>
              <p className="text-sm text-secondary">End Date</p>
              <p className="text-lg font-medium text-primary">
                {formatDateDisplay(portfolioData[portfolioData.length - 1].snapshot_date)}
              </p>
              <p className="text-sm font-mono text-secondary">{formatCurrency(metrics.currentValue)}</p>
            </div>
            <div>
              <p className="text-sm text-secondary">Period Change</p>
              <p className={`text-lg font-medium font-mono ${metrics.totalGrowth >= 0 ? 'text-gain' : 'text-loss'}`}>
                {formatCurrency(metrics.totalGrowth)} ({formatPercent(metrics.percentChange)})
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PortfolioTimeline;
