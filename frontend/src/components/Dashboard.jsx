import React, { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { RefreshCw, Wallet, ArrowDownCircle, ArrowUpCircle, Activity } from 'lucide-react';
import { dashboard as dashboardAPI, history as historyAPI, plaid as plaidAPI } from '../utils/api';
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
    const plaidSync = plaidAPI.getItems()
      .then(({ items }) => Promise.all((items || []).map((item) => plaidAPI.syncItem(item.id))));
    const results = await Promise.allSettled([dashboardAPI.refreshPrices(), plaidSync]);
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      console.error('Sync failures:', failed.map((r) => r.reason));
      setError('Some updates failed. Please try again.');
    }
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
        <div className="w-10 h-10 border-4 border-accent border-t-transparent rounded-full animate-spin shadow-glow" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-loss-bg text-loss border border-loss/20 rounded-2xl p-6 backdrop-blur-md">
          <div className="flex items-center gap-3 mb-2">
            <Activity className="text-loss" size={24} />
            <h2 className="text-lg font-bold">Something went wrong</h2>
          </div>
          <p className="text-sm opacity-80">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 lg:p-12 max-w-[1600px] mx-auto space-y-10">
      {/* Hero Section */}
      <section className="flex flex-col lg:flex-row lg:items-center justify-between gap-8 pt-4">
        <motion.div 
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          className="space-y-4"
        >
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-accent/10 border border-accent/20 text-accent text-[10px] font-bold uppercase tracking-wider">
            <Wallet size={12} />
            Portfolio Overview
          </div>
          <h1 className="font-money text-hero text-primary tracking-tighter">
            {formatCurrency(netWorth)}
          </h1>
          <div className="flex items-center gap-4">
            {dailyChange.amount !== 0 && (
              <div className={`flex items-center gap-1.5 font-money text-sm font-semibold ${dailyChange.amount >= 0 ? 'text-gain' : 'text-loss'}`}>
                {dailyChange.amount >= 0 ? '+' : ''}{formatCurrency(dailyChange.amount)} ({formatPercent(dailyChange.percent)})
                <span className="text-tertiary font-normal lowercase tracking-normal">today</span>
              </div>
            )}
            {data?.lastUpdated && (
              <div className="text-xs text-tertiary flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-gain animate-pulse" />
                Updated {new Date(data.lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            )}
          </div>
        </motion.div>

        <motion.button
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center justify-center gap-2 px-6 py-3 bg-surface-3 text-primary border border-border hover:border-accent hover:text-accent rounded-xl text-sm font-bold transition-all disabled:opacity-50 min-h-[48px] shadow-lg"
        >
          <RefreshCw size={18} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Syncing...' : 'Sync Portfolio'}
        </motion.button>
      </section>

      {/* Metric Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 lg:gap-6">
        <MetricCard
          label="Total Assets"
          value={formatCurrency(totalAssets)}
          valueColor="gain"
          icon={ArrowUpCircle}
        />
        <MetricCard
          label="Total Liabilities"
          value={formatCurrency(totalLiabilities)}
          valueColor="loss"
          icon={ArrowDownCircle}
        />
        <MetricCard
          label="30-Day Performance"
          value={formatCurrency(Math.abs(monthlyChange.amount))}
          change={formatPercent(monthlyChange.percent)}
          trend={monthlyChange.amount >= 0 ? 'up' : 'down'}
          valueColor={monthlyChange.amount >= 0 ? 'gain' : 'loss'}
          icon={Activity}
        />
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6 lg:gap-8">
        {/* Allocation */}
        <div className="xl:col-span-3">
          <AllocationDonut items={data?.items || []} className="h-full" />
        </div>

        {/* Accounts Sidebar */}
        <div className="xl:col-span-2 card p-6 lg:p-8 flex flex-col gap-6 bg-surface-2/50 backdrop-blur-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-[11px] font-bold tracking-widest uppercase text-tertiary">
              Active Accounts
            </h2>
            <div className="text-[10px] text-accent font-bold px-2 py-0.5 rounded bg-accent/10 border border-accent/20">
              {accountSummaries.length} Total
            </div>
          </div>
          
          <div className="space-y-4 overflow-y-auto max-h-[400px] pr-2 custom-scrollbar">
            {accountSummaries.map((account, idx) => (
              <motion.div
                key={account.name}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: idx * 0.05 }}
                className="flex items-center justify-between gap-4 p-4 bg-surface rounded-2xl border border-transparent hover:border-border transition-all group cursor-pointer"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-primary truncate group-hover:text-accent transition-colors">
                    {account.name}
                  </div>
                  <div className="font-money text-xs text-secondary mt-0.5">
                    {formatCompactCurrency(account.value)}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <SparkLine data={account.sparkData} width={100} height={32} />
                </div>
              </motion.div>
            ))}
            {accountSummaries.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="w-12 h-12 rounded-full bg-surface-3 flex items-center justify-center text-tertiary mb-3">
                  <Wallet size={24} />
                </div>
                <p className="text-tertiary text-sm">No accounts found</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Detailed Holdings */}
      <div className="pt-4">
        <DashboardTable items={data.items} />
      </div>
    </div>
  );
};

export default Dashboard;
