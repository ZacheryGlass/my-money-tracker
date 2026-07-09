import React, { useMemo, useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { useIsMobile } from '../hooks/useMediaQuery';
import { formatCurrency, formatDateAxis } from '../utils/format';
import { CHART_COLORS, GRID_STYLE, AXIS_STYLE } from '../utils/chartTheme';
import ChartTooltip from './ChartTooltip';
import ResponsiveContainer from './ResponsiveContainer';

const CustomLegend = ({ payload, hiddenSeries, onToggle }) => {
  return (
    <div className="mt-3 flex max-h-24 flex-wrap justify-center gap-x-2 gap-y-1 overflow-y-auto px-3">
      {payload.map((entry, index) => {
        const isHidden = hiddenSeries.includes(entry.value);
        return (
          <button
            key={`item-${index}`}
            onClick={() => onToggle(entry.value)}
            className={`flex items-center gap-1.5 px-2 py-1 transition-colors border ${
              isHidden
                ? 'opacity-40 border-transparent hover:opacity-60'
                : 'border-border hover:border-border-hover bg-surface-2'
            }`}
          >
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
            <span className={`max-w-[220px] truncate text-caption ${isHidden ? 'text-tertiary' : 'text-secondary'}`} title={entry.label || entry.value}>
              {entry.label || entry.value}
            </span>
          </button>
        );
      })}
    </div>
  );
};

const TickerHistoryChart = ({ data, series, tickers, loading }) => {
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
      dateMap.get(dateKey)[item.seriesKey || item.ticker] = parseFloat(item.value);
    });

    return Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [data]);

  const uniqueSeries = useMemo(() => {
    if (series && series.length > 0) return series.map((item) => ({ key: item.key, label: item.label || item.ticker }));
    if (tickers && tickers.length > 0) return tickers.map((ticker) => ({ key: ticker, label: ticker }));
    return [...new Set(data.map(item => item.seriesKey || item.ticker))]
      .sort()
      .map((key) => ({
        key,
        label: data.find((item) => (item.seriesKey || item.ticker) === key)?.seriesLabel || key,
      }));
  }, [data, series, tickers]);

  const legendPayload = useMemo(() => {
    return uniqueSeries.map((item, index) => ({
      value: item.key,
      label: item.label,
      type: 'line',
      id: item.key,
      color: CHART_COLORS[index % CHART_COLORS.length]
    }));
  }, [uniqueSeries]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 md:h-[400px] card">
        <div className="flex flex-col items-center gap-3">
          <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <span className="text-caption text-tertiary">Loading...</span>
        </div>
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 md:h-[400px] card">
        <p className="text-body-sm text-tertiary text-center px-4">
          No history data found for the selected tickers or date range.
        </p>
      </div>
    );
  }

  return (
    <div className="card p-4 mb-4">
      <div className="h-64 md:h-[400px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={chartData}
            margin={{ top: 10, right: isMobile ? 10 : 30, left: isMobile ? 0 : 20, bottom: 10 }}
          >
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
            {uniqueSeries.map((item, index) => (
              <Line
                key={item.key}
                type="monotone"
                dataKey={item.key}
                name={item.label}
                stroke={CHART_COLORS[index % CHART_COLORS.length]}
                strokeWidth={isMobile ? 1 : 1.5}
                dot={false}
                activeDot={{ r: isMobile ? 3 : 4, strokeWidth: 0, fill: CHART_COLORS[index % CHART_COLORS.length] }}
                connectNulls
                hide={hiddenSeries.includes(item.key)}
                animationDuration={800}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      
      {uniqueSeries.length > 1 && (
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
