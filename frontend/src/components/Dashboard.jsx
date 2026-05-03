import React, { useState, useEffect, useMemo } from 'react';
import { dashboard as dashboardAPI, history as historyAPI } from '../utils/api';
import { formatCurrency, formatPercent, formatCompactCurrency } from '../utils/format';
import DashboardTable from './DashboardTable';
import MetricCard from './MetricCard';
import AllocationDonut from './AllocationDonut';
import SparkLine from './SparkLine';

const Dashboard = () => {
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
    await fetchData();
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
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="w-8 h-8 border-4 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-loss-bg text-loss border border-loss/20 rounded-lg p-4">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1400px] mx-auto space-y-6">
      {/* Hero: Net Worth */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 animate-fade-in">
        <div>
          <p className="text-[10px] font-semibold tracking-widest uppercase text-secondary mb-1">
            Net Worth
          </p>
          <h1 className="font-mono font-bold text-primary leading-none" style={{ fontSize: 'clamp(2rem, 5vw, 3rem)' }}>
            {formatCurrency(netWorth)}
          </h1>
          {dailyChange.amount !== 0 && (
            <p className={`font-mono text-sm mt-1 ${dailyChange.amount >= 0 ? 'text-gain' : 'text-loss'}`}>
              {dailyChange.amount >= 0 ? '+' : ''}{formatCurrency(dailyChange.amount)} ({formatPercent(dailyChange.percent)}) today
            </p>
          )}
          {data?.lastUpdated && (
            <p className="text-xs text-tertiary mt-2">
              Updated {new Date(data.lastUpdated).toLocaleString()}
            </p>
          )}
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="px-4 py-2 bg-surface-3 text-secondary border border-border hover:border-border-hover rounded-md text-sm disabled:opacity-50 min-h-[44px] touch-manipulation self-start sm:self-auto"
        >
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
        <MetricCard
          label="Total Assets"
          value={formatCurrency(totalAssets)}
          valueColor="gain"
        />
        <MetricCard
          label="Total Liabilities"
          value={formatCurrency(totalLiabilities)}
          valueColor="loss"
        />
        <MetricCard
          label="30-Day Change"
          value={formatCurrency(Math.abs(monthlyChange.amount))}
          change={formatPercent(monthlyChange.percent)}
          trend={monthlyChange.amount >= 0 ? 'up' : 'down'}
          valueColor={monthlyChange.amount >= 0 ? 'gain' : 'loss'}
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <AllocationDonut items={data?.items || []} />

        {/* Account Summary Cards */}
        <div className="card p-5 flex flex-col gap-4">
          <span className="text-[10px] font-semibold tracking-widest uppercase text-secondary">
            Accounts
          </span>
          <div className="space-y-3 overflow-y-auto max-h-[300px]">
            {accountSummaries.map((account) => (
              <div
                key={account.name}
                className="flex items-center justify-between gap-3 p-3 bg-surface-2 rounded-lg"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-primary truncate">{account.name}</div>
                  <div className="font-mono text-sm text-secondary">
                    {formatCompactCurrency(account.value)}
                  </div>
                </div>
                <SparkLine data={account.sparkData} width={80} height={30} />
              </div>
            ))}
            {accountSummaries.length === 0 && (
              <p className="text-tertiary text-sm">No account data</p>
            )}
          </div>
        </div>
      </div>

      {/* Holdings Table */}
      {data?.items && <DashboardTable items={data.items} />}
    </div>
  );
};

export default Dashboard;
