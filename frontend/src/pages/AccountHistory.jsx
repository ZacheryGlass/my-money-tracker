import React, { useState, useEffect, useCallback } from 'react';
import { format, subDays, subMonths, subYears, differenceInDays, parseISO } from 'date-fns';
import AccountHistoryChart from '../components/AccountHistoryChart';
import { accounts as accountsApi, history as historyApi } from '../utils/api';

const DATE_RANGE_OPTIONS = [
  { label: '7 Days', value: '7d', days: 7, getDates: () => ({ start: subDays(new Date(), 7), end: new Date() }) },
  { label: '30 Days', value: '30d', days: 30, getDates: () => ({ start: subDays(new Date(), 30), end: new Date() }) },
  { label: '3 Months', value: '3m', days: 90, getDates: () => ({ start: subMonths(new Date(), 3), end: new Date() }) },
  { label: '6 Months', value: '6m', days: 180, getDates: () => ({ start: subMonths(new Date(), 6), end: new Date() }) },
  { label: '1 Year', value: '1y', days: 365, getDates: () => ({ start: subYears(new Date(), 1), end: new Date() }) },
  { label: 'All Time', value: 'all', days: null, getDates: () => ({ start: null, end: null }) },
  { label: 'Custom', value: 'custom', days: null, getDates: () => null },
];

const calculateLimit = (dateRangeOption, customStartDate, customEndDate) => {
  if (dateRangeOption === 'custom' && customStartDate && customEndDate) {
    const days = differenceInDays(parseISO(customEndDate), parseISO(customStartDate));
    return Math.min(Math.max(days + 1, 30), 100);
  }
  const option = DATE_RANGE_OPTIONS.find(opt => opt.value === dateRangeOption);
  if (option?.days) return Math.min(option.days + 1, 100);
  return 100;
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

  return (
    <div className="container mx-auto px-4 py-4 md:py-6 animate-fade-in">
      <div className="mb-4 md:mb-6">
        <h1 className="text-2xl md:text-3xl font-bold text-primary mb-1">Account History</h1>
        <p className="text-sm text-secondary">View your account value history over time</p>
      </div>

      <div className="card p-3 md:p-4 mb-4 md:mb-6">
        <div className="grid grid-cols-1 gap-4 md:gap-6">
          <div>
            <p className="text-xs font-medium text-secondary uppercase tracking-wider mb-2">Accounts</p>
            <div className="border border-border rounded-md p-3 max-h-48 overflow-y-auto bg-surface">
              <div className="mb-2 pb-2 border-b border-border">
                <label className="flex items-center cursor-pointer min-h-[44px]">
                  <input
                    type="checkbox"
                    checked={selectedAccounts.length === accounts.length && accounts.length > 0}
                    onChange={handleSelectAll}
                    className="h-5 w-5 touch-manipulation"
                    style={{ accentColor: 'var(--accent)' }}
                  />
                  <span className="ml-2 text-sm font-medium" style={{ color: 'var(--accent)' }}>
                    Select All
                  </span>
                </label>
              </div>
              {accounts.map((account) => (
                <label key={account.id} className="flex items-center cursor-pointer py-2 min-h-[44px]">
                  <input
                    type="checkbox"
                    checked={selectedAccounts.includes(account.id)}
                    onChange={() => handleAccountToggle(account.id)}
                    className="h-5 w-5 touch-manipulation"
                    style={{ accentColor: 'var(--accent)' }}
                  />
                  <span className="ml-2 text-sm text-primary">{account.name}</span>
                </label>
              ))}
              {accounts.length === 0 && (
                <p className="text-sm text-secondary">No accounts found</p>
              )}
            </div>
          </div>

          <div>
            <p className="text-xs font-medium text-secondary uppercase tracking-wider mb-2">Date Range</p>
            <div className="flex flex-wrap gap-2 mb-3">
              {DATE_RANGE_OPTIONS.filter(o => o.value !== 'custom').map((option) => (
                <button
                  key={option.value}
                  onClick={() => setDateRangeOption(option.value)}
                  className={`px-3 py-2 rounded-md text-xs font-medium transition-colors touch-manipulation min-h-[44px] ${
                    dateRangeOption === option.value
                      ? 'bg-accent text-inverse'
                      : 'bg-surface-3 text-secondary hover:text-primary'
                  }`}
                >
                  {option.label}
                </button>
              ))}
              <button
                onClick={() => setDateRangeOption('custom')}
                className={`px-3 py-2 rounded-md text-xs font-medium transition-colors touch-manipulation min-h-[44px] ${
                  dateRangeOption === 'custom'
                    ? 'bg-accent text-inverse'
                    : 'bg-surface-3 text-secondary hover:text-primary'
                }`}
              >
                Custom
              </button>
            </div>
            {dateRangeOption === 'custom' && (
              <div className="mt-3 space-y-2">
                <div>
                  <label className="block text-xs text-tertiary mb-1">Start Date</label>
                  <input
                    type="date"
                    value={customStartDate}
                    onChange={(e) => setCustomStartDate(e.target.value)}
                    className="w-full px-3 py-2 border border-input-border rounded-md text-sm min-h-[44px] touch-manipulation"
                  />
                </div>
                <div>
                  <label className="block text-xs text-tertiary mb-1">End Date</label>
                  <input
                    type="date"
                    value={customEndDate}
                    onChange={(e) => setCustomEndDate(e.target.value)}
                    className="w-full px-3 py-2 border border-input-border rounded-md text-sm min-h-[44px] touch-manipulation"
                  />
                </div>
              </div>
            )}
          </div>

          <div>
            <p className="text-xs font-medium text-secondary uppercase tracking-wider mb-2">Display Options</p>
            <label className="flex items-center cursor-pointer min-h-[44px]">
              <input
                type="checkbox"
                checked={showPortfolio}
                onChange={(e) => setShowPortfolio(e.target.checked)}
                className="h-5 w-5 touch-manipulation"
                style={{ accentColor: 'var(--accent)' }}
              />
              <span className="ml-2 text-sm text-primary">Show Total Portfolio</span>
            </label>
          </div>
        </div>
      </div>

      <AccountHistoryChart
        accountData={accountData}
        portfolioData={portfolioData}
        accounts={accounts}
        selectedAccounts={selectedAccounts}
        showPortfolio={showPortfolio}
        loading={loading}
        error={error}
      />
    </div>
  );
};

export default AccountHistory;
