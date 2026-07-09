import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { format, subDays, subMonths, subYears, differenceInDays, parseISO } from 'date-fns';
import { Check, Search, X } from 'lucide-react';
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
  const [accountSearch, setAccountSearch] = useState('');

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
  const filteredAccounts = useMemo(() => {
    const query = accountSearch.trim().toLowerCase();
    if (!query) return displayAccounts;
    return displayAccounts.filter((account) =>
      account.effective_name.toLowerCase().includes(query) ||
      account.name?.toLowerCase().includes(query) ||
      account.type?.toLowerCase().includes(query)
    );
  }, [accountSearch, displayAccounts]);
  const selectedDisplayAccounts = useMemo(() => {
    const selected = new Set(selectedAccounts);
    return displayAccounts.filter((account) => selected.has(account.id));
  }, [displayAccounts, selectedAccounts]);
  const selectAccountPreset = (predicate, includePortfolio = false) => {
    setShowPortfolio(includePortfolio);
    setSelectedAccounts(displayAccounts.filter(predicate).map((account) => account.id));
  };

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
            <button
              onClick={() => { setShowPortfolio(true); setSelectedAccounts([]); }}
              className={`flex items-center gap-1.5 border px-2 py-1 text-caption transition-colors ${
                showPortfolio && selectedAccounts.length === 0 ? 'bg-accent-muted border-accent/30 text-accent' : 'bg-surface border-border text-tertiary hover:text-secondary'
              }`}
            >
              {showPortfolio && selectedAccounts.length === 0 && <Check size={12} />}
              Total Portfolio
            </button>
            <button
              onClick={() => selectAccountPreset((account) => !['credit', 'loan'].includes(account.type))}
              className="flex items-center gap-1.5 border border-border bg-surface px-2 py-1 text-caption text-tertiary transition-colors hover:text-secondary"
            >
              Assets Only
            </button>
            <button
              onClick={() => selectAccountPreset((account) => ['credit', 'loan'].includes(account.type))}
              className="flex items-center gap-1.5 border border-border bg-surface px-2 py-1 text-caption text-tertiary transition-colors hover:text-secondary"
            >
              Liabilities Only
            </button>
            <button
              onClick={() => selectAccountPreset((account) => account.type === 'depository')}
              className="flex items-center gap-1.5 border border-border bg-surface px-2 py-1 text-caption text-tertiary transition-colors hover:text-secondary"
            >
              Cash Only
            </button>
          </div>

          <div className="grid gap-3 border-t border-border pt-3 lg:grid-cols-[minmax(220px,0.7fr)_1fr]">
            <div>
              <label className="mb-1 flex items-center gap-2 text-caption uppercase text-tertiary">
                <Search size={12} />
                Search Accounts
              </label>
              <div className="relative">
                <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-tertiary" />
                <input
                  type="text"
                  value={accountSearch}
                  onChange={(event) => setAccountSearch(event.target.value)}
                  placeholder="Name or type"
                  className="w-full bg-surface-3 border-border py-1 pl-7 pr-7 text-caption"
                />
                {accountSearch && (
                  <button
                    onClick={() => setAccountSearch('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-tertiary hover:text-primary"
                    aria-label="Clear account search"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            </div>

            <div>
              <div className="mb-1 text-caption uppercase text-tertiary">
                Selected {selectedDisplayAccounts.length}{showPortfolio ? ' + Net Worth' : ''}
              </div>
              <div className="flex min-h-[30px] flex-wrap gap-1">
                {selectedDisplayAccounts.slice(0, 8).map((account) => (
                  <button
                    key={account.id}
                    onClick={() => handleAccountToggle(account.id)}
                    className="flex max-w-[220px] items-center gap-1.5 border border-accent/20 bg-accent-muted px-2 py-1 text-caption text-accent"
                    title={account.effective_name}
                  >
                    <span className="truncate">{account.effective_name}</span>
                    <X size={10} />
                  </button>
                ))}
                {selectedDisplayAccounts.length > 8 && (
                  <span className="border border-border bg-surface-2 px-2 py-1 text-caption text-tertiary">
                    +{selectedDisplayAccounts.length - 8} more
                  </span>
                )}
                {selectedDisplayAccounts.length === 0 && !showPortfolio && (
                  <span className="px-2 py-1 text-caption text-tertiary">No account series selected</span>
                )}
              </div>
            </div>
          </div>

          <div className="flex max-h-36 flex-wrap gap-1 overflow-y-auto pr-1">
            {filteredAccounts.map((account) => {
              const isSelected = selectedAccounts.includes(account.id);
              return (
                <button
                  key={account.id}
                  onClick={() => handleAccountToggle(account.id)}
                  className={`flex items-center gap-1.5 border px-2 py-1 text-caption transition-colors ${
                    isSelected ? 'bg-surface-3 border-accent/30 text-primary' : 'bg-surface border-border text-tertiary hover:text-secondary'
                  }`}
                  title={account.effective_name}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${isSelected ? 'bg-accent' : 'bg-tertiary'}`} />
                  <span className="max-w-[200px] truncate">{account.effective_name}</span>
                  <span className="text-[9px] uppercase text-tertiary">{account.type}</span>
                </button>
              );
            })}
            {filteredAccounts.length === 0 && <p className="py-1 text-caption text-tertiary">No accounts found</p>}
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
