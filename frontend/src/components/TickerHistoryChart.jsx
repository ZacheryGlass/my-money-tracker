import React, { useMemo, useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { useIsMobile } from '../hooks/useMediaQuery';
import { formatCurrency, formatDateAxis } from '../utils/format';
import { CHART_COLORS, GRID_STYLE, AXIS_STYLE } from '../utils/chartTheme';
import ChartTooltip from './ChartTooltip';

const CustomLegend = ({ payload, hiddenSeries, onToggle }) => {
  const isMobile = useIsMobile();
  
  return (
    <div className="flex flex-wrap justify-center gap-x-3 gap-y-2 mt-6 px-4">
      {payload.map((entry, index) => {
        const isHidden = hiddenSeries.includes(entry.value);
        return (
          <button
            key={`item-${index}`}
            onClick={() => onToggle(entry.value)}
            className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg transition-all border ${
              isHidden 
                ? 'opacity-40 grayscale border-transparent hover:opacity-60 bg-surface-2/30' 
                : 'opacity-100 border-border hover:border-accent/30 bg-surface-2/50 shadow-sm'
            }`}
          >
            <div 
              className="w-2.5 h-2.5 rounded-full shadow-sm" 
              style={{ backgroundColor: entry.color }}
            />
            <span className={`text-[10px] md:text-xs font-bold tracking-tight ${isHidden ? 'text-tertiary' : 'text-secondary'}`}>
              {entry.value}
            </span>
          </button>
        );
      })}
    </div>
  );
};

const TickerHistoryChart = ({ data, tickers, loading }) => {
  const isMobile = useIsMobile();
  const [hiddenSeries, setHiddenSeries] = useState([]);

  const toggleSeries = (name) => {
    setHiddenSeries(prev => 
      prev.includes(name) 
        ? prev.filter(n => n !== name) 
        : [...prev, name]
    );
  };

  const chartData = useMemo(() => {
    if (!data || data.length === 0) return [];
    
    const dateMap = new Map();
    data.forEach(item => {
      const dateKey = item.snapshot_date.split('T')[0];
      if (!dateMap.has(dateKey)) {
        dateMap.set(dateKey, { date: dateKey });
      }
      dateMap.get(dateKey)[item.ticker] = parseFloat(item.value);
    });

    return Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [data]);

  const uniqueTickers = useMemo(() => {
    if (tickers && tickers.length > 0) return tickers;
    return [...new Set(data.map(item => item.ticker))].sort();
  }, [data, tickers]);

  const legendPayload = useMemo(() => {
    return uniqueTickers.map((ticker, index) => ({
      value: ticker,
      type: 'line',
      id: ticker,
      color: CHART_COLORS[index % CHART_COLORS.length]
    }));
  }, [uniqueTickers]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 md:h-[450px] bg-surface rounded-card border border-border">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-3 border-accent border-t-transparent rounded-full animate-spin" />
          <span className="text-xs font-bold uppercase tracking-widest text-tertiary">Processing Data</span>
        </div>
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 md:h-[450px] bg-surface rounded-card border border-border">
        <p className="text-sm md:text-base text-secondary text-center px-4 font-medium opacity-60">
          No history data found for the selected tickers or date range.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-surface rounded-card border border-border p-4 md:p-6 mb-6">
      <div className="h-64 md:h-[450px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={chartData}
            margin={{ top: 10, right: isMobile ? 10 : 30, left: isMobile ? 0 : 20, bottom: 10 }}
          >
            <defs>
              <filter id="ticker-glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="1.5" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
            </defs>
            <CartesianGrid {...GRID_STYLE} vertical={false} strokeOpacity={0.5} />
            <XAxis
              dataKey="date"
              tickFormatter={formatDateAxis}
              {...AXIS_STYLE}
              padding={{ left: 10, right: 10 }}
              minTickGap={30}
            />
            <YAxis
              tickFormatter={formatCurrency}
              {...AXIS_STYLE}
              width={isMobile ? 60 : 80}
              axisLine={false}
            />
            <Tooltip
              content={<ChartTooltip formatValue={formatCurrency} formatLabel={formatDateAxis} />}
              cursor={{ stroke: 'var(--border)', strokeWidth: 1 }}
            />
            {uniqueTickers.map((ticker, index) => (
              <Line
                key={ticker}
                type="monotone"
                dataKey={ticker}
                name={ticker}
                stroke={CHART_COLORS[index % CHART_COLORS.length]}
                strokeWidth={isMobile ? 1.5 : 2.5}
                dot={false}
                activeDot={{ r: isMobile ? 4 : 6, strokeWidth: 0, fill: CHART_COLORS[index % CHART_COLORS.length] }}
                connectNulls
                hide={hiddenSeries.includes(ticker)}
                animationDuration={1000}
                filter={uniqueTickers.length === 1 ? "url(#ticker-glow)" : undefined}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      
      {uniqueTickers.length > 1 && (
        <CustomLegend 
          payload={legendPayload} 
          hiddenSeries={hiddenSeries} 
          onToggle={toggleSeries} 
        />
      )}
    </div>
  );
};

export default TickerHistoryChart;
