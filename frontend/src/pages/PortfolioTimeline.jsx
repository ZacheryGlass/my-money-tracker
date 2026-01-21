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

// Pagination constant
const PAGE_SIZE = 100;

// Date range presets
const DATE_RANGES = {
  '1M': { label: '1 Month', days: 30 },
  '3M': { label: '3 Months', days: 90 },
  '6M': { label: '6 Months', days: 180 },
  '1Y': { label: '1 Year', days: 365 },
  'YTD': { label: 'Year to Date', days: null },
  'ALL': { label: 'All Time', days: null },
};

// Format currency
const formatCurrency = (value) => {
  if (value === null || value === undefined) return '-';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
};

// Format percentage
const formatPercent = (value) => {
  if (value === null || value === undefined) return '-';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
};

// Format date for display
const formatDateDisplay = (dateString) => {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

// Format date for chart axis
const formatDateAxis = (dateString) => {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
};

// Calculate date range
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

// Custom tooltip component
const CustomTooltip = ({ active, payload }) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div className="bg-white p-3 border border-gray-200 rounded-lg shadow-lg">
        <p className="text-sm text-gray-600 mb-1">{formatDateDisplay(data.snapshot_date)}</p>
        <p className="text-lg font-semibold text-gray-900">{formatCurrency(data.total_value)}</p>
      </div>
    );
  }
  return null;
};

