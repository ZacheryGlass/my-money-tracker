import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell,
} from 'recharts';
import { PieChart as PieIcon, Grid3X3, Layers, BarChart3, TrendingUp } from 'lucide-react';
import {
  useReactTable, getCoreRowModel, getSortedRowModel,
} from '@tanstack/react-table';
import MetricCard from '../components/MetricCard';
import DataTable from '../components/DataTable';
import ChartTooltip from '../components/ChartTooltip';
import LoadingState from '../components/LoadingState';
import ResponsiveContainer from '../components/ResponsiveContainer';
import { CHART_COLORS, GRID_STYLE, AXIS_STYLE, areaGradient } from '../utils/chartTheme';
import { formatCurrency, formatCompactCurrency, formatDateAxis, formatPercent } from '../utils/format';
import { dashboard, history, accounts as accountsApi } from '../utils/api';
import { useIsMobile } from '../hooks/useMediaQuery';
import { getAccountDisplayName } from '../utils/accountDisplay';
import { formatCategoryLabel } from '../utils/dataLabels';

const VIEWS = [
  { id: 'pie', label: 'Pie Chart', icon: PieIcon },
  { id: 'allocation', label: 'Allocation', icon: Layers },
];

const GROUP_BY_OPTIONS = ['account', 'category', 'type'];

const DATE_RANGES = [
  { id: '1m', label: '1M', days: 30 },
  { id: '3m', label: '3M', days: 90 },
  { id: '6m', label: '6M', days: 180 },
  { id: '1y', label: '1Y', days: 365 },
  { id: 'all', label: 'All', days: null },
];

function getDateRange(rangeId) {
  const range = DATE_RANGES.find((r) => r.id === rangeId);
  if (!range || !range.days) return {};
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - range.days);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

