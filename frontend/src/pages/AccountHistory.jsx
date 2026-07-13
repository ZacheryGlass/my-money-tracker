import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { format, subDays, subMonths, subYears, differenceInDays, parseISO } from 'date-fns';
import {
  BarChart3,
  Calendar,
  Check,
  CreditCard,
  Landmark,
  Search,
  TrendingUp,
  Wallet,
  X,
} from 'lucide-react';
import AccountHistoryChart from '../components/AccountHistoryChart';
import FilterDisclosure from '../components/FilterDisclosure';
import { accounts as accountsApi, history as historyApi } from '../utils/api';
import { buildAccountDisplayNameMap, getAccountDisplayName } from '../utils/accountDisplay';
import { formatCompactCurrency } from '../utils/format';

const DATE_RANGE_OPTIONS = [
  { label: '7D', fullLabel: '7 Days', value: '7d', days: 7, getDates: () => ({ start: subDays(new Date(), 7), end: new Date() }) },
  { label: '30D', fullLabel: '30 Days', value: '30d', days: 30, getDates: () => ({ start: subDays(new Date(), 30), end: new Date() }) },
  { label: '3M', fullLabel: '3 Months', value: '3m', days: 90, getDates: () => ({ start: subMonths(new Date(), 3), end: new Date() }) },
  { label: '6M', fullLabel: '6 Months', value: '6m', days: 180, getDates: () => ({ start: subMonths(new Date(), 6), end: new Date() }) },
  { label: '1Y', fullLabel: '1 Year', value: '1y', days: 365, getDates: () => ({ start: subYears(new Date(), 1), end: new Date() }) },
  { label: 'ALL', fullLabel: 'All Time', value: 'all', days: null, getDates: () => ({ start: null, end: null }) },
  { label: 'CUSTOM', fullLabel: 'Custom', value: 'custom', days: null, getDates: () => null },
];

const ACCOUNT_TYPE_LABELS = {
  investment: 'Investment',
  depository: 'Cash',
  credit: 'Credit',
  loan: 'Loan',
  crypto: 'Crypto',
  property: 'Property',
  other: 'Other',
};

const isLiabilityAccount = (account) => ['credit', 'loan'].includes(account.type);

const calculateLimit = (dateRangeOption, customStartDate, customEndDate) => {
  if (dateRangeOption === 'all') return 10000;
  if (dateRangeOption === 'custom' && customStartDate && customEndDate) {
    return Math.max(differenceInDays(parseISO(customEndDate), parseISO(customStartDate)) + 1, 1);
  }
  const option = DATE_RANGE_OPTIONS.find((opt) => opt.value === dateRangeOption);
  if (option?.days) return option.days + 1;
  return 10000;
};

const getLatestByAccount = (rows = []) => {
  const latest = new Map();
  rows.forEach((row) => {
    const id = row.account_id;
    const existing = latest.get(id);
    if (!existing || String(row.snapshot_date) > String(existing.snapshot_date)) {
      latest.set(id, row);
    }
  });
  return latest;
};

const rankAccountsByLatestValue = (accounts, historyRows, predicate = () => true, limit = 5) => {
  const latestByAccount = getLatestByAccount(historyRows);
  return accounts
    .filter(predicate)
    .map((account) => ({
      ...account,
      latestValue: Math.abs(parseFloat(latestByAccount.get(account.id)?.total_value) || 0),
    }))
    .sort((a, b) => b.latestValue - a.latestValue || a.effective_name.localeCompare(b.effective_name))
    .slice(0, limit)
    .map((account) => account.id);
};

