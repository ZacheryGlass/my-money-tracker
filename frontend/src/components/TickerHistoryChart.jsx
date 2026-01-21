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

const formatCurrency = (value) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
};

const formatDate = (dateString) => {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
};

const CustomTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white p-3 border border-gray-200 rounded shadow-lg">
        <p className="font-medium text-gray-900 mb-1">{formatDate(label)}</p>
        {payload.map((entry, index) => (
          <p key={index} style={{ color: entry.color }} className="text-sm">
            {entry.name}: {formatCurrency(entry.value)}
          </p>
        ))}
      </div>
    );
  }
  return null;
};

const COLORS = [
  '#3B82F6', // blue
  '#10B981', // green
  '#F59E0B', // amber
  '#EF4444', // red
  '#8B5CF6', // violet
  '#EC4899', // pink
  '#06B6D4', // cyan
  '#F97316', // orange
];

const TickerHistoryChart = ({ data, tickers }) => {
  const isMobile = useIsMobile();
  
  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 md:h-64 bg-gray-50 rounded-lg border border-gray-200">
        <p className="text-sm md:text-base text-gray-500 text-center px-4">No data available for the selected criteria</p>
      </div>
    );
  }

  // Transform data for multiple tickers
  const chartData = data.reduce((acc, item) => {
    const dateKey = item.snapshot_date.split('T')[0];
    let existing = acc.find((d) => d.date === dateKey);
    if (!existing) {
      existing = { date: dateKey };
      acc.push(existing);
    }
    existing[item.ticker] = parseFloat(item.value);
    return acc;
  }, []);

  // Sort by date
  chartData.sort((a, b) => new Date(a.date) - new Date(b.date));

  // Get unique tickers from data
  const uniqueTickers = tickers || [...new Set(data.map((item) => item.ticker))];

  return (
    <div className="w-full h-64 md:h-96 bg-white rounded-lg p-2 md:p-4">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={chartData}
          margin={{ top: 5, right: isMobile ? 5 : 30, left: isMobile ? 0 : 20, bottom: 5 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
          <XAxis
            dataKey="date"
            tickFormatter={formatDate}
            stroke="#6B7280"
            fontSize={isMobile ? 10 : 12}
            interval="preserveStartEnd"
          />
          <YAxis
            tickFormatter={formatCurrency}
            stroke="#6B7280"
            fontSize={isMobile ? 10 : 12}
            width={isMobile ? 60 : 80}
          />
          <Tooltip content={<CustomTooltip />} />
          {uniqueTickers.length > 1 && <Legend wrapperStyle={{ fontSize: isMobile ? '12px' : '14px' }} />}
          {uniqueTickers.map((ticker, index) => (
            <Line
              key={ticker}
              type="monotone"
              dataKey={ticker}
              name={ticker}
              stroke={COLORS[index % COLORS.length]}
              strokeWidth={isMobile ? 1.5 : 2}
              dot={chartData.length < 30 ? { r: isMobile ? 2 : 4, fill: COLORS[index % COLORS.length] } : false}
              activeDot={{ r: isMobile ? 4 : 6 }}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default TickerHistoryChart;
