import React, { useMemo } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { motion } from 'framer-motion';
import { PieChart as PieIcon } from 'lucide-react';
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
      <div className={`card p-8 flex flex-col items-center justify-center text-center ${className}`} style={{ minHeight: 300 }}>
        <div className="w-12 h-12 rounded-full bg-surface-3 flex items-center justify-center text-tertiary mb-4">
          <PieIcon size={24} />
        </div>
        <span className="text-tertiary text-sm font-medium">No allocation data available</span>
      </div>
    );
  }

  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className={`card p-6 lg:p-8 flex flex-col gap-8 ${className}`}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-bold tracking-widest uppercase text-tertiary">
          Asset Allocation
        </h3>
        <div className="text-[10px] text-accent font-bold px-2 py-0.5 rounded bg-accent/10 border border-accent/20">
          BY ACCOUNT
        </div>
      </div>

      <div className="flex flex-col md:flex-row items-center gap-8">
        <div style={{ position: 'relative', width: '100%', height: 240, maxWidth: 240 }} className="flex-shrink-0">
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
                strokeWidth={2}
                stroke="var(--bg-surface)"
                paddingAngle={4}
                animationBegin={0}
                animationDuration={1500}
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
            <div className="text-tertiary text-[10px] font-bold uppercase tracking-widest mb-1">Assets</div>
            <div
              className="font-money font-bold text-primary tracking-tighter"
              style={{ fontSize: 'clamp(1.2rem, 2.5vw, 1.5rem)', lineHeight: 1 }}
            >
              {formatCompactCurrency(total)}
            </div>
          </div>
        </div>

        <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 w-full">
          {slices.map((entry, idx) => {
            const pct = total > 0 ? (entry.value / total) * 100 : 0;
            return (
              <motion.div 
                key={entry.name} 
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: idx * 0.05 }}
                className="flex items-center justify-between p-2 rounded-xl hover:bg-surface-2 transition-colors group cursor-default"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0 shadow-sm"
                    style={{ backgroundColor: entry.color }}
                  />
                  <span className="text-secondary text-xs font-medium truncate group-hover:text-primary transition-colors">
                    {entry.name}
                  </span>
                </div>
                <div className="flex flex-col items-end">
                  <span className="font-money text-primary text-xs font-bold">
                    {formatPercent(pct, 1, { sign: false })}
                  </span>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
};

export default AllocationDonut;
