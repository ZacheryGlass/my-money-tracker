import React, { useState, useEffect, useMemo } from 'react';
import { RefreshCw, Wallet, ArrowDownCircle, ArrowUpCircle, Activity, ChevronRight, TrendingUp, Clock, Landmark, AlertTriangle } from 'lucide-react';
import { dashboard as dashboardAPI, history as historyAPI, plaid as plaidAPI } from '../utils/api';
import { formatCurrency, formatPercent, formatCompactCurrency, formatDateDisplay } from '../utils/format';
import DashboardTable from './DashboardTable';
import MetricCard from './MetricCard';
import AllocationDonut from './AllocationDonut';
import SparkLine from './SparkLine';
import { buildAccountDisplayNameMap } from '../utils/accountDisplay';

const formatAttentionNames = (items = []) => {
  const names = items
    .map((item) => item.institutionName)
    .filter(Boolean);
  if (names.length === 0) return 'linked institutions';
  const visible = names.slice(0, 3).join(', ');
  const extra = names.length > 3 ? ` and ${names.length - 3} more` : '';
  return `${visible}${extra}`;
};

const Dashboard = ({ onNavigate }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [historyData, setHistoryData] = useState([]);
  const [accountHistoryData, setAccountHistoryData] = useState([]);

  const fetchData = async () => {
    try {
      const [result, portfolioHistory, accountHistory] = await Promise.all([
        dashboardAPI.getPortfolio(),
        historyAPI.getPortfolio({ limit: 30 }).catch(() => ({ data: [] })),
        historyAPI.getAccounts({ limit: 100 }).catch(() => ({ data: [] })),
      ]);
      setData(result);
      setHistoryData(portfolioHistory.data || []);
      setAccountHistoryData(accountHistory.data || []);
      setError(null);
    } catch (err) {
      console.error('Error fetching dashboard:', err);
      setError(err.response?.data?.error || 'Failed to load dashboard');
    }
  };

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      await fetchData();
      setLoading(false);
    };
    loadData();
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const { items } = await plaidAPI.getItems();
      const syncTasks = (items || []).map((item) =>
        plaidAPI.syncItem(item.id).then((result) => ({
          type: 'plaid',
          name: item.institution_name || 'Linked account',
          result,
        }))
      );
      const refreshResults = await Promise.allSettled([
        ...syncTasks,
        dashboardAPI.refreshPrices().then((result) => ({ type: 'prices', name: 'Price update', result })),
      ]);
      const failures = refreshResults.filter((result) => result.status === 'rejected');
      await fetchData();
      if (failures.length > 0) {
        setError(`${failures.length} update${failures.length === 1 ? '' : 's'} failed. Some account data may still be stale.`);
      }
    } catch (err) {
      console.error('Sync failures:', err);
      setError(err.response?.data?.error || 'Some updates failed. Please try again.');
    } finally {
      setRefreshing(false);
    }
  };

  const { totalAssets, totalLiabilities, netWorth } = useMemo(() => {
    if (!data?.items) return { totalAssets: 0, totalLiabilities: 0, netWorth: 0 };
    let assets = 0;
    let liabilities = 0;
    data.items.forEach((item) => {
      if (item.type === 'liability') {
        liabilities += Math.abs(item.value);
      } else {
        assets += item.value;
      }
    });
    return { totalAssets: assets, totalLiabilities: liabilities, netWorth: assets - liabilities };
  }, [data]);

  const dailyChange = useMemo(() => {
    if (historyData.length < 2) return { amount: 0, percent: 0 };
    const current = parseFloat(historyData[historyData.length - 1]?.total_value) || 0;
    const previous = parseFloat(historyData[historyData.length - 2]?.total_value) || 0;
    const amount = current - previous;
    const percent = previous !== 0 ? (amount / previous) * 100 : 0;
    return { amount, percent };
  }, [historyData]);

  const monthlyChange = useMemo(() => {
    if (historyData.length < 2) return { amount: 0, percent: 0 };
    const current = parseFloat(historyData[historyData.length - 1]?.total_value) || 0;
    const first = parseFloat(historyData[0]?.total_value) || 0;
    const amount = current - first;
    const percent = first !== 0 ? (amount / first) * 100 : 0;
    return { amount, percent };
  }, [historyData]);

  const accountDisplayNames = useMemo(() => {
    const accounts = (data?.items || []).map((item) => ({
      id: item.account_id,
      effective_name: item.account,
      account_source_name: item.account_source_name,
      name: item.account_source_name || item.account,
    }));
    return buildAccountDisplayNameMap(accounts);
  }, [data]);

  const freshnessIssues = useMemo(() => {
    const freshness = data?.freshness;
    if (!freshness || freshness.status === 'ok') return [];

    const issues = [];
    if (freshness.snapshot?.isStale) {
      const dateText = freshness.snapshot.latestDate
        ? `latest snapshot is ${formatDateDisplay(freshness.snapshot.latestDate)}`
        : 'no portfolio snapshot has been recorded';
      issues.push({
        title: 'Portfolio history',
        detail: `History may be stale because ${dateText}.`,
        action: 'Open timeline',
        page: 'portfolio-timeline',
      });
    }

    if (freshness.plaid?.errorCount > 0) {
      const erroredItems = freshness.plaid.attentionItems?.filter((item) => item.hasError) || [];
      issues.push({
        title: 'Institution errors',
        detail: `${freshness.plaid.errorCount} linked institution${freshness.plaid.errorCount === 1 ? '' : 's'} need attention: ${formatAttentionNames(erroredItems)}.`,
        action: 'Review settings',
        page: 'settings',
      });
    } else if (freshness.plaid?.staleCount > 0) {
      const staleItems = freshness.plaid.attentionItems?.filter((item) => item.isStale) || [];
      issues.push({
        title: 'Institution sync',
        detail: `${freshness.plaid.staleCount} linked institution${freshness.plaid.staleCount === 1 ? '' : 's'} have not synced recently: ${formatAttentionNames(staleItems)}.`,
        action: 'Review settings',
        page: 'settings',
      });
    }

    if (freshness.prices?.isStale) {
      issues.push({
        title: 'Market prices',
        detail: `Market prices are about ${Math.round(freshness.prices.ageHours)} hours old.`,
        action: 'Refresh now',
        refresh: true,
      });
    }

    return issues;
  }, [data]);

  const accountSummaries = useMemo(() => {
    if (!data?.items) return [];
    const grouped = {};
    data.items.forEach((item) => {
      if (item.type === 'liability') return;
      const key = item.account_id ?? item.account ?? 'Other';
      if (!grouped[key]) {
        grouped[key] = {
          name: accountDisplayNames.get(item.account_id) || item.account || 'Other',
          value: 0,
          accountId: item.account_id,
        };
      }
      grouped[key].value += item.value || 0;
    });
    const summaries = Object.values(grouped).sort((a, b) => b.value - a.value);

    summaries.forEach((s) => {
      const history = accountHistoryData
        .filter((d) => d.account_id === s.accountId)
        .sort((a, b) => (a.snapshot_date < b.snapshot_date ? -1 : 1))
        .map((d) => ({ value: parseFloat(d.total_value) }));
      s.sparkData = history;
      if (history.length >= 2) {
        const first = history[0]?.value || 0;
        const last = history[history.length - 1]?.value || 0;
        const change = last - first;
        s.hasTrend = true;
        s.trendAmount = change;
        s.trendLabel = `${change >= 0 ? '+' : '-'}${formatCompactCurrency(Math.abs(change))}`;
      } else {
        s.hasTrend = false;
        s.trendAmount = 0;
        s.trendLabel = 'No trend';
      }
    });

    return summaries;
  }, [data, accountHistoryData, accountDisplayNames]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-3">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        <span className="text-caption text-tertiary">Aggregating Portfolio</span>
      </div>
    );
  }

  return (
    <div className="px-4 py-4 max-w-[1600px] space-y-4">
      {/* Header */}
      <section className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-caption text-tertiary uppercase tracking-wide">Net Worth</span>
            {data?.lastUpdated && (
              <span className="text-caption text-tertiary flex items-center gap-1">
                <Clock size={11} />
                {new Date(data.lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>

          <div>
            <h1 className="text-display-mega font-money text-primary">
              {formatCurrency(netWorth)}
            </h1>
            {dailyChange.amount !== 0 && (
              <div className={`flex items-center gap-1 text-body-sm ${dailyChange.amount >= 0 ? 'text-gain' : 'text-loss'}`}>
                {dailyChange.amount >= 0 ? <TrendingUp size={14} /> : <TrendingUp size={14} className="rotate-180" />}
                {formatCurrency(Math.abs(dailyChange.amount))} ({formatPercent(dailyChange.percent)})
                <span className="text-tertiary ml-1">today</span>
              </div>
            )}
          </div>
        </div>

        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="inline-flex w-fit items-center gap-2 rounded bg-accent px-3 py-1.5 text-button font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Syncing...' : 'Refresh'}
        </button>
      </section>

      {error && (
        <div className="px-3 py-2 bg-loss-bg border border-loss/20 text-loss text-body-sm">
          {error}
        </div>
      )}

      {freshnessIssues.length > 0 && (
        <div className="border border-amber-500/25 bg-amber-500/10 px-3 py-3 text-body-sm text-amber-300">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="flex gap-3">
              <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
              <div>
                <h2 className="text-caption font-semibold uppercase tracking-wide text-amber-200">
                  Data health needs attention
                </h2>
                <p className="mt-1 text-tertiary">
                  {freshnessIssues.length} issue{freshnessIssues.length === 1 ? '' : 's'} may affect the numbers below.
                </p>
              </div>
            </div>
            <button
              onClick={() => onNavigate('settings')}
              className="inline-flex w-fit items-center gap-1 border border-amber-500/25 bg-surface px-3 py-1.5 text-caption font-semibold uppercase tracking-wide text-amber-200 transition-colors hover:border-amber-500/50 hover:text-amber-100"
            >
              Review settings <ChevronRight size={12} />
            </button>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-3">
            {freshnessIssues.map((issue) => (
              <div key={issue.title} className="border border-amber-500/20 bg-base/40 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-caption font-semibold uppercase tracking-wide text-amber-200">{issue.title}</h3>
                    <p className="mt-1 text-body-sm leading-snug text-secondary">{issue.detail}</p>
                  </div>
                  <button
                    onClick={() => (issue.refresh ? handleRefresh() : onNavigate(issue.page))}
                    className="shrink-0 text-caption font-semibold uppercase tracking-wide text-accent hover:underline"
                  >
                    {issue.action}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Primary Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-border">
        <MetricCard
          label="Total Assets"
          value={formatCurrency(totalAssets)}
          valueColor="gain"
          icon={ArrowUpCircle}
          onClick={() => onNavigate('assets')}
        />
        <MetricCard
          label="Total Liabilities"
          value={formatCurrency(totalLiabilities)}
          valueColor="loss"
          icon={ArrowDownCircle}
          onClick={() => onNavigate('liabilities')}
        />
        <MetricCard
          label="Performance"
          value={formatCurrency(Math.abs(monthlyChange.amount))}
          change={formatPercent(monthlyChange.percent)}
          trend={monthlyChange.amount >= 0 ? 'up' : 'down'}
          valueColor={monthlyChange.amount >= 0 ? 'gain' : 'loss'}
          icon={Activity}
          onClick={() => onNavigate('portfolio-timeline')}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
        {/* Left: Allocation */}
        <div className="xl:col-span-3 space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-title-sm text-tertiary uppercase tracking-wide">Asset Allocation</h2>
              <p className="text-caption text-tertiary">Positive asset value by account</p>
            </div>
            <button onClick={() => onNavigate('assets')} className="text-caption text-accent flex items-center gap-1 hover:underline">
              Full Breakdown <ChevronRight size={12} />
            </button>
          </div>
          <div className="card">
            <AllocationDonut items={data?.items || []} className="min-h-[350px]" />
          </div>
        </div>

        {/* Right: Account Feed */}
        <div className="xl:col-span-2 space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-title-sm text-tertiary uppercase tracking-wide">Account Feed</h2>
            <button onClick={() => onNavigate('accounts')} className="text-caption text-accent flex items-center gap-1 hover:underline">
              All Accounts <ChevronRight size={12} />
            </button>
          </div>

          <div className="card flex flex-col max-h-[420px] overflow-y-auto">
            {accountSummaries.map((account) => (
              <div
                key={account.accountId ?? account.name}
                className="flex items-center justify-between gap-3 px-3 py-2 border-b border-border last:border-b-0 hover:bg-surface-2 transition-colors cursor-pointer"
                onClick={() => onNavigate('accounts')}
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <Landmark size={14} className="text-tertiary flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-body-sm font-semibold text-primary truncate">
                      {account.name}
                    </div>
                    <div className="text-caption font-mono text-tertiary">
                      {formatCompactCurrency(account.value)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="min-w-[58px] text-right">
                    <div className={`font-money text-caption font-semibold ${
                      account.hasTrend ? (account.trendAmount >= 0 ? 'text-gain' : 'text-loss') : 'text-tertiary'
                    }`}
                    >
                      {account.trendLabel}
                    </div>
                    <div className="text-[9px] font-semibold uppercase tracking-wide text-tertiary">30 day</div>
                  </div>
                  <SparkLine data={account.sparkData} width={72} height={28} />
                </div>
              </div>
            ))}

            {accountSummaries.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Wallet size={24} className="text-tertiary mb-2" />
                <p className="text-caption text-tertiary">No Active Accounts</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Global Asset Table */}
      <div className="space-y-2">
        <h2 className="text-title-sm text-tertiary uppercase tracking-wide">Portfolio Details</h2>
        <div className="card overflow-hidden">
          <DashboardTable items={data?.items || []} onNavigate={onNavigate} />
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
