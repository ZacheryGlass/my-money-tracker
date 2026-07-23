import React, { useState, useEffect, useMemo } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
} from '@tanstack/react-table';
import { AnimatePresence, motion as Motion } from 'framer-motion';
import { ArrowLeft, Link2, Wallet, Receipt, X, Activity, PenLine } from 'lucide-react';
import { accounts as accountsAPI, holdings as holdingsAPI, history as historyApi, transactions as transactionsApi } from '../utils/api';
import { formatCurrency, formatDateDisplay } from '../utils/format';
import AccountHistoryChart from '../components/AccountHistoryChart';
import DataTable, { DataTablePagination } from '../components/DataTable';
import FilterTabs from '../components/FilterTabs';
import LoadingState from '../components/LoadingState';
import SummaryStats from '../components/SummaryStats';
import { buildAccountDisplayNameMap, getAccountDisplayName, hasAccountDisplayName } from '../utils/accountDisplay';
import { formatCategoryLabel, formatTransactionCategory } from '../utils/dataLabels';

const TYPE_COLORS = {
  investment: 'bg-accent/10 text-accent border-accent/20',
  depository: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  credit: 'bg-loss/10 text-loss border-loss/20',
  loan: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
  crypto: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  property: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  other: 'bg-surface-3 text-secondary border-border',
};

const TypeBadge = ({ type }) => (
  <span className={`inline-flex items-center px-2 py-1 text-body-sm font-semibold uppercase border ${TYPE_COLORS[type] || TYPE_COLORS.other}`}>
    {type}
  </span>
);

const PlaidBadge = () => (
  <span
    className="inline-flex h-5 w-5 items-center justify-center bg-accent-muted text-accent border border-accent/20 shrink-0"
    title="Plaid-linked account"
    aria-label="Plaid-linked account"
  >
    <Link2 size={10} />
  </span>
);

