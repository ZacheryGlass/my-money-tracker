import React, { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from 'recharts';
import {
  Store, Tags, ReceiptText, Search, SlidersHorizontal, Calendar,
  CreditCard, DollarSign, Hash, X, ArrowDownWideNarrow,
} from 'lucide-react';
import MetricCard from '../components/MetricCard';
import ChartTooltip from '../components/ChartTooltip';
import ResponsiveContainer from '../components/ResponsiveContainer';
import { CHART_COLORS, GRID_STYLE, AXIS_STYLE } from '../utils/chartTheme';
import { formatCurrency, formatCompactCurrency, formatDateDisplay, formatPercent } from '../utils/format';
import { accounts as accountsApi, transactions as transactionsApi } from '../utils/api';
import { useIsMobile } from '../hooks/useMediaQuery';
import useDebouncedValue from '../hooks/useDebouncedValue';
import { getAccountDisplayName } from '../utils/accountDisplay';
import { classifyTransaction, getSpend } from '../utils/transactionClassification';

const DATE_RANGES = [
  { id: '30d', label: '30D', days: 30 },
  { id: '90d', label: '90D', days: 90 },
  { id: '6m', label: '6M', days: 180 },
  { id: '1y', label: '1Y', days: 365 },
  { id: 'ytd', label: 'YTD', days: null },
  { id: 'all', label: 'All', days: null },
];

const GROUP_MODES = [
  { id: 'merchant', label: 'Stores', icon: Store },
  { id: 'kind', label: 'Kinds', icon: SlidersHorizontal },
  { id: 'category', label: 'Categories', icon: Tags },
];

const SCOPE_OPTIONS = [
  { id: 'everyday', label: 'Everyday' },
  { id: 'all', label: 'All Outflows' },
];

const SORT_OPTIONS = [
  { id: 'spend', label: 'Spend' },
  { id: 'count', label: 'Trips' },
  { id: 'avg', label: 'Avg' },
];

function getDateRange(rangeId) {
  const end = new Date();
  if (rangeId === 'ytd') {
    return {
      startDate: `${end.getFullYear()}-01-01`,
      endDate: end.toISOString().slice(0, 10),
    };
  }

  const range = DATE_RANGES.find((r) => r.id === rangeId);
  if (!range || !range.days) return {};

  const start = new Date();
  start.setDate(start.getDate() - range.days);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function sortGroups(groups, sortBy) {
  const sorted = [...groups];
  if (sortBy === 'count') {
    return sorted.sort((a, b) => b.count - a.count || b.total - a.total);
  }
  if (sortBy === 'avg') {
    return sorted.sort((a, b) => b.avg - a.avg || b.total - a.total);
  }
  return sorted.sort((a, b) => b.total - a.total || b.count - a.count);
}

function aggregateGroups(rows, getKey) {
  const map = new Map();

  rows.forEach((txn) => {
    const key = getKey(txn);
    const existing = map.get(key) || {
      name: key,
      total: 0,
      count: 0,
      avg: 0,
      lastDate: null,
      merchants: new Set(),
      categories: new Map(),
    };

    existing.total += txn.spend;
    existing.count += 1;
    existing.lastDate = !existing.lastDate || txn.date > existing.lastDate ? txn.date : existing.lastDate;
    existing.merchants.add(txn.merchantLabel);
    existing.categories.set(txn.categoryLabel, (existing.categories.get(txn.categoryLabel) || 0) + txn.spend);
    map.set(key, existing);
  });

  return Array.from(map.values()).map((group) => {
    const topCategory = Array.from(group.categories.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Uncategorized';
    return {
      name: group.name,
      total: Math.round(group.total * 100) / 100,
      count: group.count,
      avg: group.count > 0 ? Math.round((group.total / group.count) * 100) / 100 : 0,
      lastDate: group.lastDate,
      merchantCount: group.merchants.size,
      topCategory,
    };
  });
}

export default function SpendingExplorer({ embedded = false }) {
  const isMobile = useIsMobile();
  const [dateRange, setDateRange] = useState('90d');
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [groupMode, setGroupMode] = useState('merchant');
  const [spendScope, setSpendScope] = useState('everyday');
  const [sortBy, setSortBy] = useState('spend');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedKind, setSelectedKind] = useState('');
  const [selectedMerchant, setSelectedMerchant] = useState('');
  const [rawTransactions, setRawTransactions] = useState([]);
  const [accountList, setAccountList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const debouncedSearch = useDebouncedValue(search, 200);

  useEffect(() => {
    let cancelled = false;
    const params = { ...getDateRange(dateRange), limit: 10000 };
    if (selectedAccountId) params.account_id = selectedAccountId;

    Promise.all([
      transactionsApi.getAll(params),
      accountsApi.getAll(),
    ])
      .then(([txnResult, acctResult]) => {
        if (cancelled) return;
        setRawTransactions(txnResult.data || []);
        setAccountList(acctResult.accounts || []);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to load spending explorer data:', err);
        setError(err.response?.data?.error || 'Failed to load transaction data');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [dateRange, selectedAccountId]);

  const accountOptions = useMemo(() => {
    const map = new Map();
    accountList.forEach((account) => {
      map.set(String(account.id), getAccountDisplayName(account));
    });
    rawTransactions.forEach((txn) => {
      if (txn.account_id) {
        map.set(String(txn.account_id), txn.account_name || `Account ${txn.account_id}`);
      }
    });
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [accountList, rawTransactions]);

  const selectedAccountName = useMemo(() => {
    return accountOptions.find((account) => account.id === selectedAccountId)?.name || '';
  }, [accountOptions, selectedAccountId]);

  const spendingRows = useMemo(() => {
    return rawTransactions
      .filter((txn) => !txn.pending && getSpend(txn) > 0)
      .map(classifyTransaction);
  }, [rawTransactions]);

  const scopeRows = useMemo(() => {
    if (spendScope === 'all') return spendingRows;
    return spendingRows.filter((txn) => txn.isEveryday);
  }, [spendingRows, spendScope]);

  const filteredRows = useMemo(() => {
    const query = debouncedSearch.trim().toLowerCase();
    return scopeRows.filter((txn) => {
      if (query && !txn.searchText.includes(query)) return false;
      if (selectedKind && txn.kindLabel !== selectedKind) return false;
      if (selectedCategory && txn.categoryLabel !== selectedCategory) return false;
      if (selectedMerchant && txn.merchantLabel !== selectedMerchant) return false;
      return true;
    });
  }, [scopeRows, debouncedSearch, selectedKind, selectedCategory, selectedMerchant]);

  const categoryOptions = useMemo(() => {
    return sortGroups(aggregateGroups(scopeRows, (txn) => txn.categoryLabel), 'spend');
  }, [scopeRows]);

  const kindOptions = useMemo(() => {
    return sortGroups(aggregateGroups(scopeRows, (txn) => txn.kindLabel), 'spend');
  }, [scopeRows]);

  const merchantGroups = useMemo(() => {
    return sortGroups(aggregateGroups(filteredRows, (txn) => txn.merchantLabel), sortBy);
  }, [filteredRows, sortBy]);

  const kindGroups = useMemo(() => {
    return sortGroups(aggregateGroups(filteredRows, (txn) => txn.kindLabel), sortBy);
  }, [filteredRows, sortBy]);

  const categoryGroups = useMemo(() => {
    return sortGroups(aggregateGroups(filteredRows, (txn) => txn.categoryLabel), sortBy);
  }, [filteredRows, sortBy]);

  const activeGroups = groupMode === 'merchant' ? merchantGroups : groupMode === 'kind' ? kindGroups : categoryGroups;
  const chartData = activeGroups.slice(0, isMobile ? 8 : 12);

  const summary = useMemo(() => {
    const total = filteredRows.reduce((sum, txn) => sum + txn.spend, 0);
    const excludedRows = spendingRows.filter((txn) => !txn.isEveryday);
    return {
      total,
      txCount: filteredRows.length,
      avgTx: filteredRows.length > 0 ? total / filteredRows.length : 0,
      excludedTotal: excludedRows.reduce((sum, txn) => sum + txn.spend, 0),
      excludedCount: excludedRows.length,
    };
  }, [filteredRows, spendingRows]);

  const visibleTransactions = useMemo(() => {
    return [...filteredRows]
      .sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.spend - a.spend)
      .slice(0, 150);
  }, [filteredRows]);

  const clearGroupFilters = () => {
    setSelectedCategory('');
    setSelectedKind('');
    setSelectedMerchant('');
  };

  const handleDateRangeChange = (rangeId) => {
    if (rangeId === dateRange) return;
    setLoading(true);
    setError(null);
    setDateRange(rangeId);
  };

  const handleAccountChange = (accountId) => {
    if (accountId === selectedAccountId) return;
    setLoading(true);
    setError(null);
    setSelectedAccountId(accountId);
  };

  const clearAllFilters = () => {
    setSearch('');
    clearGroupFilters();
    if (selectedAccountId) handleAccountChange('');
  };

  const handleScopeChange = (scope) => {
    if (scope === spendScope) return;
    clearGroupFilters();
    setSpendScope(scope);
  };

  const applyGroupFilter = (group) => {
    if (groupMode === 'merchant') {
      setSelectedMerchant((current) => current === group.name ? '' : group.name);
    } else if (groupMode === 'kind') {
      setSelectedKind((current) => current === group.name ? '' : group.name);
    } else {
      setSelectedCategory((current) => current === group.name ? '' : group.name);
    }
  };

  const activeGroupLabel = groupMode === 'merchant' ? 'Store' : groupMode === 'kind' ? 'Kind' : 'Category';
  const topGroup = activeGroups[0];
  const ActiveGroupIcon = groupMode === 'merchant' ? Store : groupMode === 'kind' ? SlidersHorizontal : Tags;
  const activeFilterCount = [search.trim(), selectedAccountId, selectedCategory, selectedKind, selectedMerchant].filter(Boolean).length;

  if (loading) {
    return (
      <div className={`flex flex-col items-center justify-center gap-4 ${embedded ? 'min-h-[260px]' : 'min-h-[400px]'}`}>
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        <span className="text-xs font-bold tracking-wide uppercase text-tertiary ">Sorting Transactions</span>
      </div>
    );
  }

  return (
    <div className={embedded ? 'space-y-6' : 'container mx-auto px-4 py-6 md:py-8 max-w-[1600px] space-y-8'}>
      <div className={`${embedded ? 'card p-3 md:p-4 xl:items-center' : 'xl:items-end'} flex flex-col xl:flex-row justify-between gap-5`}>
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Store className="w-5 h-5 text-accent" />
            <span className="text-[10px] font-bold uppercase tracking-wide text-secondary">
              {embedded ? 'Explorer Controls' : 'Transaction Intelligence'}
            </span>
          </div>
          {!embedded && (
            <h1 className="text-3xl md:text-5xl font-bold text-primary tracking-tighter">Spending Explorer</h1>
          )}
          <p className="text-sm text-secondary mt-1">
            Stores, categories, and transaction-level spend
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <div className="flex bg-surface-2 rounded border border-border p-1 gap-1">
            {SCOPE_OPTIONS.map((scope) => (
              <button
                key={scope.id}
                onClick={() => handleScopeChange(scope.id)}
                className={`px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wider transition-all ${
                  spendScope === scope.id ? 'bg-accent/15 text-accent' : 'text-tertiary hover:text-secondary'
                }`}
              >
                {scope.label}
              </button>
            ))}
          </div>

          <div className="flex bg-surface-2 rounded border border-border p-1 gap-1">
            {DATE_RANGES.map((range) => (
              <button
                key={range.id}
                onClick={() => handleDateRangeChange(range.id)}
                className={`px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wider transition-all ${
                  dateRange === range.id ? 'bg-accent/15 text-accent' : 'text-tertiary hover:text-secondary'
                }`}
              >
                {range.label}
              </button>
            ))}
          </div>

          <div className="flex bg-surface-2 rounded border border-border p-1 gap-1">
            {GROUP_MODES.map((mode) => {
              const Icon = mode.icon;
              return (
                <button
                  key={mode.id}
                  onClick={() => setGroupMode(mode.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wider transition-all ${
                    groupMode === mode.id ? 'bg-accent/15 text-accent' : 'text-tertiary hover:text-secondary'
                  }`}
                >
                  <Icon size={14} />
                  {mode.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {error && (
        <div className="card p-4 border-loss/30 bg-loss-bg text-loss text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <MetricCard label="Filtered Spend" value={formatCurrency(summary.total)} icon={DollarSign} valueColor="loss" />
        <MetricCard label="Transactions" value={summary.txCount.toLocaleString()} icon={ReceiptText} />
        <MetricCard label="Average Swipe" value={formatCurrency(summary.avgTx)} icon={CreditCard} />
        <MetricCard
          label={`Top ${activeGroupLabel}`}
          value={topGroup?.name || '--'}
          change={formatCurrency(topGroup?.total || 0)}
          icon={ActiveGroupIcon}
          valueColor="accent"
        />
      </div>

      <div className="card p-4">
        <div className="grid gap-3 lg:grid-cols-[minmax(260px,1fr)_220px_auto_auto] lg:items-end">
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wide text-tertiary mb-2 flex items-center gap-2">
              <Search size={13} />
              Search
            </label>
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-tertiary" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Merchant, category, account"
                className="w-full h-11 pl-10 pr-10 bg-surface-2 border border-border rounded text-sm"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-tertiary hover:text-primary"
                  aria-label="Clear search"
                >
                  <X size={16} />
                </button>
              )}
            </div>
          </div>

          <div>
            <label className="text-[10px] font-bold uppercase tracking-wide text-tertiary mb-2 flex items-center gap-2">
              <Calendar size={13} />
              Account
            </label>
            <select
              value={selectedAccountId}
              onChange={(e) => handleAccountChange(e.target.value)}
              className="w-full h-11 px-3 bg-surface-2 border border-border rounded text-sm"
            >
              <option value="">All accounts</option>
              {accountOptions.map((account) => (
                <option key={account.id} value={account.id}>{account.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[10px] font-bold uppercase tracking-wide text-tertiary mb-2 flex items-center gap-2">
              <ArrowDownWideNarrow size={13} />
              Sort
            </label>
            <div className="flex bg-surface-2 rounded border border-border p-1 gap-1 h-11">
              {SORT_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  onClick={() => setSortBy(option.id)}
                  className={`px-3 rounded text-xs font-bold uppercase tracking-wider transition-all ${
                    sortBy === option.id ? 'bg-accent/15 text-accent' : 'text-tertiary hover:text-secondary'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={() => setFiltersOpen((open) => !open)}
            className={`flex h-11 items-center justify-center gap-2 rounded border px-4 text-xs font-bold uppercase tracking-wider transition-all ${
              filtersOpen || activeFilterCount > 0
                ? 'border-accent/30 bg-accent/10 text-accent'
                : 'border-border bg-surface-2 text-tertiary hover:text-secondary'
            }`}
          >
            <SlidersHorizontal size={14} />
            {filtersOpen ? 'Hide Filters' : 'More Filters'}
            {activeFilterCount > 0 && (
              <span className="rounded bg-accent/20 px-1.5 py-0.5 font-mono text-[10px]">{activeFilterCount}</span>
            )}
          </button>
        </div>

        {(activeFilterCount > 0 || (spendScope === 'everyday' && summary.excludedCount > 0)) && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {search.trim() && (
              <button
                onClick={() => setSearch('')}
                className="inline-flex max-w-[260px] items-center gap-2 rounded border border-accent/20 bg-accent/10 px-3 py-1.5 text-xs font-bold text-accent"
                title={search.trim()}
              >
                <Search size={13} />
                <span className="truncate">Search: {search.trim()}</span>
                <X size={13} />
              </button>
            )}
            {selectedAccountId && (
              <button
                onClick={() => handleAccountChange('')}
                className="inline-flex max-w-[260px] items-center gap-2 rounded border border-accent/20 bg-accent/10 px-3 py-1.5 text-xs font-bold text-accent"
                title={selectedAccountName}
              >
                <CreditCard size={13} />
                <span className="truncate">{selectedAccountName}</span>
                <X size={13} />
              </button>
            )}
            {selectedMerchant && (
              <button
                onClick={() => setSelectedMerchant('')}
                className="inline-flex max-w-[260px] items-center gap-2 rounded border border-accent/20 bg-accent/10 px-3 py-1.5 text-xs font-bold text-accent"
                title={selectedMerchant}
              >
                <Store size={13} />
                <span className="truncate">{selectedMerchant}</span>
                <X size={13} />
              </button>
            )}
            {selectedKind && (
              <button
                onClick={() => setSelectedKind('')}
                className="inline-flex max-w-[260px] items-center gap-2 rounded border border-accent/20 bg-accent/10 px-3 py-1.5 text-xs font-bold text-accent"
                title={selectedKind}
              >
                <SlidersHorizontal size={13} />
                <span className="truncate">{selectedKind}</span>
                <X size={13} />
              </button>
            )}
            {selectedCategory && (
              <button
                onClick={() => setSelectedCategory('')}
                className="inline-flex max-w-[260px] items-center gap-2 rounded border border-accent/20 bg-accent/10 px-3 py-1.5 text-xs font-bold text-accent"
                title={selectedCategory}
              >
                <Tags size={13} />
                <span className="truncate">{selectedCategory}</span>
                <X size={13} />
              </button>
            )}
            {activeFilterCount > 0 && (
              <button
                onClick={clearAllFilters}
                className="inline-flex items-center gap-1.5 rounded border border-border bg-surface-2 px-3 py-1.5 text-xs font-bold text-tertiary transition-colors hover:text-primary"
              >
                <X size={13} />
                Clear all
              </button>
            )}
            {spendScope === 'everyday' && summary.excludedCount > 0 && (
              <span className="inline-flex items-center gap-2 rounded border border-border bg-surface-2/60 px-3 py-1.5 text-xs text-tertiary">
                Hidden non-purchase outflows: <span className="font-money text-primary">{formatCurrency(summary.excludedTotal)}</span>
              </span>
            )}
          </div>
        )}

        {filtersOpen && (
          <div className="mt-4 space-y-4 border-t border-border pt-4">
            <div>
              <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-tertiary">Kinds</div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setSelectedKind('')}
                  className={`px-3 py-1.5 rounded text-[10px] font-bold uppercase tracking-wide border transition-all ${
                    selectedKind === '' ? 'bg-accent/15 text-accent border-accent/30' : 'bg-surface-2 text-tertiary border-border hover:text-secondary'
                  }`}
                >
                  All Kinds
                </button>
                {kindOptions.slice(0, 10).map((kind) => (
                  <button
                    key={kind.name}
                    onClick={() => setSelectedKind(kind.name)}
                    className={`px-3 py-1.5 rounded text-[10px] font-bold uppercase tracking-wide border transition-all ${
                      selectedKind === kind.name ? 'bg-accent/15 text-accent border-accent/30' : 'bg-surface-2 text-tertiary border-border hover:text-secondary'
                    }`}
                  >
                    {kind.name}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-tertiary">Categories</div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setSelectedCategory('')}
                  className={`px-3 py-1.5 rounded text-[10px] font-bold uppercase tracking-wide border transition-all ${
                    selectedCategory === '' ? 'bg-accent/15 text-accent border-accent/30' : 'bg-surface-2 text-tertiary border-border hover:text-secondary'
                  }`}
                >
                  All Categories
                </button>
                {categoryOptions.slice(0, 12).map((category) => (
                  <button
                    key={category.name}
                    onClick={() => setSelectedCategory(category.name)}
                    className={`px-3 py-1.5 rounded text-[10px] font-bold uppercase tracking-wide border transition-all ${
                      selectedCategory === category.name ? 'bg-accent/15 text-accent border-accent/30' : 'bg-surface-2 text-tertiary border-border hover:text-secondary'
                    }`}
                  >
                    {category.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="grid xl:grid-cols-[1.35fr_0.65fr] gap-6">
        <div className="card p-4 md:p-6">
          <div className="flex items-center justify-between gap-4 mb-4">
            <h2 className="text-[10px] font-bold tracking-wide uppercase text-tertiary">
              {groupMode === 'merchant' ? 'Top Stores' : groupMode === 'kind' ? 'Top Kinds' : 'Top Categories'}
            </h2>
            <span className="text-[10px] font-bold uppercase tracking-wide text-tertiary">
              {activeGroups.length} Groups
            </span>
          </div>

          <div style={{ height: isMobile ? 320 : 470 }}>
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  layout="vertical"
                  margin={{ top: 5, right: 25, left: isMobile ? 68 : 130, bottom: 5 }}
                >
                  <CartesianGrid {...GRID_STYLE} horizontal={false} />
                  <XAxis type="number" {...AXIS_STYLE} tickFormatter={formatCompactCurrency} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    {...AXIS_STYLE}
                    width={isMobile ? 65 : 125}
                    tickFormatter={(value) => String(value).length > (isMobile ? 10 : 18) ? `${String(value).slice(0, isMobile ? 10 : 18)}...` : value}
                  />
                  <Tooltip content={<ChartTooltip formatValue={(value) => formatCurrency(value)} />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                  <Bar dataKey="total" name="Spend" radius={[0, 4, 4, 0]} animationDuration={800}>
                    {chartData.map((_, index) => (
                      <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-tertiary text-sm">No spending data for these filters</div>
            )}
          </div>
        </div>

        <div className="card overflow-hidden">
          <div className="p-4 border-b border-border  flex items-center justify-between">
            <div className="flex items-center gap-2">
              <SlidersHorizontal size={15} className="text-accent" />
              <span className="text-[10px] font-bold tracking-wide uppercase text-tertiary">
                Ranked
              </span>
            </div>
            <span className="text-[10px] font-bold text-secondary uppercase">{sortBy}</span>
          </div>

          <div className="divide-y divide-border max-h-[520px] overflow-y-auto">
            {activeGroups.slice(0, 25).map((group, index) => {
              const share = summary.total > 0 ? (group.total / summary.total) * 100 : 0;
              const active = selectedMerchant === group.name || selectedKind === group.name || selectedCategory === group.name;
              return (
                <button
                  key={group.name}
                  onClick={() => applyGroupFilter(group)}
                  className={`w-full text-left p-4 hover:bg-surface-2 transition-colors ${active ? 'bg-accent/5' : ''}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-money text-tertiary w-5">{index + 1}</span>
                        <span className="truncate text-sm font-bold text-primary" title={group.name}>{group.name}</span>
                      </div>
                      <div className="mt-1 text-[10px] uppercase tracking-wider text-tertiary">
                        {group.count} txns - {formatCurrency(group.avg)} avg
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-money font-bold text-primary">{formatCurrency(group.total)}</div>
                      <div className="text-[10px] text-tertiary">{formatPercent(share, 1, { sign: false })}</div>
                    </div>
                  </div>
                  <div className="mt-3 h-1.5 rounded-full bg-surface-3 overflow-hidden">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(share, 100)}%` }} />
                  </div>
                  <div className="mt-2 text-[10px] text-secondary truncate">
                    {groupMode === 'merchant' ? `${group.topCategory} - ${group.count} txns` : `${group.merchantCount} stores`}
                  </div>
                </button>
              );
            })}
            {activeGroups.length === 0 && (
              <div className="p-10 text-center text-tertiary text-sm">No groups to rank</div>
            )}
          </div>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="p-4 border-b border-border  flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ReceiptText size={15} className="text-accent" />
            <span className="text-[10px] font-bold tracking-wide uppercase text-tertiary">Filtered Transactions</span>
          </div>
          <span className="text-[10px] font-bold uppercase tracking-wide text-tertiary">
            Showing {visibleTransactions.length.toLocaleString()} of {filteredRows.length.toLocaleString()}
          </span>
        </div>

        <div className="hidden max-w-full overflow-hidden xl:block">
          <table className="w-full table-fixed divide-y divide-border">
            <thead className="bg-surface-2">
              <tr>
                {['Date', 'Store', 'Kind / Category', 'Account', 'Amount'].map((header) => (
                  <th key={header} className="px-5 py-4 text-left text-[10px] font-bold text-tertiary uppercase tracking-wide">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-surface">
              {visibleTransactions.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-12 text-center text-tertiary text-sm">
                    No transactions match these filters.
                  </td>
                </tr>
              ) : (
                visibleTransactions.map((txn) => (
                  <tr key={txn.id} className="hover:bg-surface-2 transition-colors">
                    <td className="px-5 py-3 whitespace-nowrap text-xs font-mono text-secondary">{formatDateDisplay(txn.date)}</td>
                    <td className="min-w-0 px-5 py-3">
                      <div className="text-sm font-bold text-primary truncate">{txn.merchantLabel}</div>
                      {txn.name && txn.name !== txn.merchantLabel && (
                        <div className="text-[10px] text-tertiary truncate uppercase">{txn.name}</div>
                      )}
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap">
                      <div className="flex flex-col gap-1">
                        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-accent/10 border border-accent/20 text-[10px] font-bold uppercase tracking-wider text-accent w-fit">
                          <SlidersHorizontal size={11} />
                          {txn.kindLabel}
                        </span>
                        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-surface-2 border border-border text-[10px] font-bold uppercase tracking-wider text-secondary w-fit">
                          <Tags size={11} />
                          {txn.categoryLabel}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap text-sm text-secondary">{txn.account_name || 'Account'}</td>
                    <td className="px-5 py-3 whitespace-nowrap text-sm font-money font-bold text-loss">
                      -{formatCurrency(txn.spend)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="divide-y divide-border xl:hidden">
          {visibleTransactions.length === 0 ? (
            <div className="p-10 text-center text-tertiary text-sm">No transactions match these filters.</div>
          ) : (
            visibleTransactions.map((txn) => (
              <div key={txn.id} className="p-4 bg-surface">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-primary truncate">{txn.merchantLabel}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider text-tertiary">
                      <span>{formatDateDisplay(txn.date)}</span>
                      <span>{txn.kindLabel}</span>
                      <span>{txn.categoryLabel}</span>
                    </div>
                  </div>
                  <div className="text-sm font-money font-bold text-loss shrink-0">-{formatCurrency(txn.spend)}</div>
                </div>
                <div className="mt-2 text-[10px] text-secondary truncate">{txn.account_name || 'Account'}</div>
              </div>
            ))
          )}
        </div>
      </div>

      {filteredRows.length > 0 && (
        <div className="grid md:grid-cols-4 gap-4">
          <div className="card p-4">
            <div className="flex items-center gap-2 mb-2 text-accent">
              <Hash size={15} />
              <span className="text-[10px] font-bold uppercase tracking-wide">Store Count</span>
            </div>
            <div className="text-2xl font-money font-bold text-primary">{merchantGroups.length.toLocaleString()}</div>
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-2 mb-2 text-accent">
              <SlidersHorizontal size={15} />
              <span className="text-[10px] font-bold uppercase tracking-wide">Kind Count</span>
            </div>
            <div className="text-2xl font-money font-bold text-primary">{kindGroups.length.toLocaleString()}</div>
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-2 mb-2 text-accent">
              <Tags size={15} />
              <span className="text-[10px] font-bold uppercase tracking-wide">Category Count</span>
            </div>
            <div className="text-2xl font-money font-bold text-primary">{categoryGroups.length.toLocaleString()}</div>
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-2 mb-2 text-accent">
              <Store size={15} />
              <span className="text-[10px] font-bold uppercase tracking-wide">Top Share</span>
            </div>
            <div className="text-2xl font-money font-bold text-primary">
              {formatPercent(summary.total > 0 && activeGroups[0] ? (activeGroups[0].total / summary.total) * 100 : 0, 1, { sign: false })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
