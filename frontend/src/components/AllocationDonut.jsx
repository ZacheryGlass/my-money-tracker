import React, { useMemo } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { CHART_COLORS } from '../utils/chartTheme';
import { formatCompactCurrency, formatPercent } from '../utils/format';
import ChartTooltip from './ChartTooltip';

const AllocationDonut = ({ items = [], className = '' }) => {
  const { slices, total } = useMemo(() => {
    const grouped = {};
    items.forEach((item) => {
      if (item.type === 'liability') return;
      const key = item.account || 'Other';
      grouped[key] = (grouped[key] || 0) + (item.value || 0);
    });

    const slices = Object.entries(grouped)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([name, value], i) => ({
        name,
        value,
        color: CHART_COLORS[i % CHART_COLORS.length],
      }));

    const total = slices.reduce((s, d) => s + d.value, 0);
    return { slices, total };
  }, [items]);

  if (slices.length === 0) {
    return (
      <div className={`card p-5 flex items-center justify-center ${className}`} style={{ minHeight: 260 }}>
        <span className="text-tertiary text-[13px]">No allocation data</span>
      </div>
    );
  }

  return (
    <div className={`card p-5 flex flex-col gap-4 ${className}`}>
      <span className="text-[10px] font-semibold tracking-widest uppercase text-secondary">
        Allocation by Account
      </span>

      <div style={{ position: 'relative', width: '100%', height: 200 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius="55%"
              outerRadius="80%"
              strokeWidth={0}
              paddingAngle={2}
            >
              {slices.map((entry) => (
                <Cell key={entry.name} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip
              content={
                <ChartTooltip
                  formatValue={(value) => formatCompactCurrency(value)}
                />
              }
            />
          </PieChart>
        </ResponsiveContainer>

        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center',
            pointerEvents: 'none',
          }}
        >
          <div
            className="font-mono font-bold text-primary"
            style={{ fontSize: 'clamp(0.9rem, 1.8vw, 1.1rem)', lineHeight: 1.2 }}
          >
            {formatCompactCurrency(total)}
          </div>
          <div className="text-tertiary text-[10px] mt-0.5">Total Assets</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {slices.map((entry) => {
          const pct = total > 0 ? (entry.value / total) * 100 : 0;
          return (
            <div key={entry.name} className="flex items-center gap-1.5 min-w-[120px]">
              <span
                className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: entry.color }}
              />
              <span className="text-secondary text-xs flex-1 whitespace-nowrap">
                {entry.name}
              </span>
              <span className="font-mono text-primary text-xs">
                {formatPercent(pct, 0)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default AllocationDonut;
