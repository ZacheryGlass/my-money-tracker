import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock,
  RefreshCw,
  Scale,
  WalletCards,
} from 'lucide-react';
import { analytics, dashboard as dashboardAPI, history as historyAPI, plaid as plaidAPI } from '../utils/api';
import { formatCompactCurrency, formatCurrency, formatDateDisplay, formatPercent } from '../utils/format';
import { buildAccountDisplayNameMap } from '../utils/accountDisplay';
import { getAssetClass, getHoldingIdentity } from '../utils/assetClass';
import AllocationDonut from './AllocationDonut';
import DashboardNetWorthChart from './DashboardNetWorthChart';
import DashboardTable from './DashboardTable';

const RANGE_OPTIONS = [
  { value: '30D', label: '30 days' },
  { value: 'YTD', label: 'Year to date' },
  { value: '1Y', label: '1 year' },
  { value: 'ALL', label: 'All history' },
];

const formatAttentionNames = (items = []) => {
  const names = items.map((item) => item.institutionName).filter(Boolean);
  if (names.length === 0) return 'linked institutions';
  const visible = names.slice(0, 3).join(', ');
  return `${visible}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`;
};

const isoDate = (value) => new Date(value).toISOString().slice(0, 10);

const localIsoDate = (value = new Date()) => {
  const localDate = new Date(value.getTime() - value.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 10);
};