const AccountConnectionPill = ({ account, compact = false }) => {
  const isLinked = Boolean(account.plaid_item_id);
  const className = isLinked
    ? 'border-accent/20 bg-accent-muted text-accent'
    : 'border-border bg-surface-3 text-tertiary';

  if (compact) {
    return (
      <span
        className={`inline-flex h-6 w-6 items-center justify-center rounded border ${className}`}
        title={isLinked ? 'Linked account' : 'Manual account'}
        aria-label={isLinked ? 'Linked account' : 'Manual account'}
      >
        {isLinked ? <Link2 size={13} /> : <PenLine size={13} />}
      </span>
    );
  }

  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${className}`}>
      {isLinked ? 'Linked' : 'Manual'}
    </span>
  );
};

const InactivePill = () => (
  <span className="inline-flex items-center rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-300">
    Inactive
  </span>
);

const AccountStatusPills = ({ account, inactive }) => (
  <div className="mt-1 flex flex-wrap items-center gap-1.5">
    <AccountConnectionPill account={account} />
    {inactive && <InactivePill />}
  </div>
);

const AccountsPage = () => {
  const [accounts, setAccounts] = useState([]);
  const [holdings, setHoldings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [typeFilter, setTypeFilterRaw] = useState('');
  const setTypeFilter = (v) => { setTypeFilterRaw(v); setPagination(prev => ({ ...prev, pageIndex: 0 })); };
  const [showInactive, setShowInactive] = useState(false);
  const [sorting, setSorting] = useState([{ id: 'total_value', desc: true }]);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 });

  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const [accountHistory, setAccountHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [detailSorting, setDetailSorting] = useState([]);
  const [detailPagination, setDetailPagination] = useState({ pageIndex: 0, pageSize: 25 });
  const [accountTransactions, setAccountTransactions] = useState([]);
  const [txnLoading, setTxnLoading] = useState(false);
  const [txnSorting, setTxnSorting] = useState([]);
  const [txnPagination, setTxnPagination] = useState({ pageIndex: 0, pageSize: 25 });

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const [accountsData, holdingsData] = await Promise.all([
          accountsAPI.getAll(),
          holdingsAPI.getAll(),
        ]);
        setAccounts(accountsData.accounts || []);
        setHoldings(holdingsData.holdings || []);
        setError(null);
      } catch (err) {
        setError(err.response?.data?.error || 'Failed to load data');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  useEffect(() => {
    if (!selectedAccountId) {
      setAccountHistory([]);
      setAccountTransactions([]);
      return;
    }
    const fetchHistory = async () => {
      setHistoryLoading(true);
      setHistoryError(null);
      try {
        const result = await historyApi.getAccounts({
          account_id: selectedAccountId,
          limit: 365,
          withCount: false,
        });
        setAccountHistory(result.data || []);
      } catch {
        setHistoryError('Failed to load account history');
      } finally {
        setHistoryLoading(false);
      }
    };
    const fetchTransactions = async () => {
      setTxnLoading(true);
      try {
        const result = await transactionsApi.getAll({
          account_id: selectedAccountId,
          limit: 500,
        });
        setAccountTransactions(result.data || []);
      } catch (err) {
        console.error('Error fetching transactions:', err);
      } finally {
        setTxnLoading(false);
      }
    };
    fetchHistory();
    fetchTransactions();
  }, [selectedAccountId]);

  const accountTotals = useMemo(() => {
    const totals = new Map();
    holdings.forEach((h) => {
      const current = totals.get(h.account_id) || 0;
      totals.set(h.account_id, current + (parseFloat(h.current_value) || 0));
    });
    return totals;
  }, [holdings]);

  const accountDisplayNames = useMemo(() => buildAccountDisplayNameMap(accounts), [accounts]);
  const displayAccountName = useMemo(
    () => (account) => accountDisplayNames.get(account.id) || getAccountDisplayName(account),
    [accountDisplayNames]
  );

  const inactiveAccounts = useMemo(() => {
    return accounts.filter((account) =>
      (account.holdings_count || 0) === 0 && Math.abs(accountTotals.get(account.id) || 0) < 1
    );
  }, [accounts, accountTotals]);

  const inactiveAccountIds = useMemo(() => new Set(inactiveAccounts.map((account) => account.id)), [inactiveAccounts]);

  const activeAccountCount = accounts.length - inactiveAccounts.length;

  const distinctTypes = useMemo(() => {
    const types = new Set(accounts.map((a) => a.type));
    return [...types].sort();
  }, [accounts]);

  const filteredAccounts = useMemo(() => {
    let filtered = typeFilter ? accounts.filter((a) => a.type === typeFilter) : accounts;
    if (!showInactive) filtered = filtered.filter((a) => !inactiveAccountIds.has(a.id));
    return [...filtered].sort((a, b) => (accountTotals.get(b.id) || 0) - (accountTotals.get(a.id) || 0));
  }, [accounts, accountTotals, inactiveAccountIds, showInactive, typeFilter]);

  const grandTotal = useMemo(() => {
    return holdings.reduce((sum, h) => sum + (parseFloat(h.current_value) || 0), 0);
  }, [holdings]);

  const plaidCount = useMemo(() => {
    return accounts.filter((a) => a.plaid_item_id).length;
  }, [accounts]);

  const selectedAccount = useMemo(() => {
    if (!selectedAccountId) return null;
    return accounts.find((a) => a.id === selectedAccountId);
  }, [selectedAccountId, accounts]);

  const accountHoldings = useMemo(() => {
    if (!selectedAccountId) return [];
    return holdings.filter((h) => h.account_id === selectedAccountId);
  }, [holdings, selectedAccountId]);

  const accountTotal = useMemo(() => {
    return accountHoldings.reduce((sum, h) => sum + (parseFloat(h.current_value) || 0), 0);
  }, [accountHoldings]);

  // List view columns
  const listColumns = useMemo(
    () => [
      {
        id: 'connection',
        header: '',
        cell: ({ row }) => <AccountConnectionPill account={row.original} compact />,
        meta: {
          width: '32px',
          headerClassName: 'w-[32px] !px-1',
          cellClassName: 'w-[32px] !px-1 whitespace-nowrap',
        },
      },
      {
        id: 'name',
        accessorFn: (row) => displayAccountName(row),
        header: 'Name',
        cell: ({ row }) => {
          const accountName = displayAccountName(row.original);
          return (
            <div className="min-w-0">
              <span className="block truncate text-base font-bold text-primary" title={accountName}>
                {accountName}
              </span>
              {hasAccountDisplayName(row.original) && (
                <span className="block truncate text-[10px] uppercase tracking-tight text-tertiary" title={row.original.name}>
                  {row.original.name}
                </span>
              )}
              {inactiveAccountIds.has(row.original.id) && (
                <div className="mt-1"><InactivePill /></div>
              )}
            </div>
          );
        },
        meta: {
          cellClassName: 'min-w-0',
        },
      },
      {
        accessorKey: 'type',
        header: 'Type',
        cell: ({ getValue }) => <TypeBadge type={getValue()} />,
        meta: {
          width: '160px',
          headerClassName: 'w-[160px]',
          cellClassName: 'w-[160px] whitespace-nowrap',
        },
      },
      {
        id: 'holdings_count',
        accessorFn: (row) => row.holdings_count || 0,
        header: 'Assets',
        cell: ({ getValue }) => <span className="block text-right font-money text-display-sm font-semibold text-secondary">{getValue()}</span>,
        meta: {
          width: '100px',
          align: 'right',
          headerClassName: 'w-[100px]',
          cellClassName: 'w-[100px] whitespace-nowrap',
        },
      },
      {
        id: 'total_value',
        accessorFn: (row) => accountTotals.get(row.id) || 0,
        header: 'Total Value',
        cell: ({ getValue }) => {
          const v = getValue();
          return (
            <span className={`block text-right value-emphasis ${v < 0 ? 'text-loss' : 'text-gain'}`}>
              {formatCurrency(v)}
            </span>
          );
        },
        meta: {
          width: '180px',
          align: 'right',
          headerClassName: 'w-[180px]',
          cellClassName: 'w-[180px] whitespace-nowrap',
        },
      },
    ],
    [accountTotals, displayAccountName, inactiveAccountIds]
  );

  const listTable = useReactTable({
    data: filteredAccounts,
    columns: listColumns,
    state: { sorting, pagination },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  // Detail view columns
  const detailColumns = useMemo(
    () => [
      {
        accessorKey: 'ticker',
        header: 'Ticker',
        cell: ({ getValue }) => (
          <span className="font-mono text-sm font-bold text-accent">{getValue() || '—'}</span>
        ),
      },
      {
        accessorKey: 'name',
        header: 'Asset Name',
        cell: ({ row }) => (
          <div className="flex items-center gap-3">
            <span className="font-medium text-base">{row.original.name}</span>
            {row.original.is_plaid_managed && <PlaidBadge />}
          </div>
        ),
      },
      {
        id: 'value',
        accessorFn: (row) => parseFloat(row.current_value) || parseFloat(row.manual_value) || 0,
        header: 'Value',
        cell: ({ getValue }) => {
          const v = getValue();
          return (
            <span className={`value-emphasis ${v < 0 ? 'text-loss' : 'text-primary'}`}>
              {formatCurrency(v)}
            </span>
          );
        },
      },
      {
        accessorKey: 'category',
        header: 'Category',
        cell: ({ getValue }) => <span className="text-xs font-bold uppercase text-tertiary tracking-wider">{formatCategoryLabel(getValue())}</span>,
      },
    ],
    []
  );

  const detailTable = useReactTable({
    data: accountHoldings,
    columns: detailColumns,
    state: { sorting: detailSorting, pagination: detailPagination },
    onSortingChange: setDetailSorting,
    onPaginationChange: setDetailPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  const txnColumns = useMemo(
    () => [
      {
        accessorKey: 'date',
        header: 'Date',
        cell: ({ getValue }) => (
          <span className="font-mono text-sm text-secondary">{formatDateDisplay(getValue())}</span>
        ),
      },
      {
        id: 'description',
        accessorFn: (row) => row.merchant_name || row.name,
        header: 'Description',
        cell: ({ row }) => (
          <div className="min-w-0 py-2">
            <div className="text-base font-bold text-primary truncate">{row.original.merchant_name || row.original.name}</div>
            {row.original.merchant_name && row.original.merchant_name !== row.original.name && (
              <div className="text-xs text-tertiary truncate leading-tight uppercase font-semibold mt-0.5">{row.original.name}</div>
            )}
          </div>
        ),
      },
      {
        accessorKey: 'category',
        header: 'Category',
        cell: ({ getValue }) => (
          <span className="text-xs font-bold uppercase text-secondary tracking-tight">{formatTransactionCategory(getValue())}</span>
        ),
      },
      {
        accessorKey: 'amount',
        header: 'Amount',
        cell: ({ getValue }) => {
          const v = parseFloat(getValue());
          return (
            <span className={`font-mono text-base font-bold ${v > 0 ? 'text-loss' : 'text-gain'}`}>
              {v > 0 ? '—' : '+'}{formatCurrency(Math.abs(v))}
            </span>
          );
        },
      },
      {
        accessorKey: 'pending',
        header: 'Status',
        cell: ({ getValue }) => (
          getValue() ? (
            <span className="inline-flex items-center px-2.5 py-1 text-xs font-bold uppercase tracking-wider rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
              Pending
            </span>
          ) : (
            <span className="text-xs font-bold uppercase text-tertiary tracking-wide opacity-60">Posted</span>
          )
        ),
      },
    ],
    []
  );

  const txnTable = useReactTable({
    data: accountTransactions,
    columns: txnColumns,
    state: { sorting: txnSorting, pagination: txnPagination },
    onSortingChange: setTxnSorting,
    onPaginationChange: setTxnPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  if (loading) {
    return <LoadingState label="Loading Accounts" />;
  }

  const renderListView = () => (
    <Motion.div key="list" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-0.5 text-caption uppercase tracking-wide text-tertiary">Accounts</p>
          <h1 className="font-money text-display-lg text-primary">
            {formatCurrency(grandTotal)}
          </h1>
          <p className="text-body-sm text-tertiary">Aggregate balance across {activeAccountCount} active accounts</p>
        </div>

        <SummaryStats stats={[
          { label: 'Active', value: activeAccountCount },
          { label: 'Linked', value: plaidCount, valueClassName: 'font-money font-semibold text-accent' },
        ]} />
      </div>

      {error && (
        <div className="mb-3 flex items-center gap-2 border border-loss/20 bg-loss-bg p-2 text-body-sm text-loss">
          <X size={16} />
          {error}
        </div>
      )}

      <FilterTabs
        id="account-type-filter"
        label="Type"
        className="mb-3"
        options={[{ value: '', label: 'All' }, ...distinctTypes.map((type) => ({ value: type, label: type }))]}
        value={typeFilter}
        onChange={setTypeFilter}
        actions={inactiveAccounts.length > 0 && (
          <button
            onClick={() => {
              setShowInactive((value) => !value);
              setPagination((prev) => ({ ...prev, pageIndex: 0 }));
            }}
            title="Zero-balance accounts with no assets are kept out of the list until shown."
            className={`mb-1 shrink-0 rounded border px-2.5 py-1 text-caption font-semibold uppercase tracking-wide transition-colors ${
              showInactive
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                : 'border-border bg-surface-2 text-tertiary hover:text-primary'
            }`}
          >
            {showInactive ? 'Hide' : 'Show'} {inactiveAccounts.length} inactive
          </button>
        )}
      />

      <DataTable
        table={listTable}
        emptyMessage="No accounts match the selected filters."
        onRowClick={(account) => setSelectedAccountId(account.id)}
      />

      {/* Mobile cards */}
      <div className="space-y-3 lg:hidden">
        {filteredAccounts.map((account) => {
          const total = accountTotals.get(account.id) || 0;
          return (
            <div
              key={account.id}
              className="card p-4 active:bg-surface-3 cursor-pointer transition-all border border-border"
              onClick={() => setSelectedAccountId(account.id)}
            >
              <div className="flex justify-between items-start mb-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-bold text-primary truncate text-base">{displayAccountName(account)}</span>
                  </div>
                  {hasAccountDisplayName(account) && (
                    <div className="text-[10px] text-tertiary truncate uppercase tracking-tight mb-1">{account.name}</div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <TypeBadge type={account.type} />
                    <AccountStatusPills account={account} inactive={inactiveAccountIds.has(account.id)} />
                  </div>
                </div>
                <div className={`value-emphasis ${total < 0 ? 'text-loss' : 'text-primary'}`}>
                  {formatCurrency(total)}
                </div>
              </div>
              <div className="flex items-center gap-4 pt-3 border-t border-border text-tertiary">
                <span className="text-[10px] font-bold uppercase tracking-wide">{account.holdings_count || 0} Assets</span>
                <span className="text-[10px] font-bold uppercase tracking-wide">{account.type}</span>
              </div>
            </div>
          );
        })}
        {filteredAccounts.length === 0 && (
          <div className="p-8 text-center text-secondary text-sm">No accounts found</div>
        )}
      </div>

      <div className="hidden lg:block">
        <DataTablePagination table={listTable} total={filteredAccounts.length} />
      </div>
    </Motion.div>
  );

  const renderDetailView = () => {
    if (!selectedAccount) return null;

    return (
      <Motion.div
        key="detail"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        className="max-w-[1400px] mx-auto"
      >
        <button
          onClick={() => setSelectedAccountId(null)}
          className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wide text-tertiary hover:text-accent mb-8 transition-colors group"
        >
          <ArrowLeft size={14} className="group-hover:-translate-x-1 transition-transform" />
          <span>Back to Portfolio</span>
        </button>

        <div className="flex flex-col md:flex-row md:items-end justify-between mb-10 gap-6">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <TypeBadge type={selectedAccount.type} />
              {selectedAccount.plaid_item_id && <PlaidBadge />}
            </div>
            <h1 className="text-3xl md:text-5xl font-bold text-primary tracking-tighter leading-none mb-2">
              {displayAccountName(selectedAccount)}
            </h1>
            {hasAccountDisplayName(selectedAccount) && (
              <p className="text-xs text-tertiary font-medium uppercase tracking-wider mb-2">
                Source: {selectedAccount.name}
              </p>
            )}
            <p className="text-sm text-secondary font-mono tracking-tight opacity-70">
              Account ID: {selectedAccount.id} • {selectedAccount.type}
            </p>
          </div>

          <div className="flex items-center gap-4">
            <div className="p-5 bg-surface-2 border border-border rounded min-w-[180px]">
              <p className="text-[10px] font-bold text-tertiary uppercase tracking-wide mb-1">Account Value</p>
              <p className={`value-emphasis ${accountTotal < 0 ? 'text-loss' : 'text-gain'}`}>
                {formatCurrency(accountTotal)}
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-10">
          <div className="space-y-10">
            {/* Chart Section */}
            <section>
              <div className="flex items-center gap-2 mb-4">
                <Activity className="text-accent w-4 h-4" />
                <h2 className="text-xs font-bold uppercase tracking-wide text-secondary">Performance History</h2>
              </div>
              <AccountHistoryChart
                accountData={accountHistory}
                portfolioData={null}
                accounts={[selectedAccount]}
                selectedAccounts={[selectedAccountId]}
                showPortfolio={false}
                loading={historyLoading}
                error={historyError}
                singleColumn
              />
            </section>

            {/* Assets Table */}
            {accountHoldings.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-4">
                  <Wallet className="text-accent w-4 h-4" />
                  <h2 className="text-xs font-bold uppercase tracking-wide text-secondary">Underlying Assets ({accountHoldings.length})</h2>
                </div>
                <DataTable table={detailTable} emptyMessage="No holdings found." />
                
                {/* Mobile Asset Cards */}
                <div className="lg:hidden space-y-3">
                  {accountHoldings.map((holding) => {
                    const value = parseFloat(holding.current_value) || parseFloat(holding.manual_value) || 0;
                    return (
                      <div key={holding.id} className="card p-4 border border-border">
                        <div className="flex justify-between items-start mb-2">
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-bold text-primary truncate">{holding.name}</div>
                            <div className="text-[10px] font-mono text-accent uppercase">{holding.ticker || 'N/A'}</div>
                          </div>
                          <div className={`text-base font-mono font-bold ${value < 0 ? 'text-loss' : 'text-primary'}`}>
                            {formatCurrency(value)}
                          </div>
                        </div>
                        <div className="flex items-center gap-3 pt-2 border-t border-border">
                          <span className="text-[9px] font-bold uppercase tracking-wide text-tertiary">{formatCategoryLabel(holding.category)}</span>
                          {holding.is_plaid_managed && <PlaidBadge />}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="hidden lg:block">
                  <DataTablePagination table={detailTable} total={accountHoldings.length} />
                </div>
              </section>
            )}
          </div>

          <div className="space-y-10">
            {/* Transactions Section */}
            <section>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Receipt className="text-accent w-4 h-4" />
                  <h2 className="text-xs font-bold uppercase tracking-wide text-secondary">Recent Activity</h2>
                </div>
                {accountTransactions.length > 0 && (
                  <span className="text-[10px] font-bold text-accent px-2 py-0.5 rounded bg-accent/10 border border-accent/20">
                    {accountTransactions.length} Total
                  </span>
                )}
              </div>
              
              <div className="space-y-3">
                {txnLoading ? (
                  <LoadingState label="Fetching transactions" className="py-12 card" />
                ) : accountTransactions.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 gap-2 card opacity-50">
                    <Receipt size={32} className="text-tertiary" />
                    <p className="text-[10px] font-bold uppercase tracking-wide text-tertiary">No recent transactions</p>
                  </div>
                ) : (
                  <>
                    <div className="hidden lg:block">
                      <DataTable table={txnTable} emptyMessage="No transactions found." />
                      <DataTablePagination table={txnTable} total={accountTransactions.length} />
                    </div>

                    {/* Mobile Only Cards */}
                    <div className="lg:hidden space-y-2">
                       {accountTransactions.map((txn) => {
                        const amount = parseFloat(txn.amount);
                        return (
                          <div key={txn.id} className="p-4 bg-surface-2 border border-border rounded flex items-center justify-between gap-4">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-bold text-primary truncate">{txn.merchant_name || txn.name}</p>
                              <div className="flex items-center gap-2 mt-1">
                                <span className="text-[10px] text-tertiary font-mono">{formatDateDisplay(txn.date)}</span>
                                {txn.pending && <span className="text-[9px] font-bold uppercase text-amber-500">Pending</span>}
                              </div>
                            </div>
                            <div className={`text-base font-mono font-bold ${amount > 0 ? 'text-loss' : 'text-gain'}`}>
                              {amount > 0 ? '—' : '+'}{formatCurrency(Math.abs(amount))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            </section>
          </div>
        </div>
      </Motion.div>
    );
  };

  return (
    <div className="mx-auto w-full max-w-[1240px] px-3 py-6 sm:px-4 md:py-8">
      <AnimatePresence mode="wait">
        {selectedAccountId === null ? renderListView() : renderDetailView()}
      </AnimatePresence>
    </div>
  );
};

export default AccountsPage;
