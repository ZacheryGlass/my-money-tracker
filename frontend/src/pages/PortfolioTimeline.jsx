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
import { motion, AnimatePresence } from 'framer-motion';
import { Calendar, Download, TrendingUp, Filter, ChevronDown, ChevronUp, Clock, Award, Target, Check } from 'lucide-react';
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

const ACCENT = '#00FFCC';

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
  const [filtersExpanded, setFiltersExpanded] = useState(true);

  const fetchPortfolioData = useCallback(async () => {
    setLoading(true);

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
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <div className="w-10 h-10 border-4 border-accent border-t-transparent rounded-full animate-spin shadow-glow" />
        <span className="text-xs font-bold tracking-widest uppercase text-tertiary animate-pulse">Rendering Timeline</span>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 md:py-8">
      {/* Header Section */}
      <div className="flex flex-col md:flex-row md:items-end justify-between mb-8 gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Clock className="text-accent w-5 h-5" />
            <h1 className="text-2xl md:text-3xl font-bold text-primary tracking-tight">Portfolio Timeline</h1>
          </div>
          <p className="text-sm text-secondary">Historical analysis of your aggregated portfolio value</p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex bg-surface-2 p-1 rounded-xl border border-border shadow-inner">
            {Object.keys(DATE_RANGES).map((range) => (
              <button
                key={range}
                onClick={() => handleRangeChange(range)}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-bold tracking-wider transition-all duration-200 ${
                  selectedRange === range && !useCustomRange
                    ? 'bg-accent text-inverse shadow-glow scale-105'
                    : 'text-tertiary hover:text-secondary'
                }`}
              >
                {range}
              </button>
            ))}
          </div>
          <button
            onClick={exportToCSV}
            disabled={portfolioData.length === 0}
            className="p-2.5 bg-surface-2 text-secondary hover:text-accent border border-border rounded-xl transition-all shadow-sm"
            title="Export CSV"
          >
            <Download size={18} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Sidebar Filters */}
        <div className="lg:col-span-1 space-y-6">
          <div className="card overflow-hidden">
            <button 
              onClick={() => setFiltersExpanded(!filtersExpanded)}
              className="w-full flex items-center justify-between p-4 border-b border-border bg-surface-2/50"
            >
              <div className="flex items-center gap-2">
                <Filter size={16} className="text-accent" />
                <span className="text-sm font-bold uppercase tracking-widest text-primary">Controls</span>
              </div>
              {filtersExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>

            <AnimatePresence initial={false}>
              {filtersExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.3 }}
                >
                  <div className="p-4 space-y-6">
                    {/* Metrics Overview in Sidebar */}
                    <div className="space-y-4">
                      <div className="p-3 bg-surface-3 rounded-xl border border-border">
                        <p className="text-[10px] font-bold text-tertiary uppercase tracking-widest mb-1">Current Value</p>
                        <p className="text-lg font-mono font-bold text-primary">{formatCurrency(metrics.currentValue)}</p>
                      </div>
                      <div className="p-3 bg-surface-3 rounded-xl border border-border">
                        <p className="text-[10px] font-bold text-tertiary uppercase tracking-widest mb-1">Period Growth</p>
                        <div className="flex items-end gap-2">
                          <p className={`text-lg font-mono font-bold ${metrics.totalGrowth >= 0 ? 'text-gain' : 'text-loss'}`}>
                            {formatCurrency(metrics.totalGrowth)}
                          </p>
                          <p className={`text-xs font-mono font-bold mb-1 ${metrics.percentChange >= 0 ? 'text-gain' : 'text-loss'}`}>
                            {formatPercent(metrics.percentChange)}
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Options */}
                    <div>
                      <p className="text-[10px] font-bold text-tertiary uppercase tracking-widest mb-3">Display Options</p>
                      <button
                        onClick={() => setShowTrendLine(!showTrendLine)}
                        className={`w-full flex items-center justify-between p-3 rounded-xl border transition-all ${
                          showTrendLine
                            ? 'bg-accent/10 border-accent/30 text-accent'
                            : 'bg-surface-2 border-transparent text-secondary hover:border-border'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <TrendingUp size={14} />
                          <span className="text-xs font-bold uppercase tracking-wider">Trend Line</span>
                        </div>
                        {showTrendLine && <Check size={14} />}
                      </button>
                    </div>

                    {/* Custom Range */}
                    <div className="pt-4 border-t border-border">
                      <p className="text-[10px] font-bold text-tertiary uppercase tracking-widest mb-3">Custom Range</p>
                      <div className="space-y-3">
                        <div className="space-y-1.5">
                          <label className="text-[10px] font-bold text-tertiary uppercase tracking-widest px-1">Start</label>
                          <div className="relative">
                            <input
                              type="date"
                              value={customStartDate}
                              onChange={(e) => setCustomStartDate(e.target.value)}
                              className="w-full bg-surface-3 border-border rounded-lg px-3 py-2 text-xs focus:ring-1 focus:ring-accent outline-none"
                            />
                            <Calendar size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-tertiary pointer-events-none" />
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-[10px] font-bold text-tertiary uppercase tracking-widest px-1">End</label>
                          <div className="relative">
                            <input
                              type="date"
                              value={customEndDate}
                              onChange={(e) => setCustomEndDate(e.target.value)}
                              className="w-full bg-surface-3 border-border rounded-lg px-3 py-2 text-xs focus:ring-1 focus:ring-accent outline-none"
                            />
                            <Calendar size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-tertiary pointer-events-none" />
                          </div>
                        </div>
                        <button
                          onClick={handleCustomRangeApply}
                          disabled={!customStartDate || !customEndDate}
                          className="w-full py-2 bg-surface-3 border border-border text-tertiary rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-accent hover:text-inverse hover:border-accent disabled:opacity-30 transition-all"
                        >
                          Apply Custom
                        </button>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          
          <div className="card p-4 bg-accent-muted/10 border-accent/10">
            <h4 className="text-[10px] font-bold text-accent mb-2 uppercase tracking-widest">Milestones</h4>
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <Award size={14} className="text-gain mt-0.5" />
                <div>
                  <p className="text-[10px] font-bold text-primary uppercase">All-Time High</p>
                  <p className="text-xs font-mono font-bold text-gain">{formatCurrency(metrics.allTimeHigh)}</p>
                  <p className="text-[9px] text-tertiary">{formatDateDisplay(metrics.peakDate)}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Target size={14} className="text-loss mt-0.5" />
                <div>
                  <p className="text-[10px] font-bold text-primary uppercase">All-Time Low</p>
                  <p className="text-xs font-mono font-bold text-loss">{formatCurrency(metrics.allTimeLow)}</p>
                  <p className="text-[9px] text-tertiary">{formatDateDisplay(metrics.troughDate)}</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Main Chart Area */}
        <div className="lg:col-span-3 space-y-6">
          <div className="bg-surface rounded-card border border-border p-4 md:p-6">
            <div className="h-64 md:h-[450px] w-full">
              {portfolioData.length === 0 ? (
                <div className="flex items-center justify-center h-full text-tertiary text-xs uppercase tracking-widest font-bold opacity-60">
                  No data for this range
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <filter id="area-glow" x="-20%" y="-20%" width="140%" height="140%">
                        <feGaussianBlur stdDeviation="3" result="blur" />
                        <feComposite in="SourceGraphic" in2="blur" operator="over" />
                      </filter>
                      {areaGradient('colorValue', ACCENT)}
                    </defs>
                    <CartesianGrid {...GRID_STYLE} vertical={false} strokeOpacity={0.5} />
                    <XAxis
                      dataKey="snapshot_date"
                      tickFormatter={formatDateAxis}
                      {...AXIS_STYLE}
                      interval="preserveStartEnd"
                      padding={{ left: 10, right: 10 }}
                      minTickGap={40}
                    />
                    <YAxis
                      tickFormatter={formatCurrency}
                      {...AXIS_STYLE}
                      width={80}
                      axisLine={false}
                    />
                    <Tooltip
                      content={<ChartTooltip formatValue={formatCurrency} formatLabel={formatDateAxis} />}
                      cursor={{ stroke: 'var(--border)', strokeWidth: 1 }}
                    />
                    <Area
                      type="monotone"
                      dataKey="total_value"
                      stroke={ACCENT}
                      strokeWidth={3}
                      fill="url(#colorValue)"
                      name="Portfolio Value"
                      animationDuration={1500}
                      filter="url(#area-glow)"
                    />
                    {showTrendLine && (
                      <Area
                        type="monotone"
                        dataKey="trend_value"
                        stroke="var(--text-tertiary)"
                        strokeWidth={1.5}
                        strokeDasharray="6 4"
                        fill="none"
                        name="Trend Line"
                        animationDuration={1500}
                      />
                    )}
                    {metrics.peakDate && (
                      <ReferenceDot
                        x={metrics.peakDate}
                        y={metrics.allTimeHigh}
                        r={6}
                        fill="var(--gain)"
                        stroke="var(--bg-surface)"
                        strokeWidth={3}
                      />
                    )}
                    {metrics.troughDate && metrics.troughDate !== metrics.peakDate && (
                      <ReferenceDot
                        x={metrics.troughDate}
                        y={metrics.allTimeLow}
                        r={6}
                        fill="var(--loss)"
                        stroke="var(--bg-surface)"
                        strokeWidth={3}
                      />
                    )}
                    {portfolioData.length > 0 && (
                      <ReferenceLine
                        y={metrics.startValue}
                        stroke="var(--text-tertiary)"
                        strokeDasharray="4 4"
                        strokeOpacity={0.5}
                      />
                    )}
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Period Summary Grid */}
          {portfolioData.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="card p-4 bg-surface-2/30 border-border/50">
                <p className="text-[10px] font-bold text-tertiary uppercase tracking-widest mb-1">Period Start</p>
                <p className="text-sm font-bold text-primary">{formatDateDisplay(portfolioData[0].snapshot_date)}</p>
                <p className="text-xs font-mono text-tertiary mt-1">{formatCurrency(metrics.startValue)}</p>
              </div>
              <div className="card p-4 bg-surface-2/30 border-border/50">
                <p className="text-[10px] font-bold text-tertiary uppercase tracking-widest mb-1">Period End</p>
                <p className="text-sm font-bold text-primary">{formatDateDisplay(portfolioData[portfolioData.length - 1].snapshot_date)}</p>
                <p className="text-xs font-mono text-tertiary mt-1">{formatCurrency(metrics.currentValue)}</p>
              </div>
              <div className="card p-4 bg-surface-2/30 border-border/50">
                <p className="text-[10px] font-bold text-tertiary uppercase tracking-widest mb-1">Avg Monthly Delta</p>
                <p className={`text-sm font-bold font-mono ${metrics.avgMonthlyChange >= 0 ? 'text-gain' : 'text-loss'}`}>
                  {formatCurrency(metrics.avgMonthlyChange)}
                </p>
                <p className="text-[10px] text-tertiary uppercase mt-1">Growth Velocity</p>
              </div>
            </div>
          )}
          
          {/* Helper text */}
          <div className="flex items-center justify-center gap-6 text-[10px] text-tertiary uppercase tracking-widest font-bold">
            <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-accent shadow-glow" /> Area visualization</span>
            <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-surface-3 border border-border" /> High/Low tracking</span>
            <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-surface-3 border border-border" /> Linear regression trend</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PortfolioTimeline;