const shiftDays = (value, days) => {
  const date = new Date(`${isoDate(value)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const rangeStartDate = (range, endDate) => {
  const end = new Date(`${endDate}T00:00:00Z`);
  if (range === '30D') return shiftDays(endDate, -29);
  if (range === '1Y') return shiftDays(endDate, -364);
  if (range === 'YTD') return `${end.getUTCFullYear()}-01-01`;
  return null;
};

const numberValue = (value) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const sortSnapshots = (snapshots = []) => (
  [...snapshots].sort((a, b) => String(a.snapshot_date).localeCompare(String(b.snapshot_date)))
);

const Dashboard = ({ onNavigate }) => {
  const [data, setData] = useState(null);
  const [historyData, setHistoryData] = useState([]);
  const [accountHistoryData, setAccountHistoryData] = useState([]);
  const [tickerHistoryData, setTickerHistoryData] = useState([]);
  const [benchmarkData, setBenchmarkData] = useState({ SPY: [], QQQ: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedRange, setSelectedRange] = useState('YTD');
  const [selectedAccountId, setSelectedAccountId] = useState('all');
  const [assetClassFilter, setAssetClassFilter] = useState(null);

  const today = localIsoDate();
  const selectedStartDate = rangeStartDate(selectedRange, today);

  const fetchData = useCallback(async () => {
    const tickerStartDate = shiftDays(today, -38);
    const [portfolio, portfolioHistory, accountHistory, tickerHistory] = await Promise.all([
      dashboardAPI.getPortfolio(),
      historyAPI.getPortfolio({ limit: 10000 }).catch(() => ({ data: [] })),
      historyAPI.getAccounts({ limit: 10000 }).catch(() => ({ data: [] })),
      historyAPI.getTickers({ startDate: tickerStartDate, limit: 10000 }).catch(() => ({ data: [] })),
    ]);
    setData(portfolio);
    setHistoryData(portfolioHistory.data || []);
    setAccountHistoryData(accountHistory.data || []);
    setTickerHistoryData(tickerHistory.data || []);
  }, [today]);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        await fetchData();
        setError(null);
      } catch (err) {
        console.error('Error fetching dashboard:', err);
        setError(err.response?.data?.error || 'Failed to load dashboard');
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, [fetchData]);

  useEffect(() => {
    let cancelled = false;
    const loadBenchmarks = async () => {
      // Fetch a lookback buffer before the range start so the as-of alignment
      // can anchor to the last close on or before the first timeline date
      // (otherwise the first trading day's return is silently dropped).
      const fetchStart = selectedStartDate ? shiftDays(selectedStartDate, -10) : null;
      const [spy, qqq] = await Promise.all([
        analytics.getBenchmarkHistory({ symbol: 'SPY', startDate: fetchStart, endDate: today })
          .catch(() => ({ data: [] })),
        analytics.getBenchmarkHistory({ symbol: 'QQQ', startDate: fetchStart, endDate: today })
          .catch(() => ({ data: [] })),
      ]);
      if (!cancelled) {
        setBenchmarkData({ SPY: spy.data || [], QQQ: qqq.data || [] });
      }
    };
    loadBenchmarks();
    return () => { cancelled = true; };
  }, [selectedStartDate, today]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const { items } = await plaidAPI.getItems();
      const syncTasks = (items || []).map((item) => plaidAPI.syncItem(item.id));
      const results = await Promise.allSettled([
        ...syncTasks,
        dashboardAPI.refreshPrices(),
      ]);
      await fetchData();
      const failures = results.filter((result) => result.status === 'rejected');
      setError(failures.length ? `${failures.length} update${failures.length === 1 ? '' : 's'} failed. Some data may be stale.` : null);
    } catch (err) {
      console.error('Sync failures:', err);
      setError(err.response?.data?.error || 'Some updates failed. Please try again.');
    } finally {
      setRefreshing(false);
    }
  };

  const accountDisplayNames = useMemo(() => buildAccountDisplayNameMap(
    (data?.items || []).map((item) => ({
      id: item.account_id,
      effective_name: item.account,
      account_source_name: item.account_source_name,
      name: item.account_source_name || item.account,
    }))
  ), [data]);

  // The account selector only lets you drill into investment accounts (other
  // account types don't have per-account holdings worth charting here). The
  // "all" view stays whole-portfolio so the Net worth headline is unchanged.
  const investmentAccountIds = useMemo(() => {
    const ids = new Set();
    (data?.items || []).forEach((item) => {
      if (item.account_type === 'investment') ids.add(String(item.account_id));
    });
    return ids;
  }, [data]);

  const accountOptions = useMemo(() => {
    const options = new Map();
    (data?.items || []).forEach((item) => {
      if (item.account_type !== 'investment') return;
      options.set(item.account_id, accountDisplayNames.get(item.account_id) || item.account || 'Other');
    });
    return [...options.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [accountDisplayNames, data]);

  // Reset to "all" when the selected account is no longer an investment option.
  useEffect(() => {
    if (selectedAccountId !== 'all' && !investmentAccountIds.has(String(selectedAccountId))) {
      setSelectedAccountId('all');
    }
  }, [investmentAccountIds, selectedAccountId]);

  const selectedItems = useMemo(() => (
    (data?.items || []).filter((item) => (
      selectedAccountId === 'all' || String(item.account_id) === String(selectedAccountId)
    ))
  ), [data, selectedAccountId]);

  const totals = useMemo(() => {
    const totalAssets = selectedItems
      .filter((item) => item.type !== 'liability')
      .reduce((sum, item) => sum + numberValue(item.value), 0);
    const totalLiabilities = selectedItems
      .filter((item) => item.type === 'liability')
      .reduce((sum, item) => sum + Math.abs(numberValue(item.value)), 0);
    return { totalAssets, totalLiabilities, netWorth: totalAssets - totalLiabilities };
  }, [selectedItems]);

  const baseHistorySeries = useMemo(() => {
    if (selectedAccountId === 'all') {
      return sortSnapshots(historyData).map((snapshot) => ({
        date: isoDate(snapshot.snapshot_date),
        value: numberValue(snapshot.total_value),
      }));
    }
    return sortSnapshots(accountHistoryData)
      .filter((snapshot) => String(snapshot.account_id) === String(selectedAccountId))
      .map((snapshot) => ({ date: isoDate(snapshot.snapshot_date), value: numberValue(snapshot.total_value) }));
  }, [accountHistoryData, historyData, selectedAccountId]);

  const timelineData = useMemo(() => {
    const filtered = baseHistorySeries.filter((point) => !selectedStartDate || point.date >= selectedStartDate);
    const series = filtered.map((point) => ({ ...point }));
    const latest = series.at(-1);
    if (!latest || latest.date < today) {
      series.push({ date: today, value: totals.netWorth });
    } else {
      // latest.date >= today (UTC-dated snapshots can run ahead of local time);
      // update in place so the series stays in ascending date order.
      latest.value = totals.netWorth;
    }
    return series;
  }, [baseHistorySeries, selectedStartDate, today, totals.netWorth]);

  const periodChange = useMemo(() => {
    const first = timelineData[0]?.value;
    if (!Number.isFinite(first) || timelineData.length < 2) return { amount: 0, percent: 0, available: false };
    const amount = totals.netWorth - first;
    return {
      amount,
      percent: first !== 0 ? (amount / Math.abs(first)) * 100 : 0,
      available: true,
    };
  }, [timelineData, totals.netWorth]);

  const thirtyDayReturns = useMemo(() => {
    const targetDate = shiftDays(today, -30);
    const grouped = new Map();
    tickerHistoryData.forEach((snapshot) => {
      const identity = getHoldingIdentity(snapshot);
      const group = grouped.get(identity) || [];
      group.push({ date: isoDate(snapshot.snapshot_date), value: numberValue(snapshot.value) });
      grouped.set(identity, group);
    });

    const returns = new Map();
    selectedItems.forEach((item) => {
      const identity = getHoldingIdentity(item);
      const series = (grouped.get(identity) || []).sort((a, b) => a.date.localeCompare(b.date));
      if (!series.length) return;
      const nearest = series.reduce((best, point) => {
        const distance = Math.abs(new Date(`${point.date}T00:00:00Z`) - new Date(`${targetDate}T00:00:00Z`));
        return !best || distance < best.distance ? { point, distance } : best;
      }, null);
      if (!nearest || nearest.distance > 8 * 86400000 || nearest.point.value === 0) return;
      returns.set(identity, ((numberValue(item.value) - nearest.point.value) / Math.abs(nearest.point.value)) * 100);
    });
    return returns;
  }, [selectedItems, tickerHistoryData, today]);

  const enrichedItems = useMemo(() => selectedItems.map((item) => {
    const identity = getHoldingIdentity(item);
    return {
      ...item,
      identity,
      displayAccount: accountDisplayNames.get(item.account_id) || item.account || 'Other',
      assetClass: getAssetClass(item),
      thirtyDayReturnPercent: thirtyDayReturns.get(identity),
    };
  }), [accountDisplayNames, selectedItems, thirtyDayReturns]);

  const assets = useMemo(() => enrichedItems
    .filter((item) => item.type !== 'liability')
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value)), [enrichedItems]);
  const liabilities = useMemo(() => enrichedItems
    .filter((item) => item.type === 'liability')
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value)), [enrichedItems]);
  const topFiveValue = assets.slice(0, 5).reduce((sum, item) => sum + numberValue(item.value), 0);
  const concentration = totals.totalAssets > 0 ? (topFiveValue / totals.totalAssets) * 100 : 0;

  const accountDrivers = useMemo(() => {
    const starts = new Map();
    sortSnapshots(accountHistoryData)
      .filter((snapshot) => !selectedStartDate || isoDate(snapshot.snapshot_date) >= selectedStartDate)
      .forEach((snapshot) => {
        if (!starts.has(snapshot.account_id)) starts.set(snapshot.account_id, numberValue(snapshot.total_value));
      });

    const current = new Map();
    selectedItems.forEach((item) => current.set(item.account_id, (current.get(item.account_id) || 0) + numberValue(item.value)));
    return [...current.entries()]
      .filter(([accountId]) => starts.has(accountId))
      .map(([accountId, value]) => ({
        accountId,
        name: accountDisplayNames.get(accountId) || 'Account',
        change: value - starts.get(accountId),
      }))
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
      .slice(0, 3);
  }, [accountDisplayNames, accountHistoryData, selectedItems, selectedStartDate]);

  // Rebase each benchmark to the portfolio's net worth at the first date the
  // benchmark has coverage, aligned to the timeline dates via an as-of lookup,
  // so both lines share the same x-axis and start from the same value.
  const benchmarkTimeline = useMemo(() => {
    if (!timelineData.length) {
      return { spy: [], qqq: [] };
    }
    const dates = timelineData.map((point) => point.date);

    const rebaseAndAlign = (points) => {
      const sorted = (points || [])
        .map((point) => ({ date: isoDate(point.date), close: numberValue(point.close) }))
        .filter((point) => point.close > 0)
        .sort((a, b) => a.date.localeCompare(b.date));
      if (!sorted.length) return [];

      // As-of close for each timeline date: the last close on or before it.
      let index = 0;
      let lastClose = null;
      const asof = dates.map((date) => {
        while (index < sorted.length && sorted[index].date <= date) {
          lastClose = sorted[index].close;
          index += 1;
        }
        return lastClose;
      });

      // Anchor at the first timeline date the benchmark covers (benchmark
      // history may start later than the portfolio's, e.g. the ALL range with
      // a capped backfill). A non-positive base would invert the overlay.
      const firstIndex = asof.findIndex((close) => close != null);
      if (firstIndex === -1) return [];
      const firstClose = asof[firstIndex];
      const base = timelineData[firstIndex].value;
      if (!(firstClose > 0) || !(base > 0)) return [];
      return asof.map((close) => (close != null ? base * (close / firstClose) : null));
    };

    return {
      spy: rebaseAndAlign(benchmarkData.SPY),
      qqq: rebaseAndAlign(benchmarkData.QQQ),
    };
  }, [benchmarkData, timelineData]);

  const hasSpy = benchmarkTimeline.spy.some((value) => value != null);
  const hasQqq = benchmarkTimeline.qqq.some((value) => value != null);

  const netWorthChartData = useMemo(() => timelineData.map((point, i) => ({
    date: point.date,
    value: point.value,
    spy: benchmarkTimeline.spy[i] ?? null,
    qqq: benchmarkTimeline.qqq[i] ?? null,
  })), [benchmarkTimeline, timelineData]);

  const freshnessIssues = useMemo(() => {
    const freshness = data?.freshness;
    const issues = [];
    if (freshness?.snapshot?.isStale) {
      issues.push({
        title: 'Portfolio history is stale',
        detail: freshness.snapshot.latestDate ? `Latest snapshot: ${formatDateDisplay(freshness.snapshot.latestDate)}` : 'No snapshots recorded',
        page: 'portfolio-timeline',
      });
    }
    if (freshness?.plaid?.errorCount > 0 || freshness?.plaid?.staleCount > 0) {
      issues.push({
        title: 'Linked accounts need attention',
        detail: formatAttentionNames(freshness.plaid.attentionItems),
        page: 'settings',
      });
    }
    if (freshness?.prices?.isStale) {
      issues.push({
        title: 'Market prices are stale',
        detail: `About ${Math.round(freshness.prices.ageHours)} hours old`,
        refresh: true,
      });
    }
    return issues;
  }, [data]);

  const syncLabel = data?.lastUpdated
    ? new Date(data.lastUpdated).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'No recent sync';
  const rangeLabel = RANGE_OPTIONS.find((option) => option.value === selectedRange)?.label || selectedRange;

  if (loading) {
    return (
      <div className="flex min-h-[400px] flex-col items-center justify-center gap-3">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        <span className="text-caption text-tertiary">Building overview</span>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-3 px-3 py-3 sm:px-4 sm:py-4">
      <header className="flex flex-col gap-3 border-b border-border pb-3 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-title-md text-primary">Financial overview</h1>
            <span className={`inline-flex items-center gap-1 text-caption ${freshnessIssues.length ? 'text-loss' : 'text-gain'}`}>
              {freshnessIssues.length ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}
              {freshnessIssues.length ? `${freshnessIssues.length} data issue${freshnessIssues.length === 1 ? '' : 's'}` : 'All data current'}
            </span>
          </div>
          <p className="mt-0.5 flex items-center gap-1 text-caption text-tertiary">
            <Clock size={12} /> Synced {syncLabel}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
          <label className="sr-only" htmlFor="dashboard-account-filter">Account</label>
          <select
            id="dashboard-account-filter"
            value={selectedAccountId}
            onChange={(event) => {
              setSelectedAccountId(event.target.value);
              setAssetClassFilter(null);
            }}
            className="h-11 min-w-0 border border-border bg-surface px-2 text-body-sm text-primary sm:min-w-[180px] md:h-9"
          >
            <option value="all">All accounts</option>
            {accountOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>

          <label className="sr-only" htmlFor="dashboard-range-filter">Date range</label>
          <select
            id="dashboard-range-filter"
            value={selectedRange}
            onChange={(event) => setSelectedRange(event.target.value)}
            className="h-11 min-w-0 border border-border bg-surface px-2 text-body-sm text-primary sm:min-w-[140px] md:h-9"
          >
            {RANGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>

          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="inline-flex h-11 items-center justify-center gap-2 bg-accent px-3 text-button font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50 md:h-9"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? 'Syncing' : 'Refresh'}
          </button>
        </div>
      </header>

      {error && <div className="border border-loss/30 bg-loss-bg px-3 py-2 text-body-sm text-loss">{error}</div>}

      {freshnessIssues.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {freshnessIssues.map((issue) => (
            <button
              key={issue.title}
              type="button"
              onClick={() => issue.refresh ? handleRefresh() : onNavigate(issue.page)}
              className="flex w-full min-w-0 items-center justify-between gap-3 border border-loss/30 bg-loss-bg px-3 py-2 text-left hover:bg-surface-2 md:w-auto md:min-w-[360px]"
            >
              <span className="min-w-0">
                <span className="block truncate text-body-sm font-semibold text-loss">{issue.title}</span>
                <span className="block truncate text-caption text-secondary">{issue.detail}</span>
              </span>
              <ChevronRight size={14} className="shrink-0 text-loss" />
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-12">
        <section className="card flex min-h-0 flex-col xl:col-span-8" aria-labelledby="dashboard-net-worth-title">
          <div className="grid gap-3 p-3 md:grid-cols-[minmax(0,1fr)_auto] md:p-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h2 id="dashboard-net-worth-title" className="text-caption font-semibold uppercase text-tertiary">Net worth</h2>
                <span className="text-caption text-tertiary">{rangeLabel}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <div className="font-money text-display-mega font-semibold text-primary">{formatCompactCurrency(totals.netWorth)}</div>
                {periodChange.available && (
                  <div className={`font-money text-title-sm font-semibold ${periodChange.amount >= 0 ? 'text-gain' : 'text-loss'}`}>
                    {periodChange.amount >= 0 ? '+' : '-'}{formatCompactCurrency(Math.abs(periodChange.amount))} · {formatPercent(periodChange.percent)}
                  </div>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-body-sm">
                <button type="button" onClick={() => onNavigate('assets')} className="text-left text-secondary hover:text-primary">
                  Assets <span className="font-money font-semibold text-gain">{formatCompactCurrency(totals.totalAssets)}</span>
                </button>
                <button type="button" onClick={() => onNavigate('liabilities')} className="text-left text-secondary hover:text-primary">
                  Debt <span className="font-money font-semibold text-loss">{formatCompactCurrency(totals.totalLiabilities)}</span>
                </button>
              </div>
            </div>

            <div className="min-w-0 md:max-w-[320px]">
              <div className="text-caption font-semibold uppercase text-tertiary">Largest drivers</div>
              <div className="mt-1 space-y-1">
                {accountDrivers.length ? accountDrivers.map((driver) => (
                  <button
                    key={driver.accountId}
                    type="button"
                    onClick={() => onNavigate('accounts')}
                    className="flex w-full items-center justify-between gap-4 text-body-sm hover:text-primary"
                  >
                    <span className="truncate text-secondary">{driver.name}</span>
                    <span className={`shrink-0 font-money font-semibold ${driver.change >= 0 ? 'text-gain' : 'text-loss'}`}>
                      {driver.change >= 0 ? '+' : '-'}{formatCompactCurrency(Math.abs(driver.change))}
                    </span>
                  </button>
                )) : <span className="text-caption text-tertiary">Not enough account history yet.</span>}
              </div>
            </div>
          </div>
          <button type="button" onClick={() => onNavigate('portfolio-timeline')} className="mt-auto block w-full text-left">
            <DashboardNetWorthChart data={netWorthChartData} showSpy={hasSpy} showQqq={hasQqq} />
          </button>
        </section>

        <section className="card flex flex-col xl:col-span-4" aria-labelledby="dashboard-allocation-title">
          <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5">
            <div>
              <h2 id="dashboard-allocation-title" className="text-caption font-semibold uppercase text-tertiary">Asset mix</h2>
              <p className="text-caption text-tertiary">Select a class to filter holdings</p>
            </div>
            <button type="button" onClick={() => onNavigate('holdings-analysis')} className="text-caption font-semibold text-accent hover:underline">
              Analyze <ChevronRight size={12} className="inline" />
            </button>
          </div>
          <AllocationDonut
            items={selectedItems}
            compact
            groupBy="assetClass"
            mobileBar
            selectedName={assetClassFilter}
            onSelect={(name) => setAssetClassFilter((current) => current === name ? null : name)}
            className="flex-1"
          />
        </section>

      </div>

      <section className="space-y-2" aria-labelledby="dashboard-holdings-title">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="dashboard-holdings-title" className="text-title-sm text-primary">Holdings</h2>
            <p className="text-caption text-tertiary">
              {assets.length} positions · top five are {formatPercent(concentration, 1, { sign: false })} of assets · sorted by value
            </p>
          </div>
          <span className="text-caption text-tertiary">30D is position value change</span>
        </div>
        <div className="card overflow-hidden">
          <DashboardTable
            items={enrichedItems}
            onNavigate={onNavigate}
            assetClassFilter={assetClassFilter}
            onClearAssetClassFilter={() => setAssetClassFilter(null)}
          />
        </div>
      </section>

      <section className="space-y-2" aria-labelledby="dashboard-liabilities-title">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="dashboard-liabilities-title" className="text-title-sm text-primary">Liabilities</h2>
            <p className="text-caption text-tertiary">{liabilities.length} accounts · {formatCurrency(totals.totalLiabilities)} total debt</p>
          </div>
          <button type="button" onClick={() => onNavigate('liabilities')} className="inline-flex items-center gap-1 text-caption font-semibold text-accent hover:underline">
            Manage debt <ChevronRight size={12} />
          </button>
        </div>
        <div className="card overflow-hidden">
          {liabilities.length ? (
            <div className="divide-y divide-border">
              {liabilities.map((item) => (
                <button
                  key={item.identity}
                  type="button"
                  onClick={() => onNavigate('liabilities')}
                  className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <Scale size={15} className="shrink-0 text-loss" />
                    <span className="min-w-0">
                      <span className="block truncate text-body-sm font-semibold text-primary">{item.name}</span>
                      <span className="block truncate text-caption text-tertiary">{item.displayAccount}</span>
                    </span>
                  </span>
                  <span className="font-money text-title-sm font-semibold text-loss">{formatCurrency(Math.abs(item.value))}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 px-3 py-8 text-body-sm text-tertiary">
              <WalletCards size={16} /> No liabilities in this view.
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

export default Dashboard;
