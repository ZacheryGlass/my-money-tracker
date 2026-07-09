import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  Treemap,
} from 'recharts';
import { Grid3X3, Layers, BarChart3, TrendingUp } from 'lucide-react';
import MetricCard from '../components/MetricCard';
import WaterfallChart from '../components/WaterfallChart';
import ChartTooltip from '../components/ChartTooltip';
import ResponsiveContainer from '../components/ResponsiveContainer';
import { CHART_COLORS, GRID_STYLE, AXIS_STYLE, areaGradient } from '../utils/chartTheme';
import { formatCurrency, formatCompactCurrency, formatDateAxis, formatPercent } from '../utils/format';
import { dashboard, history, accounts as accountsApi } from '../utils/api';
import { useIsMobile } from '../hooks/useMediaQuery';
import { getAccountDisplayName } from '../utils/accountDisplay';
import { formatCategoryLabel } from '../utils/dataLabels';

const VIEWS = [
  { id: 'treemap', label: 'Treemap', icon: Grid3X3 },
  { id: 'waterfall', label: 'Waterfall', icon: BarChart3 },
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

function TreemapContent({ x, y, width, height, name, value, color }) {
  if (width < 40 || height < 30) return null;
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} rx={4} fill={color} stroke="var(--bg-surface)" strokeWidth={2} />
      {width > 60 && height > 40 && (
        <>
          <text x={x + 8} y={y + 18} fill="var(--text-primary)" fontSize={11} fontWeight={600}>
            {name.length > Math.floor(width / 7) ? name.slice(0, Math.floor(width / 7)) + '...' : name}
          </text>
          <text x={x + 8} y={y + 34} fill="var(--text-secondary)" fontSize={10} fontFamily="var(--font-money)">
            {formatCompactCurrency(value)}
          </text>
        </>
      )}
    </g>
  );
}

