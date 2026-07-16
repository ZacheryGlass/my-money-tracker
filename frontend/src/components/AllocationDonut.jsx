import React, { useMemo } from 'react';
import { PieChart, Pie, Cell, Tooltip } from 'recharts';
import { PieChart as PieIcon } from 'lucide-react';
import { CHART_COLORS } from '../utils/chartTheme';
import { formatCompactCurrency, formatPercent } from '../utils/format';
import ChartTooltip from './ChartTooltip';
import { buildAccountDisplayNameMap } from '../utils/accountDisplay';
import ResponsiveContainer from './ResponsiveContainer';
import { ASSET_CLASS_ORDER, getAssetClass } from '../utils/assetClass';
import { useIsMobile } from '../hooks/useMediaQuery';

const AllocationDonut = ({
  items = [],
  className = '',
  compact = false,
  groupBy = 'account',
  mobileBar = false,
  selectedName = null,
  onSelect = null,
}) => {
  const isMobile = useIsMobile();
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
      const key = groupBy === 'assetClass'
        ? getAssetClass(item)
        : item.account_id ?? item.account ?? 'Other';
      if (!grouped[key]) {
        grouped[key] = {
          name: groupBy === 'assetClass'
            ? key
            : accountDisplayNames.get(item.account_id) || item.account || 'Other',
          value: 0,
        };
      }
      grouped[key].value += item.value || 0;
    });

    const slices = Object.values(grouped)
      .filter((group) => group.value > 0)
      .sort((a, b) => {
        if (groupBy !== 'assetClass') return b.value - a.value;
        return ASSET_CLASS_ORDER.indexOf(a.name) - ASSET_CLASS_ORDER.indexOf(b.name);
      })
      .map((group, i) => ({
        name: group.name,
        value: group.value,
        color: CHART_COLORS[
          groupBy === 'assetClass'
            ? Math.max(0, ASSET_CLASS_ORDER.indexOf(group.name)) % CHART_COLORS.length
            : i % CHART_COLORS.length
        ],
      }));

    const total = slices.reduce((s, d) => s + d.value, 0);
    return { slices, total };
  }, [groupBy, items]);

  if (slices.length === 0) {
    return (
      <div className={`card p-6 flex flex-col items-center justify-center text-center ${className}`} style={{ minHeight: 200 }}>
        <PieIcon size={20} className="text-tertiary mb-2" />
        <span className="text-caption text-tertiary">No allocation data available</span>
      </div>
    );
  }

  const chartSize = compact ? 190 : 220;
  const showMobileBar = mobileBar && isMobile;

  const renderLegendItem = (entry) => {
    const pct = total > 0 ? (entry.value / total) * 100 : 0;
    const contents = (
      <>
        <div className={`flex min-w-0 flex-1 items-center ${compact ? 'gap-1' : 'gap-2'}`}>
          <span
            className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <span className={`${compact ? 'leading-tight' : 'truncate'} text-body-sm text-secondary`}>{entry.name}</span>
        </div>
        <div className="text-right">
          <div className="font-money text-body-sm font-semibold text-primary">
            {formatPercent(pct, 1, { sign: false })}
          </div>
          <div className="font-money text-caption text-tertiary">
            {formatCompactCurrency(entry.value)}
          </div>
        </div>
      </>
    );

    if (!onSelect) {
      return (
        <div key={entry.name} className={`flex items-center justify-between py-1.5 ${compact ? 'gap-1 px-1' : 'gap-2 px-2'}`}>
          {contents}
        </div>
      );
    }

    return (
      <button
        key={entry.name}
        type="button"
        onClick={() => onSelect(entry.name)}
        className={`flex w-full items-center justify-between py-1.5 text-left transition-colors hover:bg-surface-2 ${
          compact ? 'gap-1 px-1' : 'gap-2 px-2'
        } ${
          selectedName === entry.name ? 'bg-accent-muted' : ''
        }`}
        aria-pressed={selectedName === entry.name}
      >
        {contents}
      </button>
    );
  };

  return (
    <div className={`${compact ? 'p-3 gap-3' : 'p-4 gap-4'} flex flex-col ${className}`}>
      <div className="flex items-center justify-between">
        <h3 className="text-caption text-tertiary uppercase tracking-wide">
          {groupBy === 'assetClass' ? 'By Asset Class' : 'By Account'}
        </h3>
        <span className="text-caption text-accent px-1.5 py-0.5 bg-accent-muted">
          {slices.length} GROUPS
        </span>
      </div>

      {showMobileBar ? (
        <div className="space-y-3">
          <div className="flex h-5 w-full overflow-hidden bg-surface-3" role="img" aria-label="Asset allocation stacked bar">
            {slices.map((entry) => (
              <button
                key={entry.name}
                type="button"
                aria-label={`${entry.name}: ${formatPercent((entry.value / total) * 100, 1, { sign: false })}`}
                onClick={() => onSelect?.(entry.name)}
                className={`h-full min-w-[3px] transition-opacity ${selectedName && selectedName !== entry.name ? 'opacity-35' : ''}`}
                style={{ width: `${(entry.value / total) * 100}%`, backgroundColor: entry.color }}
              />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-x-3 min-[420px]:grid-cols-2">
            {slices.map(renderLegendItem)}
          </div>
        </div>
      ) : (
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

          <div className={`grid w-full flex-1 grid-cols-1 gap-x-3 gap-y-1 ${compact ? '' : 'min-[480px]:grid-cols-2'}`}>
            {slices.map(renderLegendItem)}
          </div>
        </div>
      )}
    </div>
  );
};

export default AllocationDonut;
