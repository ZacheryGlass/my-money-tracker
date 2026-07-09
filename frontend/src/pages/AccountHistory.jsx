import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { format, subDays, subMonths, subYears, differenceInDays, parseISO } from 'date-fns';
import { Check, Calendar } from 'lucide-react';
import AccountHistoryChart from '../components/AccountHistoryChart';
import { accounts as accountsApi, history as historyApi } from '../utils/api';
import { buildAccountDisplayNameMap, getAccountDisplayName } from '../utils/accountDisplay';

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

  useEffect(() => {
    const fetchAccounts = async () => {
      try {
        const data = await accountsApi.getAll();
        const list = data.accounts || [];
        setAccounts(list);
        setSelectedAccounts(list.map(acc => acc.id));
      } catch {
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
      } catch {
        setError('Failed to load history data');
      } finally {
        setLoading(false);
      }
    };
    if (accounts.length > 0) fetchHistoryData();
  }, [accounts, selectedAccounts, showPortfolio, getDateRange, dateRangeOption, customStartDate, customEndDate]);

  const handleAccountToggle = (accountId) => {
    setSelectedAccounts(prev => prev.includes(accountId) ? prev.filter(id => id !== accountId) : [...prev, accountId]);
  };

  const handleSelectAll = () => {
    setSelectedAccounts(selectedAccounts.length === accounts.length ? [] : accounts.map(acc => acc.id));
  };

  const allSelected = selectedAccounts.length === accounts.length && accounts.length > 0;
  const accountDisplayNames = useMemo(() => buildAccountDisplayNameMap(accounts), [accounts]);
  const displayAccountName = useMemo(
    () => (account) => accountDisplayNames.get(account.id) || getAccountDisplayName(account),
    [accountDisplayNames]
  );
  const displayAccounts = useMemo(
    () => accounts.map((account) => ({ ...account, effective_name: displayAccountName(account) })),
    [accounts, displayAccountName]
  );

  return (
    <div className="px-4 py-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-4 gap-3">
        <div>
          <h1 className="text-display-md text-primary">Account History</h1>
          <p className="text-body-sm text-tertiary">Net worth progression and account performance</p>
        </div>
        <div className="flex bg-surface border border-border">
          {DATE_RANGE_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => setDateRangeOption(option.value)}
              className={`px-2 py-1 text-caption transition-colors ${
                dateRangeOption === option.value ? 'bg-accent text-white' : 'text-tertiary hover:text-secondary'
              }`}
            >{option.label}</button>
          ))}
        </div>
      </div>

      <div className="card mb-4">
        <div className="p-3 space-y-3">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleSelectAll}
              className={`flex items-center gap-1.5 border px-2 py-1 text-caption transition-colors ${
                allSelected ? 'bg-accent-muted border-accent/30 text-accent' : 'bg-surface border-border text-tertiary hover:text-secondary'
              }`}
            >
              {allSelected && <Check size={12} />}
              All Accounts
            </button>
            <button
              onClick={() => setShowPortfolio(!showPortfolio)}
              className={`flex items-center gap-1.5 border px-2 py-1 text-caption transition-colors ${
                showPortfolio ? 'bg-accent-muted border-accent/30 text-accent' : 'bg-surface border-border text-tertiary hover:text-secondary'
              }`}
            >
              {showPortfolio && <Check size={12} />}
              Net Worth
            </button>
          </div>

          <div className="flex flex-wrap gap-1">
            {accounts.map((account) => {
              const isSelected = selectedAccounts.includes(account.id);
              return (
                <button
                  key={account.id}
                  onClick={() => handleAccountToggle(account.id)}
                  className={`flex items-center gap-1.5 border px-2 py-1 text-caption transition-colors ${
                    isSelected ? 'bg-surface-3 border-accent/30 text-primary' : 'bg-surface border-border text-tertiary hover:text-secondary'
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${isSelected ? 'bg-accent' : 'bg-tertiary'}`} />
                  <span className="max-w-[200px] truncate">{displayAccountName(account)}</span>
                </button>
              );
            })}
          </div>

          {dateRangeOption === 'custom' && (
            <div className="grid grid-cols-1 gap-2 border-t border-border pt-3 sm:grid-cols-2">
              <div>
                <label className="text-caption text-tertiary uppercase block mb-1">Start Date</label>
                <input type="date" value={customStartDate} onChange={(e) => setCustomStartDate(e.target.value)} className="w-full bg-surface-3 border-border px-2 py-1 text-caption" />
              </div>
              <div>
                <label className="text-caption text-tertiary uppercase block mb-1">End Date</label>
                <input type="date" value={customEndDate} onChange={(e) => setCustomEndDate(e.target.value)} className="w-full bg-surface-3 border-border px-2 py-1 text-caption" />
              </div>
            </div>
          )}
        </div>
      </div>

      <AccountHistoryChart
        accountData={accountData}
        portfolioData={portfolioData}
        accounts={displayAccounts}
        selectedAccounts={selectedAccounts}
        showPortfolio={showPortfolio}
        loading={loading}
        error={error}
      />
    </div>
  );
};

export default AccountHistory;
