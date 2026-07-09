import React, { useMemo } from 'react';
import { PieChart, Pie, Cell, Tooltip } from 'recharts';
import { PieChart as PieIcon } from 'lucide-react';
import { CHART_COLORS } from '../utils/chartTheme';
import { formatCompactCurrency, formatPercent } from '../utils/format';
import ChartTooltip from './ChartTooltip';
import { buildAccountDisplayNameMap } from '../utils/accountDisplay';
import ResponsiveContainer from './ResponsiveContainer';

const AllocationDonut = ({ items = [], className = '', compact = false }) => {
  const { slices, total } = useMemo(() => {
    const accountDisplayNames = buildAccountDisplayNameMap(
      items.map((item) => ({
        id: item.account_id,
        effective_name: item.account,
        account_source_name: item.account_source_name,
        name: item.account_source_name || item.account,
      }))
    );
    const grouped = {};
    items.forEach((item) => {
      if (item.type === 'liability') return;
      const key = item.account_id ?? item.account ?? 'Other';
      if (!grouped[key]) {
        grouped[key] = {
          name: accountDisplayNames.get(item.account_id) || item.account || 'Other',
          value: 0,
        };
      }
      grouped[key].value += item.value || 0;
    });

    const slices = Object.values(grouped)
      .filter((group) => group.value > 0)
      .sort((a, b) => b.value - a.value)
      .map((group, i) => ({
        name: group.name,
        value: group.value,
        color: CHART_COLORS[i % CHART_COLORS.length],
      }));

    const total = slices.reduce((s, d) => s + d.value, 0);
    return { slices, total };
  }, [items]);

  if (slices.length === 0) {
    return (
      <div className={`card p-6 flex flex-col items-center justify-center text-center ${className}`} style={{ minHeight: 200 }}>
        <PieIcon size={20} className="text-tertiary mb-2" />
        <span className="text-caption text-tertiary">No allocation data available</span>
      </div>
    );
  }

  const chartSize = compact ? 190 : 220;

  return (
    <div className={`${compact ? 'p-3 gap-3' : 'p-4 gap-4'} flex flex-col ${className}`}>
      <div className="flex items-center justify-between">
        <h3 className="text-caption text-tertiary uppercase tracking-wide">
          By Account
        </h3>
        <span className="text-caption text-accent px-1.5 py-0.5 bg-accent-muted">
          {slices.length} GROUPS
        </span>
      </div>

      <div className={`flex flex-col items-center md:flex-row ${compact ? 'gap-4' : 'gap-6'}`}>
        <div style={{ position: 'relative', width: '100%', height: chartSize, maxWidth: chartSize }} className="flex-shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={slices}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius="65%"
                outerRadius="90%"
                strokeWidth={1}
                stroke="var(--bg-surface)"
                paddingAngle={2}
                animationBegin={0}
                animationDuration={800}
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
            <div className="text-caption text-tertiary uppercase mb-0.5">Assets</div>
            <div className="font-money font-semibold text-primary text-display-sm">
              {formatCompactCurrency(total)}
            </div>
          </div>
        </div>

        <div className="grid w-full flex-1 grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
          {slices.map((entry) => {
            const pct = total > 0 ? (entry.value / total) * 100 : 0;
            return (
              <div
                key={entry.name}
                className="flex items-center justify-between gap-3 px-2 py-1 transition-colors hover:bg-surface-2"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: entry.color }}
                  />
                  <span className="text-body-sm text-secondary truncate">
                    {entry.name}
                  </span>
                </div>
                <div className="text-right">
                  <div className="font-money text-caption text-primary font-semibold">
                    {formatPercent(pct, 1, { sign: false })}
                  </div>
                  <div className="font-money text-[10px] text-tertiary">
                    {formatCompactCurrency(entry.value)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default AllocationDonut;