const AccountHistory = () => {
  const [accounts, setAccounts] = useState([]);
  const [selectedAccounts, setSelectedAccounts] = useState([]);
  const [showPortfolio, setShowPortfolio] = useState(true);
  const [dateRangeOption, setDateRangeOption] = useState('3m');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [accountData, setAccountData] = useState([]);
  const [portfolioData, setPortfolioData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [accountSearch, setAccountSearch] = useState('');
  const selectionInitializedRef = useRef(false);

  useEffect(() => {
    const fetchAccounts = async () => {
      try {
        const data = await accountsApi.getAll();
        setAccounts(data.accounts || []);
      } catch {
        setError('Failed to load accounts');
      }
    };
    fetchAccounts();
  }, []);

  const accountDisplayNames = useMemo(() => buildAccountDisplayNameMap(accounts), [accounts]);
  const displayAccountName = useMemo(
    () => (account) => accountDisplayNames.get(account.id) || getAccountDisplayName(account),
    [accountDisplayNames]
  );
  const displayAccounts = useMemo(
    () => accounts.map((account) => ({ ...account, effective_name: displayAccountName(account) })),
    [accounts, displayAccountName]
  );

  const getDateRange = useCallback(() => {
    if (dateRangeOption === 'custom') {
      return { startDate: customStartDate || undefined, endDate: customEndDate || undefined };
    }
    const option = DATE_RANGE_OPTIONS.find((opt) => opt.value === dateRangeOption);
    if (option?.getDates) {
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
        const [accountResult, portfolioResult] = await Promise.all([
          historyApi.getAccounts(params),
          historyApi.getPortfolio(params),
        ]);
        const accountRows = accountResult.data || [];
        setAccountData(accountRows);
        setPortfolioData(portfolioResult.data || []);

        if (!selectionInitializedRef.current) {
          const defaultAccounts = rankAccountsByLatestValue(
            displayAccounts,
            accountRows,
            (account) => !isLiabilityAccount(account),
            4
          );
          setSelectedAccounts(defaultAccounts);
          selectionInitializedRef.current = true;
        }
      } catch {
        setError('Failed to load history data');
      } finally {
        setLoading(false);
      }
    };
    if (displayAccounts.length > 0) fetchHistoryData();
  }, [displayAccounts, getDateRange, dateRangeOption, customStartDate, customEndDate]);

  const latestByAccount = useMemo(() => getLatestByAccount(accountData), [accountData]);

  const setPreset = (preset) => {
    setAccountSearch('');
    if (preset === 'portfolio') {
      setShowPortfolio(true);
      setSelectedAccounts([]);
      return;
    }
    if (preset === 'major') {
      setShowPortfolio(true);
      setSelectedAccounts(rankAccountsByLatestValue(displayAccounts, accountData, () => true, 5));
      return;
    }
    if (preset === 'investments') {
      setShowPortfolio(true);
      setSelectedAccounts(rankAccountsByLatestValue(
        displayAccounts,
        accountData,
        (account) => ['investment', 'crypto', 'property'].includes(account.type),
        6
      ));
      return;
    }
    if (preset === 'cash') {
      setShowPortfolio(false);
      setSelectedAccounts(rankAccountsByLatestValue(
        displayAccounts,
        accountData,
        (account) => account.type === 'depository',
        6
      ));
      return;
    }
    if (preset === 'liabilities') {
      setShowPortfolio(false);
      setSelectedAccounts(rankAccountsByLatestValue(
        displayAccounts,
        accountData,
        isLiabilityAccount,
        6
      ));
    }
  };

  const handleAccountToggle = (accountId) => {
    setSelectedAccounts((prev) => (
      prev.includes(accountId) ? prev.filter((id) => id !== accountId) : [...prev, accountId]
    ));
  };

  const clearSelection = () => {
    setSelectedAccounts([]);
    setShowPortfolio(true);
  };

  const query = accountSearch.trim().toLowerCase();
  const filteredAccounts = useMemo(() => {
    if (!query) return displayAccounts;
    return displayAccounts.filter((account) =>
      account.effective_name.toLowerCase().includes(query) ||
      account.name?.toLowerCase().includes(query) ||
      account.type?.toLowerCase().includes(query)
    );
  }, [query, displayAccounts]);

  const selectedDisplayAccounts = useMemo(() => {
    const selected = new Set(selectedAccounts);
    return displayAccounts.filter((account) => selected.has(account.id));
  }, [displayAccounts, selectedAccounts]);

  const selectedRange = DATE_RANGE_OPTIONS.find((option) => option.value === dateRangeOption);
  const visibleSeriesCount = selectedAccounts.length + (showPortfolio ? 1 : 0);

  const presets = [
    { id: 'portfolio', label: 'Portfolio', icon: TrendingUp, detail: 'Net worth only' },
    { id: 'major', label: 'Major Accounts', icon: BarChart3, detail: 'Top balances' },
    { id: 'investments', label: 'Investments', icon: Landmark, detail: 'Invest, crypto, property' },
    { id: 'cash', label: 'Cash', icon: Wallet, detail: 'Depository accounts' },
    { id: 'liabilities', label: 'Liabilities', icon: CreditCard, detail: 'Credit and loans' },
  ];

  return (
    <div className="w-full min-w-0 max-w-[1600px] space-y-5 overflow-hidden px-3 py-4 sm:px-4 sm:py-5">
      <section className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="mb-0.5 text-caption uppercase tracking-wide text-tertiary">Account History</p>
          <h1 className="text-display-md text-primary">Account Trends</h1>
          <p className="text-body-sm text-tertiary">Compare portfolio and account balances over time.</p>
        </div>

        <div className="grid grid-cols-4 gap-1 rounded border border-border bg-surface p-1 sm:flex sm:flex-wrap sm:gap-2">
          {DATE_RANGE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setDateRangeOption(option.value)}
              className={`min-w-0 rounded px-2 py-2 text-caption-upper uppercase transition-colors sm:px-3 ${
                dateRangeOption === option.value
                  ? 'bg-accent/20 text-accent'
                  : 'text-secondary hover:bg-surface-2 hover:text-primary'
              }`}
              title={option.fullLabel}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>

      <FilterDisclosure
        label="Chart Setup"
        summary={`${selectedRange?.fullLabel || 'Selected range'} · ${visibleSeriesCount} series`}
        activeCount={visibleSeriesCount}
        onClear={clearSelection}
      >

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {presets.map((preset) => {
            const Icon = preset.icon;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => setPreset(preset.id)}
                className="flex items-start gap-3 rounded border border-border bg-surface-2 p-3 text-left transition-colors hover:border-accent/40 hover:bg-surface-3"
              >
                <Icon size={17} className="mt-0.5 shrink-0 text-accent" />
                <span className="min-w-0">
                  <span className="block text-body-sm font-semibold text-primary">{preset.label}</span>
                  <span className="block truncate text-caption text-secondary">{preset.detail}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {showPortfolio && (
            <button
              type="button"
              onClick={() => setShowPortfolio(false)}
              className="inline-flex items-center gap-2 rounded border border-accent/30 bg-accent/10 px-3 py-2 text-caption-upper uppercase text-accent"
            >
              <Check size={14} />
              Total Portfolio
              <X size={13} />
            </button>
          )}
          {selectedDisplayAccounts.slice(0, 8).map((account) => (
            <button
              key={account.id}
              type="button"
              onClick={() => handleAccountToggle(account.id)}
              className="inline-flex max-w-[260px] items-center gap-2 rounded border border-border bg-surface-2 px-3 py-2 text-caption text-primary transition-colors hover:border-accent/30"
              title={account.effective_name}
            >
              <span className="truncate">{account.effective_name}</span>
              <span className="font-money text-secondary">
                {formatCompactCurrency(parseFloat(latestByAccount.get(account.id)?.total_value) || 0)}
              </span>
              <X size={13} className="text-secondary" />
            </button>
          ))}
          {selectedDisplayAccounts.length > 8 && (
            <span className="rounded border border-border bg-surface-2 px-3 py-2 text-caption text-secondary">
              +{selectedDisplayAccounts.length - 8} more selected
            </span>
          )}
          {visibleSeriesCount === 0 && (
            <span className="rounded border border-loss/30 bg-loss-bg px-3 py-2 text-caption text-loss">
              Select a portfolio or account series to draw the chart.
            </span>
          )}
          {(selectedAccounts.length > 0 || !showPortfolio) && (
            <button
              type="button"
              onClick={clearSelection}
              className="inline-flex items-center gap-2 rounded border border-border bg-surface px-3 py-2 text-caption-upper uppercase text-secondary transition-colors hover:text-primary"
            >
              Clear
            </button>
          )}
        </div>

        <div className="mt-4 border-t border-border pt-4">
            <div className="grid gap-3 lg:grid-cols-[minmax(260px,360px)_1fr]">
              <div>
                <label className="mb-2 flex items-center gap-2 text-caption-upper uppercase text-secondary">
                  <Search size={14} />
                  Search accounts
                </label>
                <div className="relative">
                  <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-secondary" />
                  <input
                    type="text"
                    value={accountSearch}
                    onChange={(event) => setAccountSearch(event.target.value)}
                    placeholder="Name or type"
                    className="h-11 w-full rounded border-border bg-surface-3 py-2 pl-10 pr-10 text-body-sm"
                  />
                  {accountSearch && (
                    <button
                      type="button"
                      onClick={() => setAccountSearch('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-secondary hover:text-primary"
                      aria-label="Clear account search"
                    >
                      <X size={16} />
                    </button>
                  )}
                </div>
              </div>

              <div className="grid max-h-[320px] gap-2 overflow-y-auto pr-1 sm:grid-cols-2 xl:grid-cols-3">
                {filteredAccounts.map((account) => {
                  const selected = selectedAccounts.includes(account.id);
                  const latestValue = parseFloat(latestByAccount.get(account.id)?.total_value) || 0;
                  return (
                    <button
                      key={account.id}
                      type="button"
                      onClick={() => handleAccountToggle(account.id)}
                      className={`flex min-w-0 items-start justify-between gap-3 rounded border p-3 text-left transition-colors ${
                        selected
                          ? 'border-accent/40 bg-accent/10'
                          : 'border-border bg-surface-2 hover:border-border-hover hover:bg-surface-3'
                      }`}
                      title={account.effective_name}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-body-sm font-semibold text-primary">{account.effective_name}</span>
                        <span className="mt-1 block text-caption-upper uppercase text-secondary">
                          {ACCOUNT_TYPE_LABELS[account.type] || account.type || 'Account'}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block value-emphasis text-primary">
                          {formatCompactCurrency(latestValue)}
                        </span>
                        {selected && <Check size={14} className="ml-auto mt-1 text-accent" />}
                      </span>
                    </button>
                  );
                })}
                {filteredAccounts.length === 0 && (
                  <p className="rounded border border-border bg-surface-2 p-4 text-body-sm text-secondary">
                    No accounts match that search.
                  </p>
                )}
              </div>
            </div>
        </div>

        {dateRangeOption === 'custom' && (
          <div className="mt-4 grid grid-cols-1 gap-3 border-t border-border pt-4 sm:grid-cols-2 lg:max-w-xl">
            <div>
              <label className="mb-1 flex items-center gap-2 text-caption-upper uppercase text-secondary">
                <Calendar size={14} />
                Start Date
              </label>
              <input
                type="date"
                value={customStartDate}
                onChange={(event) => setCustomStartDate(event.target.value)}
                className="h-11 w-full rounded border-border bg-surface-3 px-3 text-body-sm"
              />
            </div>
            <div>
              <label className="mb-1 flex items-center gap-2 text-caption-upper uppercase text-secondary">
                <Calendar size={14} />
                End Date
              </label>
              <input
                type="date"
                value={customEndDate}
                onChange={(event) => setCustomEndDate(event.target.value)}
                className="h-11 w-full rounded border-border bg-surface-3 px-3 text-body-sm"
              />
            </div>
          </div>
        )}
      </FilterDisclosure>

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
