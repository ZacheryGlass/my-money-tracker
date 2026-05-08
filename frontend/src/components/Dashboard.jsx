import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { RefreshCw, Wallet, ArrowDownCircle, ArrowUpCircle, Activity, ChevronRight, TrendingUp, Clock, Zap, Landmark } from 'lucide-react';
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
      <div className="flex flex-col items-center justify-center min-h-[500px] gap-4">
        <div className="w-12 h-12 border-4 border-accent border-t-transparent rounded-full animate-spin shadow-glow" />
        <span className="text-xs font-bold tracking-widest uppercase text-tertiary animate-pulse">Aggregating Portfolio</span>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 md:py-12 max-w-[1600px] space-y-12">
      {/* Hero Section */}
      <section className="flex flex-col lg:flex-row lg:items-end justify-between gap-8 pt-4 relative">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          <div className="flex items-center gap-3">
            <div className="px-3 py-1 rounded-full bg-accent/10 border border-accent/20 text-accent text-[10px] font-bold uppercase tracking-widest flex items-center gap-2">
              <Zap size={12} className="fill-accent" />
              Live Net Worth
            </div>
            {data?.lastUpdated && (
              <div className="text-[10px] font-bold uppercase tracking-widest text-tertiary flex items-center gap-1.5 opacity-60">
                <Clock size={12} />
                Synced {new Date(data.lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            )}
          </div>
          
          <div className="space-y-1">
            <h1 className="text-5xl md:text-7xl font-bold text-primary tracking-tighter leading-none">
              {formatCurrency(netWorth)}
            </h1>
            <div className="flex items-center gap-4">
              {dailyChange.amount !== 0 && (
                <div className={`flex items-center gap-1.5 text-sm font-bold ${dailyChange.amount >= 0 ? 'text-gain' : 'text-loss'}`}>
                  {dailyChange.amount >= 0 ? <TrendingUp size={16} /> : <TrendingUp size={16} className="rotate-180" />}
                  {formatCurrency(Math.abs(dailyChange.amount))} ({formatPercent(dailyChange.percent)})
                  <span className="text-tertiary font-medium uppercase text-[10px] tracking-widest ml-1">Today</span>
                </div>
              )}
            </div>
          </div>
        </motion.div>

        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-wrap items-center gap-3"
        >
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center justify-center gap-2 px-6 py-4 bg-surface-2 text-primary border border-border hover:border-accent hover:text-accent rounded-2xl text-sm font-bold transition-all disabled:opacity-50 min-h-[56px] shadow-sm group"
          >
            <RefreshCw size={18} className={`${refreshing ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-500'}`} />
            {refreshing ? 'Syncing...' : 'Refresh Data'}
          </button>
        </motion.div>
      </section>

      {/* Primary Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
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

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-8">
        {/* Left: Allocation Breakdown */}
        <div className="xl:col-span-3 space-y-6">
          <div className="flex items-center justify-between px-2">
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-tertiary">Asset Allocation</h2>
            <button onClick={() => onNavigate('assets')} className="text-[10px] font-bold uppercase tracking-widest text-accent flex items-center gap-1 hover:underline">
              Full Breakdown <ChevronRight size={12} />
            </button>
          </div>
          <div className="card bg-surface-2/50 backdrop-blur-md border-border/50">
            <AllocationDonut items={data?.items || []} className="min-h-[450px]" />
          </div>
        </div>

        {/* Right: Account Feed */}
        <div className="xl:col-span-2 space-y-6">
          <div className="flex items-center justify-between px-2">
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-tertiary">Live Account Feed</h2>
            <button onClick={() => onNavigate('accounts')} className="text-[10px] font-bold uppercase tracking-widest text-accent flex items-center gap-1 hover:underline">
              All Accounts <ChevronRight size={12} />
            </button>
          </div>
          
          <div className="card p-2 bg-surface-2/30 border-border/50 flex flex-col gap-2 max-h-[520px] overflow-y-auto custom-scrollbar">
            <AnimatePresence mode="popLayout">
              {accountSummaries.map((account, idx) => (
                <motion.div
                  key={account.name}
                  layout
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.05 }}
                  className="flex items-center justify-between gap-4 p-4 bg-surface rounded-2xl border border-transparent hover:border-border/50 hover:bg-surface-2 transition-all group cursor-pointer"
                  onClick={() => onNavigate('accounts')}
                >
                  <div className="flex items-center gap-4 flex-1 min-w-0">
                    <div className="w-10 h-10 rounded-xl bg-surface-3 border border-border/50 flex items-center justify-center text-accent group-hover:scale-110 transition-transform">
                      <Landmark size={18} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-bold text-primary truncate">
                        {account.name}
                      </div>
                      <div className="text-xs font-mono font-bold text-secondary mt-0.5">
                        {formatCompactCurrency(account.value)}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <SparkLine data={account.sparkData} width={100} height={32} />
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
            
            {accountSummaries.length === 0 && (
              <div className="flex flex-col items-center justify-center py-24 text-center opacity-40">
                <Wallet size={40} className="text-tertiary mb-4" />
                <p className="text-[10px] font-bold uppercase tracking-widest text-tertiary">No Active Accounts</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Global Asset Table */}
      <div className="space-y-6">
        <div className="flex items-center justify-between px-2">
          <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-tertiary">Portfolio Details</h2>
        </div>
        <div className="card overflow-hidden bg-surface-2/20 border-border/50">
          <DashboardTable items={data?.items || []} onNavigate={onNavigate} />
        </div>
      </div>
      
      {/* Helper text */}
      <div className="flex items-center justify-center gap-12 text-[10px] text-tertiary uppercase tracking-widest font-bold opacity-60 pb-8">
        <span className="flex items-center gap-2"><div className="w-1.5 h-1.5 rounded-full bg-accent shadow-glow" /> Dynamic Net Worth</span>
        <span className="flex items-center gap-2"><div className="w-1.5 h-1.5 rounded-full bg-gain shadow-glow" /> Real-time pricing</span>
        <span className="flex items-center gap-2"><div className="w-1.5 h-1.5 rounded-full bg-surface-3 border border-border" /> Aggregated Institutions</span>
      </div>
    </div>
  );
};

export default Dashboard;
