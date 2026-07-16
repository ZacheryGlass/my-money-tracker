import React from 'react';
import { Area, AreaChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import ResponsiveContainer from './ResponsiveContainer';
import ChartTooltip from './ChartTooltip';
import { AXIS_STYLE, GRID_STYLE } from '../utils/chartTheme';
import { formatCompactCurrency, formatDateAxis } from '../utils/format';

const DashboardNetWorthChart = ({ data = [] }) => {
  if (data.length < 2) {
    return (
      <div className="flex h-full min-h-[118px] items-center justify-center border-t border-border text-caption text-tertiary">
        Net worth history needs at least two snapshots.
      </div>
    );
  }

  return (
    <div className="h-[132px] min-h-[132px] w-full md:h-[150px] md:min-h-[150px]">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="dashboardNetWorthFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.28} />
              <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid {...GRID_STYLE} vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={formatDateAxis}
            minTickGap={36}
            {...AXIS_STYLE}
          />
          <YAxis
            width={58}
            tickFormatter={formatCompactCurrency}
            domain={['auto', 'auto']}
            {...AXIS_STYLE}
          />
          <Tooltip
            content={<ChartTooltip formatValue={formatCompactCurrency} />}
            labelFormatter={formatDateAxis}
          />
          <Area
            type="monotone"
            dataKey="value"
            name="Net worth"
            stroke="var(--chart-1)"
            strokeWidth={2}
            fill="url(#dashboardNetWorthFill)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};

export default DashboardNetWorthChart;
