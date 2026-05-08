import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { format, subDays, subMonths, subYears, differenceInDays, parseISO } from 'date-fns';
import { motion, AnimatePresence } from 'framer-motion';
import { Calendar, Filter, ChevronDown, ChevronUp, Check, X, Layers } from 'lucide-react';
import AccountHistoryChart from '../components/AccountHistoryChart';
import { accounts as accountsApi, history as historyApi } from '../utils/api';

const DATE_RANGE_OPTIONS = [
  { label: '7D', fullLabel: '7 Days', value: '7d', days: 7, getDates: () => ({ start: subDays(new Date(), 7), end: new Date() }) },
  { label: '30D', fullLabel: '30 Days', value: '30d', days: 30, getDates: () => ({ start: subDays(new Date(), 30), end: new Date() }) },
  { label: '3M', fullLabel: '3 Months', value: '3m', days: 90, getDates: () => ({ start: subMonths(new Date(), 3), end: new Date() }) },
  { label: '6M', fullLabel: '6 Months', value: '6m', days: 180, getDates: () => ({ start: subMonths(new Date(), 6), end: new Date() }) },
  { label: '1Y', fullLabel: '1 Year', value: '1y', days: 365, getDates: () => ({ start: subYears(new Date(), 1), end: new Date() }) },
  { label: 'ALL', fullLabel: 'All Time', value: 'all', days: null, getDates: () => ({ start: null, end: null }) },
  { label: 'CUSTOM', fullLabel: 'Custom', value: 'custom', days: null, getDates: () => null },
];

const calculateLimit = (dateRangeOption, customStartDate, customEndDate) => {
  if (dateRangeOption === 'all') return 10000;
  if (dateRangeOption === 'custom' && customStartDate && customEndDate) {
    return differenceInDays(parseISO(customEndDate), parseISO(customStartDate)) + 1;
  }
  const option = DATE_RANGE_OPTIONS.find(opt => opt.value === dateRangeOption);
  if (option?.days) return option.days + 1;
  return 10000;
};

