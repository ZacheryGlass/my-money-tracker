import React from 'react';
import { Area, AreaChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import ResponsiveContainer from './ResponsiveContainer';
import ChartTooltip from './ChartTooltip';
import { AXIS_STYLE, GRID_STYLE } from '../utils/chartTheme';
import { formatCompactCurrency, formatDateAxis } from '../utils/format';

const DashboardNetWorthChart = ({ data = [], showSpy = false, showQqq = false }) => {
  if (data.length < 2) {
    return (
      <div className="flex h-full min-h-[118px] items-center justify-center border-t border-border text-caption text-tertiary">
        Net worth history needs at least two snapshots.
      </div>
    );
  }

  const legend = [
    { key: 'value', name: 'Net worth', color: 'var(--chart-1)', dashed: false, show: true },
    { key: 'spy', name: 'S&P 500', color: 'var(--chart-3)', dashed: true, show: showSpy },
    { key: 'qqq', name: 'Nasdaq 100', color: 'var(--chart-7)', dashed: true, show: showQqq },
  ].filter((series) => series.show);

  return (
    <div className="border-t border-border">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-2 text-caption text-tertiary">
        {legend.map((series) => (
          <span key={series.key} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-0 w-3.5"
              style={{
                borderTop: `2px ${series.dashed ? 'dashed' : 'solid'} ${series.color}`,
              }}
            />
            {series.name}
          </span>
        ))}
      </div>
      <div className="h-[120px] min-h-[120px] w-full md:h-[138px] md:min-h-[138px]">
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
            {showSpy && (
              <Area
                type="monotone"
                dataKey="spy"
                name="S&P 500"
                stroke="var(--chart-3)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                strokeOpacity={0.85}
                fill="none"
                connectNulls
                isAnimationActive={false}
              />
            )}
            {showQqq && (
              <Area
                type="monotone"
                dataKey="qqq"
                name="Nasdaq 100"
                stroke="var(--chart-7)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                strokeOpacity={0.85}
                fill="none"
                connectNulls
                isAnimationActive={false}
              />
            )}
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
    </div>
  );
};

export default DashboardNetWorthChart;
