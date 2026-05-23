import React, { useState, useEffect, useMemo } from 'react';
import { RefreshCw, Wallet, ArrowDownCircle, ArrowUpCircle, Activity, ChevronRight, TrendingUp, Clock, Landmark } from 'lucide-react';
import { dashboard as dashboardAPI, history as historyAPI, plaid as plaidAPI } from '../utils/api';
import { formatCurrency, formatPercent, formatCompactCurrency } from '../utils/format';
import DashboardTable from './DashboardTable';
import MetricCard from './MetricCard';
import AllocationDonut from './AllocationDonut';
import SparkLine from './SparkLine';

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
      const plaidSync = (items || []).map((item) => plaidAPI.syncItem(item.id));
      await Promise.allSettled([...plaidSync, dashboardAPI.refreshPrices()]);
      await fetchData();
    } catch (err) {
      console.error('Sync failures:', err);
      setError('Some updates failed. Please try again.');
    }
    setRefreshing(false);
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

  const accountSummaries = useMemo(() => {
    if (!data?.items) return [];
    const grouped = {};
    data.items.forEach((item) => {
      if (item.type === 'liability') return;
      const key = item.account || 'Other';
      if (!grouped[key]) grouped[key] = { name: key, value: 0, accountId: item.account_id };
      grouped[key].value += item.value || 0;
    });
    const summaries = Object.values(grouped).sort((a, b) => b.value - a.value);

    summaries.forEach((s) => {
      const history = accountHistoryData
        .filter((d) => d.account_id === s.accountId)
        .sort((a, b) => (a.snapshot_date < b.snapshot_date ? -1 : 1))
        .map((d) => ({ value: parseFloat(d.total_value) }));
      s.sparkData = history;
    });

    return summaries;
  }, [data, accountHistoryData]);

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
      <section className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
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
          className="flex items-center gap-2 px-3 py-1.5 bg-accent text-white rounded text-button font-semibold hover:bg-accent-hover disabled:opacity-50 transition-colors"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Syncing...' : 'Refresh'}
        </button>
      </section>

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
            <h2 className="text-title-sm text-tertiary uppercase tracking-wide">Asset Allocation</h2>
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
                key={account.name}
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
                <SparkLine data={account.sparkData} width={80} height={28} />
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