const AccountHistory = () => {
  const [accounts, setAccounts] = useState([]);
  const [selectedAccounts, setSelectedAccounts] = useState([]);
  const [showPortfolio, setShowPortfolio] = useState(true);
  const [dateRangeOption, setDateRangeOption] = useState('30d');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [accountData, setAccountData] = useState([]);
  const [portfolioData, setPortfolioData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filtersExpanded, setFiltersExpanded] = useState(true);

  useEffect(() => {
    const fetchAccounts = async () => {
      try {
        const data = await accountsApi.getAll();
        const list = data.accounts || [];
        setAccounts(list);
        setSelectedAccounts(list.map(acc => acc.id));
      } catch (err) {
        console.error('Error fetching accounts:', err);
        setError('Failed to load accounts');
      }
    };
    fetchAccounts();
  }, []);

  const getDateRange = useCallback(() => {
    if (dateRangeOption === 'custom') {
      return { startDate: customStartDate || undefined, endDate: customEndDate || undefined };
    }
    const option = DATE_RANGE_OPTIONS.find(opt => opt.value === dateRangeOption);
    if (option && option.getDates) {
      const dates = option.getDates();
      if (dates) {
        return {
          startDate: dates.start ? format(dates.start, 'yyyy-MM-dd') : undefined,
          endDate: dates.end ? format(dates.end, 'yyyy-MM-dd') : undefined,
        };
      }
    }
    return {};
  }, [dateRangeOption, customStartDate, customEndDate]);

  useEffect(() => {
    const fetchHistoryData = async () => {
      setLoading(true);
      setError(null);

      try {
        const dateRange = getDateRange();
        const limit = calculateLimit(dateRangeOption, customStartDate, customEndDate);
        const params = { ...dateRange, limit };
        const fetchPromises = [];

        if (selectedAccounts.length > 0) {
          const accountPromises = selectedAccounts.map(accountId =>
            historyApi.getAccounts({ ...params, account_id: accountId })
          );
          fetchPromises.push(
            Promise.all(accountPromises).then(results => {
              setAccountData(results.flatMap(result => result.data || []));
            })
          );
        } else {
          setAccountData([]);
        }

        if (showPortfolio) {
          fetchPromises.push(
            historyApi.getPortfolio(params).then(result => {
              setPortfolioData(result.data || []);
            })
          );
        } else {
          setPortfolioData([]);
        }

        await Promise.all(fetchPromises);
      } catch (err) {
        console.error('Error fetching history data:', err);
        setError('Failed to load history data');
      } finally {
        setLoading(false);
      }
    };

    if (accounts.length > 0) fetchHistoryData();
  }, [accounts, selectedAccounts, showPortfolio, getDateRange, dateRangeOption, customStartDate, customEndDate]);

  const handleAccountToggle = (accountId) => {
    setSelectedAccounts(prev =>
      prev.includes(accountId) ? prev.filter(id => id !== accountId) : [...prev, accountId]
    );
  };

  const handleSelectAll = () => {
    setSelectedAccounts(
      selectedAccounts.length === accounts.length ? [] : accounts.map(acc => acc.id)
    );
  };

  const allSelected = selectedAccounts.length === accounts.length && accounts.length > 0;

  return (
    <div className="container mx-auto px-4 py-6 md:py-8">
      {/* Header Section */}
      <div className="flex flex-col md:flex-row md:items-end justify-between mb-8 gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Layers className="text-accent w-5 h-5" />
            <h1 className="text-2xl md:text-3xl font-bold text-primary tracking-tight">Account History</h1>
          </div>
          <p className="text-sm text-secondary">Analyze your net worth progression and account performance</p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex bg-surface-2 p-1 rounded-xl border border-border shadow-inner">
            {DATE_RANGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                onClick={() => setDateRangeOption(option.value)}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-bold tracking-wider transition-all duration-200 ${
                  dateRangeOption === option.value
                    ? 'bg-accent text-inverse shadow-glow scale-105'
                    : 'text-tertiary hover:text-secondary'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Sidebar Filters */}
        <div className="lg:col-span-1 space-y-6">
          <div className="card overflow-hidden">
            <button 
              onClick={() => setFiltersExpanded(!filtersExpanded)}
              className="w-full flex items-center justify-between p-4 border-b border-border bg-surface-2/50"
            >
              <div className="flex items-center gap-2">
                <Filter size={16} className="text-accent" />
                <span className="text-sm font-bold uppercase tracking-widest text-primary">Filters</span>
              </div>
              {filtersExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>

            <AnimatePresence initial={false}>
              {filtersExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.3 }}
                >
                  <div className="p-4 space-y-6">
                    {/* Select All / Portfolio Toggle */}
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        onClick={handleSelectAll}
                        className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border transition-all text-xs font-bold uppercase tracking-wider ${
                          allSelected 
                            ? 'bg-accent/10 border-accent/50 text-accent' 
                            : 'bg-surface-3 border-border text-secondary hover:border-border-hover'
                        }`}
                      >
                        {allSelected ? <Check size={14} /> : <div className="w-3.5 h-3.5" />}
                        All Accounts
                      </button>
                      <button
                        onClick={() => setShowPortfolio(!showPortfolio)}
                        className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border transition-all text-xs font-bold uppercase tracking-wider ${
                          showPortfolio 
                            ? 'bg-accent/10 border-accent/50 text-accent' 
                            : 'bg-surface-3 border-border text-secondary hover:border-border-hover'
                        }`}
                      >
                        {showPortfolio ? <Check size={14} /> : <div className="w-3.5 h-3.5" />}
                        Net Worth
                      </button>
                    </div>

                    {/* Account Grid */}
                    <div>
                      <p className="text-[10px] font-bold text-tertiary uppercase tracking-widest mb-3">Select Accounts</p>
                      <div className="grid grid-cols-1 gap-2 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                        {accounts.map((account) => {
                          const isSelected = selectedAccounts.includes(account.id);
                          return (
                            <button
                              key={account.id}
                              onClick={() => handleAccountToggle(account.id)}
                              className={`flex items-center gap-3 p-2.5 rounded-xl border transition-all text-left ${
                                isSelected
                                  ? 'bg-surface-3 border-accent/30 ring-1 ring-accent/10'
                                  : 'bg-surface-2 border-transparent hover:border-border opacity-60'
                              }`}
                            >
                              <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isSelected ? 'bg-accent shadow-glow' : 'bg-tertiary'}`} />
                              <span className={`text-xs font-medium truncate ${isSelected ? 'text-primary' : 'text-tertiary'}`}>
                                {account.name}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Custom Date Inputs */}
                    {dateRangeOption === 'custom' && (
                      <motion.div
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="space-y-3 pt-4 border-t border-border"
                      >
                        <div className="space-y-1.5">
                          <label className="text-[10px] font-bold text-tertiary uppercase tracking-widest">Start Date</label>
                          <div className="relative">
                            <input
                              type="date"
                              value={customStartDate}
                              onChange={(e) => setCustomStartDate(e.target.value)}
                              className="w-full bg-surface-3 border-border rounded-lg px-3 py-2 text-xs focus:ring-1 focus:ring-accent outline-none"
                            />
                            <Calendar size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-tertiary pointer-events-none" />
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-[10px] font-bold text-tertiary uppercase tracking-widest">End Date</label>
                          <div className="relative">
                            <input
                              type="date"
                              value={customEndDate}
                              onChange={(e) => setCustomEndDate(e.target.value)}
                              className="w-full bg-surface-3 border-border rounded-lg px-3 py-2 text-xs focus:ring-1 focus:ring-accent outline-none"
                            />
                            <Calendar size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-tertiary pointer-events-none" />
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          
          <div className="hidden lg:block card p-4 bg-accent-muted/20 border-accent/20">
            <h4 className="text-xs font-bold text-accent mb-2 uppercase tracking-wider">Insight</h4>
            <p className="text-xs text-secondary leading-relaxed">
              Toggle accounts to compare performance across different asset classes. Enable "Net Worth" to see your total aggregated value.
            </p>
          </div>
        </div>

        {/* Main Chart Area */}
        <div className="lg:col-span-3">
          <AccountHistoryChart
            accountData={accountData}
            portfolioData={portfolioData}
            accounts={accounts}
            selectedAccounts={selectedAccounts}
            showPortfolio={showPortfolio}
            loading={loading}
            error={error}
          />
          
          {/* Legend helper text */}
          <div className="flex items-center justify-center gap-4 text-[10px] text-tertiary uppercase tracking-widest">
            <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-accent" /> Click legend to toggle lines</span>
            <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-surface-3 border border-border" /> Scroll to zoom</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AccountHistory;