export default function HoldingsAnalysis() {
  const isMobile = useIsMobile();
  const [topHoldingsSorting, setTopHoldingsSorting] = useState([{ id: 'value', desc: true }]);
  const [view, setView] = useState('pie');
  const [groupBy, setGroupBy] = useState('account');
  const [dateRange, setDateRange] = useState('3m');
  const [loading, setLoading] = useState(true);
  const [portfolioItems, setPortfolioItems] = useState([]);
  const [totalAssets, setTotalAssets] = useState(0);
  const [accountSnaps, setAccountSnaps] = useState([]);
  const [accountList, setAccountList] = useState([]);
  const [allocationMode, setAllocationMode] = useState('percent');
  const [selectedGroup, setSelectedGroup] = useState(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const range = getDateRange(dateRange);
      const [dashData, acctData, acctList] = await Promise.all([
        dashboard.getPortfolio(),
        history.getAccounts({ ...range, limit: 10000 }),
        accountsApi.getAll(),
      ]);

      setPortfolioItems(dashData.items || []);
      setTotalAssets(dashData.summary?.totalAssets || dashData.total || 0);
      setAccountSnaps(acctData.data || []);
      setAccountList(acctList.accounts || []);

    } catch (err) {
      console.error('Failed to load holdings analysis data:', err);
    } finally {
      setLoading(false);
    }
  }, [dateRange]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => { setSelectedGroup(null); }, [groupBy, view]);

  const assetItems = useMemo(() => {
    return portfolioItems
      .filter((i) => i.type === 'asset')
      .map((item) => ({
        ...item,
        valueNumber: Math.abs(parseFloat(item.value)) || 0,
        categoryLabel: formatCategoryLabel(item.category),
        accountTypeLabel: formatCategoryLabel(item.account_type),
      }))
      .sort((a, b) => b.valueNumber - a.valueNumber);
  }, [portfolioItems]);

  const concentration = useMemo(() => {
    const topHolding = assetItems[0] || null;
    const topHoldingShare = totalAssets > 0 && topHolding ? (topHolding.valueNumber / totalAssets) * 100 : 0;
    const topFiveValue = assetItems.slice(0, 5).reduce((sum, item) => sum + item.valueNumber, 0);
    const topFiveShare = totalAssets > 0 ? (topFiveValue / totalAssets) * 100 : 0;
    return { topHolding, topHoldingShare, topFiveShare };
  }, [assetItems, totalAssets]);

  const groupedData = useMemo(() => {
    const groups = {};
    for (const item of assetItems) {
      const key = groupBy === 'account' ? item.account
        : groupBy === 'category' ? item.categoryLabel
        : item.accountTypeLabel;
      if (!groups[key]) groups[key] = { name: key, children: [], total: 0 };
      groups[key].children.push({
        name: item.name || item.ticker,
        ticker: item.ticker,
        size: item.valueNumber,
        account: item.account,
        category: item.categoryLabel,
      });
      groups[key].total += item.valueNumber;
    }

    return Object.values(groups)
      .sort((a, b) => b.total - a.total)
      .map((g, i) => ({
        ...g,
        color: CHART_COLORS[i % CHART_COLORS.length],
        share: totalAssets > 0 ? (g.total / totalAssets) * 100 : 0,
        children: g.children.map((c) => ({
          ...c,
          color: CHART_COLORS[i % CHART_COLORS.length],
          group: g.name,
          share: totalAssets > 0 ? (c.size / totalAssets) * 100 : 0,
        })),
      }));
  }, [assetItems, groupBy, totalAssets]);

  const flatGroupedData = useMemo(() => {
    return groupedData.flatMap((g) =>
      g.children.map((c) => ({ ...c, color: g.color, group: g.name }))
    );
  }, [groupedData]);

  const selectedGroupRows = useMemo(() => {
    if (!selectedGroup) return assetItems.slice(0, 6);
    return flatGroupedData
      .filter((item) => item.group === selectedGroup)
      .sort((a, b) => b.size - a.size)
      .slice(0, 6);
  }, [assetItems, flatGroupedData, selectedGroup]);

  const selectedGroupTotal = useMemo(() => {
    if (!selectedGroup) return null;
    return groupedData.find((group) => group.name === selectedGroup) || null;
  }, [groupedData, selectedGroup]);

  const topHoldings = useMemo(() => assetItems.slice(0, 10), [assetItems]);

  const topHoldingsColumns = useMemo(() => [
    {
      accessorKey: 'name',
      header: 'Holding',
      meta: { cellClassName: 'min-w-0' },
      cell: ({ row }) => (
        <div className="min-w-0 text-primary">
          <p className="font-semibold truncate" title={row.original.name}>{row.original.name}</p>
          {row.original.ticker && <p className="text-caption text-tertiary">{row.original.ticker}</p>}
        </div>
      ),
    },
    // Account and Category are dropped below lg rather than squeezed.
    {
      accessorKey: 'account',
      header: 'Account',
      meta: { headerClassName: 'hidden lg:table-cell', cellClassName: 'hidden truncate lg:table-cell' },
    },
    {
      accessorKey: 'categoryLabel',
      header: 'Category',
      meta: { headerClassName: 'hidden lg:table-cell', cellClassName: 'hidden truncate text-tertiary lg:table-cell' },
    },
    {
      accessorKey: 'valueNumber',
      id: 'value',
      header: 'Value',
      meta: { align: 'right', headerClassName: 'text-right', cellClassName: 'text-right font-mono text-primary' },
      cell: ({ getValue }) => formatCurrency(getValue()),
    },
    {
      accessorKey: 'valueNumber',
      id: 'share',
      header: 'Share',
      meta: { align: 'right', headerClassName: 'text-right', cellClassName: 'text-right font-mono' },
      cell: ({ getValue }) => formatPercent(totalAssets > 0 ? (getValue() / totalAssets) * 100 : 0, 1, { sign: false }),
    },
  ], [totalAssets]);

  const topHoldingsTable = useReactTable({
    data: topHoldings,
    columns: topHoldingsColumns,
    state: { sorting: topHoldingsSorting },
    onSortingChange: setTopHoldingsSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const allocationData = useMemo(() => {
    if (accountSnaps.length === 0 || accountList.length === 0) return [];

    const accountMap = {};
    for (const a of accountList) accountMap[a.id] = getAccountDisplayName(a);

    const dateMap = {};
    for (const snap of accountSnaps) {
      const d = snap.snapshot_date.slice(0, 10);
      if (!dateMap[d]) dateMap[d] = {};
      dateMap[d][snap.account_id] = parseFloat(snap.total_value);
    }

    const accountIds = [...new Set(accountSnaps.map((s) => s.account_id))];
    const dates = Object.keys(dateMap).sort();

    let lastKnown = {};
    return dates.map((date) => {
      const row = { date };
      for (const id of accountIds) {
        if (dateMap[date][id] !== undefined) {
          lastKnown[id] = dateMap[date][id];
        }
        row[accountMap[id] || `Account ${id}`] = lastKnown[id] || 0;
      }
      return row;
    });
  }, [accountSnaps, accountList]);

  const allocationAccounts = useMemo(() => {
    if (allocationData.length === 0) return [];
    const keys = Object.keys(allocationData[0]).filter((k) => k !== 'date');
    return keys;
  }, [allocationData]);

  if (loading) {
    return <LoadingState label="Analyzing Holdings" />;
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 px-4 py-4">
      {/* Hero */}
      <div>
        <h1 className="text-display-md text-primary">Holdings Analysis</h1>
        <p className="mt-1 text-body-sm text-secondary">Visual breakdown of your portfolio composition and changes</p>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard compact label="Total Assets" value={formatCurrency(totalAssets)} icon={TrendingUp} valueColor="accent" caption={`${assetItems.length} asset holdings`} />
        <MetricCard compact label="Top Holding Share" value={formatPercent(concentration.topHoldingShare, 1, { sign: false })} icon={Grid3X3} caption={concentration.topHolding?.name || '--'} />
        <MetricCard
          compact
          label="Largest Holding"
          value={concentration.topHolding ? formatCurrency(concentration.topHolding.valueNumber) : '--'}
          caption={concentration.topHolding?.name || '--'}
          icon={Layers}
        />
        <MetricCard
          compact
          label="Top 5 Share"
          value={formatPercent(concentration.topFiveShare, 1, { sign: false })}
          caption={`${groupedData.length} groups by ${groupBy}`}
          icon={BarChart3}
        />
      </div>

      {/* Controls */}
      <div className="card p-3 space-y-3">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-caption text-tertiary uppercase tracking-wide">Analysis View</p>
            <p className="text-body-sm text-secondary">
              {VIEWS.find((item) => item.id === view)?.label} view{view === 'pie' ? ` grouped by ${groupBy}` : ''}
            </p>
          </div>
          <div className="flex bg-surface-2 rounded border border-border p-1 gap-1">
            {VIEWS.map((v) => {
              const Icon = v.icon;
              return (
                <button
                  key={v.id}
                  onClick={() => setView(v.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wider transition-all ${
                    view === v.id ? 'bg-accent/15 text-accent' : 'text-tertiary hover:text-secondary'
                  }`}
                >
                  <Icon size={14} />
                  {!isMobile && v.label}
                </button>
              );
            })}
          </div>
        </div>

        {view === 'pie' && (
          <div className="flex bg-surface-2 rounded border border-border p-1 gap-1">
            {GROUP_BY_OPTIONS.map((opt) => (
              <button
                key={opt}
                onClick={() => setGroupBy(opt)}
                className={`px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wider transition-all ${
                  groupBy === opt ? 'bg-accent/15 text-accent' : 'text-tertiary hover:text-secondary'
                }`}
              >
                {opt}
              </button>
            ))}
          </div>
        )}

        {view === 'allocation' && (
          <div className="flex bg-surface-2 rounded border border-border p-1 gap-1">
            {DATE_RANGES.map((r) => (
              <button
                key={r.id}
                onClick={() => setDateRange(r.id)}
                className={`px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wider transition-all ${
                  dateRange === r.id ? 'bg-accent/15 text-accent' : 'text-tertiary hover:text-secondary'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        )}

        {view === 'allocation' && (
          <div className="flex bg-surface-2 rounded border border-border p-1 gap-1">
            <button
              onClick={() => setAllocationMode('percent')}
              className={`px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wider transition-all ${
                allocationMode === 'percent' ? 'bg-accent/15 text-accent' : 'text-tertiary hover:text-secondary'
              }`}
            >
              %
            </button>
            <button
              onClick={() => setAllocationMode('absolute')}
              className={`px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wider transition-all ${
                allocationMode === 'absolute' ? 'bg-accent/15 text-accent' : 'text-tertiary hover:text-secondary'
              }`}
            >
              $
            </button>
          </div>
        )}
      </div>

      {/* Chart Area */}
      <div className="card p-4 md:p-6">
        {view === 'pie' && (
          <div className="space-y-4">
            <div className="flex flex-col gap-1 md:flex-row md:items-end md:justify-between">
              <div>
                <h2 className="text-caption font-semibold uppercase tracking-wide text-tertiary">Portfolio by {groupBy}</h2>
                <p className="text-caption text-secondary">
                  Portfolio values grouped by {groupBy}; top five holdings are {formatPercent(concentration.topFiveShare, 1, { sign: false })} of assets.
                </p>
              </div>
              <p className="text-caption text-tertiary">{groupedData.length} groups / {flatGroupedData.length} holdings</p>
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
              <div style={{ height: isMobile ? 300 : 380 }}>
                {groupedData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart accessibilityLayer>
                      <Pie
                        data={groupedData}
                        dataKey="total"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        outerRadius={isMobile ? 112 : 150}
                        stroke="var(--bg-surface)"
                        strokeWidth={2}
                        paddingAngle={1}
                        animationDuration={800}
                        onClick={(entry) => setSelectedGroup(selectedGroup === entry.name ? null : entry.name)}
                      >
                        {groupedData.map((group) => (
                          <Cell
                            key={group.name}
                            fill={group.color}
                            opacity={!selectedGroup || selectedGroup === group.name ? 1 : 0.35}
                          />
                        ))}
                      </Pie>
                      <Tooltip
                        content={({ payload }) => {
                          if (!payload || !payload.length) return null;
                          const item = payload[0]?.payload;
                          if (!item) return null;
                          return (
                            <div className="px-3 py-2 rounded border" style={{ backgroundColor: 'var(--bg-surface-2)', borderColor: 'var(--border)' }}>
                              <div className="text-body-sm font-semibold text-primary">{item.name}</div>
                              <div className="font-money text-body-sm text-accent">{formatCurrency(item.total)}</div>
                              <div className="text-xs text-tertiary">{formatPercent(item.share || 0, 1, { sign: false })} of assets</div>
                            </div>
                          );
                        }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex items-center justify-center h-full text-tertiary text-sm">No holdings data</div>
                )}
              </div>

              <div className="border border-border bg-surface-2 p-3">
                <p className="text-caption text-tertiary uppercase tracking-wide">
                  {selectedGroupTotal ? selectedGroupTotal.name : 'Largest Holdings'}
                </p>
                <p className="font-mono text-lg font-semibold text-primary">
                  {selectedGroupTotal ? formatCurrency(selectedGroupTotal.total) : formatCurrency(concentration.topHolding?.valueNumber || 0)}
                </p>
                <p className="text-caption text-tertiary mb-3">
                  {selectedGroupTotal
                    ? `${formatPercent(selectedGroupTotal.share, 1, { sign: false })} of assets`
                    : `${formatPercent(concentration.topHoldingShare, 1, { sign: false })} in the largest holding`}
                </p>
                <div className="space-y-2">
                  {selectedGroupRows.map((item) => (
                    <div key={`${item.group || item.account}-${item.name}-${item.ticker || ''}`} className="border border-border bg-surface p-2">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-body-sm font-semibold text-primary truncate" title={item.name}>{item.name}</p>
                        <p className="font-mono text-caption text-primary">{formatCompactCurrency(item.size ?? item.valueNumber)}</p>
                      </div>
                      <p className="text-caption text-tertiary truncate">{item.group || item.account || item.categoryLabel}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="border-t border-border pt-4">
              <div className="flex items-center justify-between gap-3 mb-2">
                <h3 className="text-[10px] font-bold tracking-wide uppercase text-tertiary">Top Holdings by Value</h3>
                <span className="text-caption text-tertiary">{topHoldings.length} shown</span>
              </div>
              <DataTable
                table={topHoldingsTable}
                bare
                mobile="table"
                emptyMessage="No holdings to show."
              />
            </div>
          </div>
        )}

        {view === 'allocation' && (
          <div style={{ height: isMobile ? 300 : 450 }}>
            {allocationData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={allocationData} stackOffset={allocationMode === 'percent' ? 'expand' : 'none'} margin={{ top: 10, right: 10, left: isMobile ? 0 : 10, bottom: 5 }}>
                  <defs>
                    {allocationAccounts.map((name, i) => areaGradient(`alloc-${i}`, CHART_COLORS[i % CHART_COLORS.length], 0.4))}
                  </defs>
                  <CartesianGrid {...GRID_STYLE} vertical={false} />
                  <XAxis dataKey="date" {...AXIS_STYLE} tickFormatter={formatDateAxis} />
                  <YAxis
                    {...AXIS_STYLE}
                    tickFormatter={allocationMode === 'percent' ? (v) => formatPercent(v * 100, 0) : formatCompactCurrency}
                    width={isMobile ? 40 : 60}
                  />
                  <Tooltip
                    content={<ChartTooltip
                      formatLabel={formatDateAxis}
                      formatValue={allocationMode === 'percent'
                        ? (v) => formatPercent(v * 100, 1)
                        : (v) => formatCurrency(v)}
                    />}
                    cursor={{ stroke: 'var(--border)', strokeWidth: 1 }}
                  />
                  {allocationAccounts.map((name, i) => (
                    <Area
                      key={name}
                      type="monotone"
                      dataKey={name}
                      stackId="1"
                      stroke={CHART_COLORS[i % CHART_COLORS.length]}
                      fill={`url(#alloc-${i})`}
                      strokeWidth={1.5}
                      animationDuration={1000}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-tertiary text-sm">No historical data</div>
            )}
          </div>
        )}
      </div>

      {/* Legend for pie chart */}
      {view === 'pie' && groupedData.length > 0 && (
        <div className="card p-4 flex flex-wrap gap-3">
          {groupedData.map((group) => (
            <button
              key={group.name}
              onClick={() => setSelectedGroup(selectedGroup === group.name ? null : group.name)}
              className={`flex items-center gap-2 border px-2 py-1 text-sm transition-colors ${selectedGroup === group.name ? 'border-accent/40 bg-accent-muted' : 'border-transparent hover:border-border'}`}
            >
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: group.color }} />
              <span className="text-secondary">{group.name}</span>
              <span className="font-money text-primary text-xs">{formatCompactCurrency(group.total)}</span>
            </button>
          ))}
        </div>
      )}

      {/* Legend for allocation */}
      {view === 'allocation' && allocationAccounts.length > 0 && (
        <div className="card p-4 flex flex-wrap gap-3">
          {allocationAccounts.map((name, i) => (
            <div key={name} className="flex items-center gap-2 text-sm">
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }} />
              <span className="text-secondary">{name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