export default function HoldingsAnalysis() {
  const isMobile = useIsMobile();
  const [view, setView] = useState('treemap');
  const [groupBy, setGroupBy] = useState('account');
  const [dateRange, setDateRange] = useState('3m');
  const [loading, setLoading] = useState(true);
  const [portfolioItems, setPortfolioItems] = useState([]);
  const [totalAssets, setTotalAssets] = useState(0);
  const [accountSnaps, setAccountSnaps] = useState([]);
  const [accountList, setAccountList] = useState([]);
  const [tickerSnaps, setTickerSnaps] = useState([]);
  const [allocationMode, setAllocationMode] = useState('percent');

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

      if (view === 'waterfall') {
        const tickerData = await history.getTickers({ ...range, limit: 10000 });
        setTickerSnaps(tickerData.data || []);
      }
    } catch (err) {
      console.error('Failed to load holdings analysis data:', err);
    } finally {
      setLoading(false);
    }
  }, [dateRange, view]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const treemapData = useMemo(() => {
    const assets = portfolioItems.filter((i) => i.type === 'asset');
    const groups = {};
    for (const item of assets) {
      const key = groupBy === 'account' ? item.account
        : groupBy === 'category' ? formatCategoryLabel(item.category)
        : item.type;
      if (!groups[key]) groups[key] = { name: key, children: [], total: 0 };
      groups[key].children.push({ name: item.name || item.ticker, size: Math.abs(parseFloat(item.value)) });
      groups[key].total += Math.abs(parseFloat(item.value));
    }

    return Object.values(groups)
      .sort((a, b) => b.total - a.total)
      .map((g, i) => ({
        ...g,
        color: CHART_COLORS[i % CHART_COLORS.length],
        children: g.children.map((c) => ({ ...c, color: CHART_COLORS[i % CHART_COLORS.length] })),
      }));
  }, [portfolioItems, groupBy]);

  const flatTreemapData = useMemo(() => {
    return treemapData.flatMap((g) =>
      g.children.map((c) => ({ name: c.name, size: c.size, color: g.color, group: g.name }))
    );
  }, [treemapData]);

  const waterfallData = useMemo(() => {
    if (tickerSnaps.length === 0 || portfolioItems.length === 0) return [];

    const startValues = {};
    for (const snap of tickerSnaps) {
      const key = snap.ticker || snap.name;
      if (!startValues[key] || snap.snapshot_date < startValues[key].date) {
        startValues[key] = { date: snap.snapshot_date, value: parseFloat(snap.value) };
      }
    }

    const deltas = portfolioItems
      .filter((i) => i.type === 'asset')
      .map((item) => {
        const key = item.ticker || item.name;
        const startVal = startValues[key]?.value || 0;
        const currentVal = parseFloat(item.value);
        return { name: key, delta: currentVal - startVal };
      })
      .filter((d) => Math.abs(d.delta) > 1)
      .sort((a, b) => b.delta - a.delta);

    const top = deltas.slice(0, 8);
    const otherDelta = deltas.slice(8).reduce((sum, d) => sum + d.delta, 0);
    if (deltas.length > 8 && Math.abs(otherDelta) > 1) {
      top.push({ name: 'Other', delta: otherDelta });
    }

    const totalDelta = deltas.reduce((sum, d) => sum + d.delta, 0);
    top.push({ name: 'Net Change', delta: totalDelta, isTotal: true });

    return top;
  }, [tickerSnaps, portfolioItems]);

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
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        <span className="text-xs font-bold tracking-wide uppercase text-tertiary ">Analyzing Holdings</span>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 md:py-8 max-w-[1600px] space-y-8">
      {/* Hero */}
      <div>
        <h1 className="text-3xl md:text-5xl font-bold text-primary tracking-tighter">Holdings Analysis</h1>
        <p className="text-sm text-secondary mt-1">Visual breakdown of your portfolio composition and changes</p>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard label="Total Assets" value={formatCurrency(totalAssets)} icon={TrendingUp} valueColor="accent" />
        <MetricCard label="Holdings" value={portfolioItems.filter((i) => i.type === 'asset').length} icon={Grid3X3} />
        <MetricCard
          label="Largest Holding"
          value={portfolioItems.length > 0 ? portfolioItems[0]?.name : '--'}
          change={portfolioItems.length > 0 ? formatCurrency(portfolioItems[0]?.value) : ''}
          icon={Layers}
        />
        <MetricCard
          label="Groups"
          value={treemapData.length}
          change={`by ${groupBy}`}
          icon={BarChart3}
        />
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-3 items-center">
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

        {view === 'treemap' && (
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

        {view !== 'treemap' && (
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
        {view === 'treemap' && (
          <div style={{ height: isMobile ? 300 : 500 }}>
            {flatTreemapData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <Treemap
                  data={flatTreemapData}
                  dataKey="size"
                  nameKey="name"
                  content={<TreemapContent />}
                  animationDuration={800}
                >
                  <Tooltip
                    content={({ payload }) => {
                      if (!payload || !payload.length) return null;
                      const item = payload[0]?.payload;
                      if (!item) return null;
                      return (
                        <div className="px-3 py-2 rounded border" style={{ backgroundColor: 'var(--bg-surface-2)', borderColor: 'var(--border)' }}>
                          <div className="text-xs text-secondary">{item.group}</div>
                          <div className="text-sm font-semibold text-primary">{item.name}</div>
                          <div className="text-sm font-money text-accent">{formatCurrency(item.size)}</div>
                        </div>
                      );
                    }}
                  />
                </Treemap>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-tertiary text-sm">No holdings data</div>
            )}
          </div>
        )}

        {view === 'waterfall' && (
          <WaterfallChart data={waterfallData} height={isMobile ? 300 : 450} />
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

      {/* Legend for treemap */}
      {view === 'treemap' && treemapData.length > 0 && (
        <div className="card p-4 flex flex-wrap gap-3">
          {treemapData.map((group) => (
            <div key={group.name} className="flex items-center gap-2 text-sm">
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: group.color }} />
              <span className="text-secondary">{group.name}</span>
              <span className="font-money text-primary text-xs">{formatCompactCurrency(group.total)}</span>
            </div>
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
