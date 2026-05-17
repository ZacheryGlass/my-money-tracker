import React, { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts';
import { GRID_STYLE, AXIS_STYLE } from '../utils/chartTheme';
import ChartTooltip from './ChartTooltip';
import { formatCompactCurrency } from '../utils/format';
import { useIsMobile } from '../hooks/useMediaQuery';

export default function WaterfallChart({ data = [], height = 350 }) {
  const isMobile = useIsMobile();

  const chartData = useMemo(() => {
    const result = [];
    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      const prev = i > 0 ? result[i - 1] : null;
      const prevCum = prev ? prev.base + (prev.rawDelta >= 0 ? prev.delta : -prev.delta) : 0;
      const base = item.delta >= 0 ? prevCum : prevCum + item.delta;
      result.push({
        name: item.name,
        base: Math.round(base * 100) / 100,
        delta: Math.round(Math.abs(item.delta) * 100) / 100,
        rawDelta: item.delta,
        isTotal: item.isTotal || false,
      });
    }
    return result;
  }, [data]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center text-tertiary text-sm" style={{ height }}>
        No data available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={chartData} margin={{ top: 10, right: 10, left: isMobile ? 0 : 10, bottom: 5 }}>
        <CartesianGrid {...GRID_STYLE} vertical={false} />
        <XAxis
          dataKey="name"
          {...AXIS_STYLE}
          tick={{ ...AXIS_STYLE, fontSize: isMobile ? 9 : 11 }}
          interval={0}
          angle={isMobile ? -45 : 0}
          textAnchor={isMobile ? 'end' : 'middle'}
          height={isMobile ? 60 : 30}
        />
        <YAxis
          {...AXIS_STYLE}
          tickFormatter={formatCompactCurrency}
          width={isMobile ? 45 : 60}
        />
        <Tooltip
          content={<ChartTooltip formatValue={(val, name, entry) => {
            if (!entry || !entry.payload) return formatCompactCurrency(val);
            const raw = entry.payload.rawDelta;
            const sign = raw >= 0 ? '+' : '';
            return `${sign}${formatCompactCurrency(raw)}`;
          }} />}
          cursor={{ fill: 'rgba(255,255,255,0.03)' }}
        />
        <ReferenceLine y={0} stroke="var(--border)" />
        <Bar dataKey="base" stackId="waterfall" fill="transparent" isAnimationActive={false} />
        <Bar dataKey="delta" stackId="waterfall" radius={[4, 4, 0, 0]} animationDuration={1000}>
          {chartData.map((entry, i) => (
            <Cell
              key={i}
              fill={entry.isTotal
                ? 'var(--accent)'
                : entry.rawDelta >= 0
                  ? 'var(--gain)'
                  : 'var(--loss)'}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