// Calculate linear regression for trend line
const calculateTrendLine = (data) => {
  if (!data || data.length < 2) return [];

  const n = data.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

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

  // Fetch portfolio data
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

      // Fetch all data by using a large limit
      const response = await historyAPI.getPortfolio({
        startDate,
        endDate,
        limit: PAGE_SIZE,
      });

      // Handle pagination if there's more data
      let allData = response.data || [];
      let offset = PAGE_SIZE;
      const total = response.pagination?.total || 0;

      while (offset < total) {
        const moreResponse = await historyAPI.getPortfolio({
          startDate,
          endDate,
          limit: PAGE_SIZE,
          offset,
        });
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

  // Calculate metrics
  const metrics = useMemo(() => {
    if (!portfolioData || portfolioData.length === 0) {
      return {
        currentValue: 0,
        startValue: 0,
        totalGrowth: 0,
        percentChange: 0,
        avgMonthlyChange: 0,
        allTimeHigh: 0,
        allTimeLow: 0,
        peakDate: null,
        troughDate: null,
      };
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

    // Calculate average monthly change
    let avgMonthlyChange = 0;
    if (portfolioData.length >= 2) {
      const firstDate = new Date(portfolioData[0].snapshot_date);
      const lastDate = new Date(portfolioData[portfolioData.length - 1].snapshot_date);
      const months = (lastDate - firstDate) / (1000 * 60 * 60 * 24 * 30.44);
      if (months > 0) {
        avgMonthlyChange = totalGrowth / months;
      }
    }

    return {
      currentValue,
      startValue,
      totalGrowth,
      percentChange,
      avgMonthlyChange,
      allTimeHigh,
      allTimeLow,
      peakDate,
      troughDate,
    };
  }, [portfolioData]);

  // Add trend line data
  const chartData = useMemo(() => {
    if (!portfolioData || portfolioData.length === 0) return [];
    return showTrendLine ? calculateTrendLine(portfolioData) : portfolioData;
  }, [portfolioData, showTrendLine]);

  // Export to CSV
  const exportToCSV = useCallback(() => {
    if (!portfolioData || portfolioData.length === 0) return;

    const headers = ['Date', 'Total Value'];
    const rows = portfolioData.map(d => [
      d.snapshot_date,
      d.total_value,
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.join(',')),
    ].join('\n');

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

  // Handle preset range change
  const handleRangeChange = (range) => {
    setUseCustomRange(false);
    setSelectedRange(range);
  };

  // Handle custom date range
  const handleCustomRangeApply = () => {
    if (customStartDate && customEndDate) {
      setUseCustomRange(true);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-xl text-gray-600">Loading portfolio data...</div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Portfolio Timeline</h1>
        <p className="text-gray-600">Track your portfolio value over time</p>
      </div>

      {/* Error Message */}
      {error && (
        <div className="mb-4 p-4 bg-red-100 border border-red-400 text-red-700 rounded">
          {error}
          <button
            onClick={fetchPortfolioData}
            className="ml-4 underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* Date Range Selector */}
      <div className="bg-white shadow-md rounded-lg p-4 mb-6">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex flex-wrap gap-2">
            {Object.entries(DATE_RANGES).map(([key, { label }]) => (
              <button
                key={key}
                onClick={() => handleRangeChange(key)}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  selectedRange === key && !useCustomRange
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 border-l pl-4">
            <input
              type="date"
              value={customStartDate}
              onChange={(e) => setCustomStartDate(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
            <span className="text-gray-500">to</span>
            <input
              type="date"
              value={customEndDate}
              onChange={(e) => setCustomEndDate(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
            <button
              onClick={handleCustomRangeApply}
              disabled={!customStartDate || !customEndDate}
              className="px-4 py-2 bg-gray-600 text-white rounded-md text-sm hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Apply
            </button>
          </div>
        </div>
      </div>

      {/* Metrics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <div className="bg-white shadow-md rounded-lg p-4">
          <h3 className="text-sm font-medium text-gray-500 mb-1">Current Value</h3>
          <p className="text-2xl font-bold text-gray-900">{formatCurrency(metrics.currentValue)}</p>
        </div>
        <div className="bg-white shadow-md rounded-lg p-4">
          <h3 className="text-sm font-medium text-gray-500 mb-1">Total Gain/Loss</h3>
          <p className={`text-2xl font-bold ${metrics.totalGrowth >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {formatCurrency(metrics.totalGrowth)}
          </p>
          <p className={`text-sm ${metrics.percentChange >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {formatPercent(metrics.percentChange)}
          </p>
        </div>
        <div className="bg-white shadow-md rounded-lg p-4">
          <h3 className="text-sm font-medium text-gray-500 mb-1">Avg Monthly Change</h3>
          <p className={`text-2xl font-bold ${metrics.avgMonthlyChange >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {formatCurrency(metrics.avgMonthlyChange)}
          </p>
        </div>
        <div className="bg-white shadow-md rounded-lg p-4">
          <h3 className="text-sm font-medium text-gray-500 mb-1">All-Time High</h3>
          <p className="text-2xl font-bold text-green-600">{formatCurrency(metrics.allTimeHigh)}</p>
          {metrics.peakDate && (
            <p className="text-xs text-gray-500">{formatDateDisplay(metrics.peakDate)}</p>
          )}
        </div>
        <div className="bg-white shadow-md rounded-lg p-4">
          <h3 className="text-sm font-medium text-gray-500 mb-1">All-Time Low</h3>
          <p className="text-2xl font-bold text-red-600">{formatCurrency(metrics.allTimeLow)}</p>
          {metrics.troughDate && (
            <p className="text-xs text-gray-500">{formatDateDisplay(metrics.troughDate)}</p>
          )}
        </div>
      </div>

      {/* Chart Controls */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showTrendLine}
              onChange={(e) => setShowTrendLine(e.target.checked)}
              className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700">Show Trend Line</span>
          </label>
        </div>
        <button
          onClick={exportToCSV}
          disabled={portfolioData.length === 0}
          className="px-4 py-2 bg-green-600 text-white rounded-md text-sm hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Export CSV
        </button>
      </div>

      {/* Chart */}
      <div className="bg-white shadow-md rounded-lg p-4">
        {portfolioData.length === 0 ? (
          <div className="flex items-center justify-center h-[400px] text-gray-500">
            No data available for the selected date range
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={400}>
            <AreaChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
              <XAxis
                dataKey="snapshot_date"
                tickFormatter={formatDateAxis}
                stroke="#6B7280"
                fontSize={12}
                tickLine={false}
              />
              <YAxis
                tickFormatter={(value) => formatCurrency(value)}
                stroke="#6B7280"
                fontSize={12}
                tickLine={false}
                width={80}
              />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="total_value"
                stroke="#3B82F6"
                strokeWidth={2}
                fill="url(#colorValue)"
                name="Portfolio Value"
              />
              {showTrendLine && (
                <Area
                  type="monotone"
                  dataKey="trend_value"
                  stroke="#9CA3AF"
                  strokeWidth={1}
                  strokeDasharray="5 5"
                  fill="none"
                  name="Trend"
                />
              )}
              {/* Peak marker */}
              {metrics.peakDate && (
                <ReferenceDot
                  x={metrics.peakDate}
                  y={metrics.allTimeHigh}
                  r={6}
                  fill="#10B981"
                  stroke="#fff"
                  strokeWidth={2}
                />
              )}
              {/* Trough marker */}
              {metrics.troughDate && metrics.troughDate !== metrics.peakDate && (
                <ReferenceDot
                  x={metrics.troughDate}
                  y={metrics.allTimeLow}
                  r={6}
                  fill="#EF4444"
                  stroke="#fff"
                  strokeWidth={2}
                />
              )}
              {/* Average line */}
              {portfolioData.length > 0 && (
                <ReferenceLine
                  y={metrics.startValue}
                  stroke="#9CA3AF"
                  strokeDasharray="3 3"
                  label={{
                    value: 'Start',
                    position: 'insideTopRight',
                    fill: '#9CA3AF',
                    fontSize: 10,
                  }}
                />
              )}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Period Comparison */}
      {portfolioData.length > 0 && (
        <div className="mt-6 bg-white shadow-md rounded-lg p-4">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Period Summary</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <p className="text-sm text-gray-500">Start Date</p>
              <p className="text-lg font-medium text-gray-900">
                {portfolioData.length > 0 ? formatDateDisplay(portfolioData[0].snapshot_date) : '-'}
              </p>
              <p className="text-sm text-gray-600">{formatCurrency(metrics.startValue)}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">End Date</p>
              <p className="text-lg font-medium text-gray-900">
                {portfolioData.length > 0
                  ? formatDateDisplay(portfolioData[portfolioData.length - 1].snapshot_date)
                  : '-'}
              </p>
              <p className="text-sm text-gray-600">{formatCurrency(metrics.currentValue)}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Period Change</p>
              <p className={`text-lg font-medium ${metrics.totalGrowth >= 0 ? 'text-green-600' : 'text-red-600'}`}>
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
