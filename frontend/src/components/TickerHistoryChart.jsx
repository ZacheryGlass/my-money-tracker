import React from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { useIsMobile } from '../hooks/useMediaQuery';
import { formatCurrency, formatDateAxis } from '../utils/format';
import { CHART_COLORS, GRID_STYLE, AXIS_STYLE } from '../utils/chartTheme';
import ChartTooltip from './ChartTooltip';

const TickerHistoryChart = ({ data, tickers }) => {
  const isMobile = useIsMobile();

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 md:h-64 bg-surface-2 rounded-md border border-border">
        <p className="text-sm md:text-base text-secondary text-center px-4">
          No data available for the selected criteria
        </p>
      </div>
    );
  }

  const chartData = data.reduce((acc, item) => {
    const dateKey = item.snapshot_date.split('T')[0];
    let existing = acc.find(d => d.date === dateKey);
    if (!existing) {
      existing = { date: dateKey };
      acc.push(existing);
    }
    existing[item.ticker] = parseFloat(item.value);
    return acc;
  }, []);

  chartData.sort((a, b) => new Date(a.date) - new Date(b.date));

  const uniqueTickers = tickers || [...new Set(data.map(item => item.ticker))];

  return (
    <div className="w-full h-64 md:h-96">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={chartData}
          margin={{ top: 5, right: isMobile ? 5 : 20, left: isMobile ? 0 : 10, bottom: 5 }}
        >
          <CartesianGrid {...GRID_STYLE} />
          <XAxis
            dataKey="date"
            tickFormatter={formatDateAxis}
            {...AXIS_STYLE}
            interval="preserveStartEnd"
          />
          <YAxis
            tickFormatter={formatCurrency}
            {...AXIS_STYLE}
            width={isMobile ? 60 : 80}
          />
          <Tooltip
            content={<ChartTooltip formatValue={formatCurrency} formatLabel={formatDateAxis} />}
          />
          {uniqueTickers.length > 1 && (
            <Legend
              wrapperStyle={{
                fontSize: isMobile ? '11px' : '13px',
                color: 'var(--text-secondary)',
              }}
            />
          )}
          {uniqueTickers.map((ticker, index) => (
            <Line
              key={ticker}
              type="monotone"
              dataKey={ticker}
              name={ticker}
              stroke={CHART_COLORS[index % CHART_COLORS.length]}
              strokeWidth={isMobile ? 1.5 : 2}
              dot={chartData.length < 30 ? { r: isMobile ? 2 : 3, fill: CHART_COLORS[index % CHART_COLORS.length] } : false}
              activeDot={{ r: isMobile ? 4 : 5 }}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default TickerHistoryChart;
