import React, { useState, useEffect, useMemo } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  flexRender,
} from '@tanstack/react-table';
import { AnimatePresence, motion as Motion } from 'framer-motion';
import { ArrowLeft, Link2, Building2, Wallet, Filter, Receipt, X, Activity } from 'lucide-react';
import { accounts as accountsAPI, holdings as holdingsAPI, history as historyApi, transactions as transactionsApi } from '../utils/api';
import { formatCurrency, formatDateDisplay } from '../utils/format';
import AccountHistoryChart from '../components/AccountHistoryChart';
import { getAccountDisplayName, hasAccountDisplayName } from '../utils/accountDisplay';

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
  <span className={`inline-flex items-center px-2.5 py-1 text-xs font-bold uppercase tracking-wider rounded-full border ${TYPE_COLORS[type] || TYPE_COLORS.other}`}>
    {type}
  </span>
);

const PlaidBadge = () => (
  <span
    className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-accent/10 text-accent border border-accent/20 shrink-0"
    title="Plaid-linked account"
    aria-label="Plaid-linked account"
  >
    <Link2 size={12} />
  </span>
);

const AccountsPage = () => {
  const [accounts, setAccounts] = useState([]);
  const [holdings, setHoldings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [typeFilter, setTypeFilterRaw] = useState('');
  const setTypeFilter = (v) => { setTypeFilterRaw(v); setPagination(prev => ({ ...prev, pageIndex: 0 })); };
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

  const distinctTypes = useMemo(() => {
    const types = new Set(accounts.map((a) => a.type));
    return [...types].sort();
  }, [accounts]);

  const filteredAccounts = useMemo(() => {
    const filtered = typeFilter ? accounts.filter((a) => a.type === typeFilter) : accounts;
    return [...filtered].sort((a, b) => (accountTotals.get(b.id) || 0) - (accountTotals.get(a.id) || 0));
  }, [accounts, accountTotals, typeFilter]);

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
        id: 'name',
        accessorFn: (row) => getAccountDisplayName(row),
        header: 'Name',
        cell: ({ row }) => (
          <div className="flex items-center gap-3 min-w-0">
            <div className="min-w-0">
              <span className="font-bold text-primary text-base truncate block">{getAccountDisplayName(row.original)}</span>
              {hasAccountDisplayName(row.original) && (
                <span className="text-[10px] text-tertiary truncate block uppercase tracking-tight">{row.original.name}</span>
              )}
            </div>
            {row.original.plaid_item_id && <PlaidBadge />}
          </div>
        ),
      },
      {
        accessorKey: 'type',
        header: 'Type',
        cell: ({ getValue }) => <TypeBadge type={getValue()} />,
      },
      {
        id: 'holdings_count',
        accessorFn: (row) => row.holdings_count || 0,
        header: 'Assets',
        cell: ({ getValue }) => <span className="font-mono text-base text-secondary">{getValue()}</span>,
      },
      {
        id: 'total_value',
        accessorFn: (row) => accountTotals.get(row.id) || 0,
        header: 'Total Value',
        cell: ({ getValue }) => {
          const v = getValue();
          return (
            <span className={`font-money text-base font-bold ${v < 0 ? 'text-loss' : 'text-primary'}`}>
              {formatCurrency(v)}
            </span>
          );
        },
      },
    ],
    [accountTotals]
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
            <span className={`font-money text-base font-bold ${v < 0 ? 'text-loss' : 'text-primary'}`}>
              {formatCurrency(v)}
            </span>
          );
        },
      },
      {
        accessorKey: 'category',
        header: 'Category',
        cell: ({ getValue }) => <span className="text-xs font-bold uppercase text-tertiary tracking-wider">{getValue() || 'Other'}</span>,
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
        cell: ({ getValue }) => {
          const val = getValue();
          if (!val) return <span className="text-tertiary">—</span>;
          const display = val.replace(/_/g, ' ').toLowerCase();
          return <span className="text-xs font-bold uppercase text-secondary tracking-tight">{display}</span>;
        },
      },
      {
        accessorKey: 'amount',
        header: 'Amount',
        cell: ({ getValue }) => {
          const v = parseFloat(getValue());
          return (
            <span className={`font-money text-base font-bold ${v > 0 ? 'text-loss' : 'text-gain'}`}>
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
            <span className="text-xs font-bold uppercase text-tertiary tracking-widest opacity-60">Posted</span>
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
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <div className="w-10 h-10 border-4 border-accent border-t-transparent rounded-full animate-spin shadow-glow" />
        <span className="text-xs font-bold tracking-widest uppercase text-tertiary animate-pulse">Loading Accounts</span>
      </div>
    );
  }

  const renderPagination = (table, data) => {
    if (data.length <= table.getState().pagination.pageSize) return null;
    return (
      <div className="flex items-center justify-between mt-6 px-4">
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold uppercase tracking-widest text-tertiary">Show</span>
          <select
            value={table.getState().pagination.pageSize}
            onChange={(e) => table.setPageSize(Number(e.target.value))}
            className="bg-surface-3 border-border rounded-lg px-3 py-1.5 text-sm font-bold focus:ring-1 focus:ring-accent"
          >
            {[10, 25, 50, 100].map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-6">
          <span className="text-xs font-bold uppercase tracking-widest text-tertiary">
            Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              className="px-4 py-2 bg-surface-3 text-secondary border border-border rounded-lg text-sm font-bold hover:bg-surface-2 hover:text-primary hover:border-accent disabled:opacity-30 transition-all"
            >
              Prev
            </button>
            <button
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              className="px-4 py-2 bg-surface-3 text-secondary border border-border rounded-lg text-sm font-bold hover:bg-surface-2 hover:text-primary hover:border-accent disabled:opacity-30 transition-all"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderTable = (table, columns, emptyMessage, onRowClick) => (
    <div className="card overflow-hidden">
      <div className="hidden md:block overflow-x-auto">
        <table className="min-w-full divide-y divide-border">
          <thead className="bg-surface-2">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className="px-5 py-5 text-left text-sm font-bold text-tertiary uppercase tracking-widest cursor-pointer hover:bg-surface-3 transition-colors"
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    <div className="flex items-center gap-2">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getIsSorted() && (
                        <span className="text-accent">{header.column.getIsSorted() === 'asc' ? '↑' : '↓'}</span>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-border bg-surface">
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-5 py-12 text-center text-tertiary text-base font-medium">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className={`hover:bg-surface-2 transition-colors ${onRowClick ? 'cursor-pointer' : ''}`}
                  onClick={() => onRowClick?.(row.original)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-5 py-4 whitespace-nowrap text-base text-primary">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderListView = () => (
    <Motion.div key="list" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      {/* Hero Section */}
      <div className="flex flex-col md:flex-row md:items-end justify-between mb-8 gap-6 pt-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Building2 className="text-accent w-5 h-5" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-secondary">Asset Management</span>
          </div>
          <h1 className="text-3xl md:text-5xl font-bold text-primary tracking-tighter leading-none mb-2">
            {formatCurrency(grandTotal)}
          </h1>
          <p className="text-sm text-secondary">Aggregate balance across {accounts.length} linked accounts</p>
        </div>

        <div className="flex items-center gap-4">
          <div className="p-4 bg-surface-2 border border-border rounded-2xl shadow-sm min-w-[120px]">
            <p className="text-[10px] font-bold text-tertiary uppercase tracking-widest mb-1">Accounts</p>
            <p className="text-lg font-mono font-bold text-primary">{accounts.length}</p>
          </div>
          <div className="p-4 bg-surface-2 border border-border rounded-2xl shadow-sm min-w-[120px]">
            <p className="text-[10px] font-bold text-tertiary uppercase tracking-widest mb-1">Plaid Items</p>
            <p className="text-lg font-mono font-bold text-accent">{plaidCount}</p>
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-loss-bg border border-loss/20 text-loss rounded-xl text-xs flex items-center gap-3">
          <X size={16} />
          {error}
        </div>
      )}

      <div className="mb-5 rounded-2xl border border-border bg-surface overflow-hidden">
        <div className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2 shrink-0">
            <Filter size={16} className="text-accent" />
            <span className="text-sm font-bold uppercase tracking-widest text-primary">Filters</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setTypeFilter('')}
              className={`flex items-center gap-3 rounded-xl border px-3 py-2 transition-all ${
                typeFilter === ''
                  ? 'bg-accent/10 border-accent/30 text-accent ring-1 ring-accent/10'
                  : 'bg-surface-2 border-transparent text-secondary hover:border-border hover:text-primary'
              }`}
            >
              <span className="text-xs font-bold uppercase tracking-wider">All Types</span>
              <span className="text-[10px] font-mono font-bold opacity-60">{accounts.length}</span>
            </button>
            {distinctTypes.map((type) => {
              const count = accounts.filter(a => a.type === type).length;
              return (
                <button
                  key={type}
                  onClick={() => setTypeFilter(type)}
                  className={`flex items-center gap-3 rounded-xl border px-3 py-2 transition-all ${
                    typeFilter === type
                      ? 'bg-accent/10 border-accent/30 text-accent ring-1 ring-accent/10'
                      : 'bg-surface-2 border-transparent text-secondary hover:border-border hover:text-primary'
                  }`}
                >
                  <span className="text-xs font-bold uppercase tracking-wider">{type}</span>
                  <span className="text-[10px] font-mono font-bold opacity-60">{count}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {renderTable(listTable, listColumns, 'No accounts match the selected filters.', (account) =>
        setSelectedAccountId(account.id)
      )}

      {/* Mobile cards */}
      <div className="md:hidden space-y-3">
        {filteredAccounts.map((account) => {
          const total = accountTotals.get(account.id) || 0;
          return (
            <div
              key={account.id}
              className="card p-4 active:bg-surface-3 cursor-pointer transition-all border border-border/50"
              onClick={() => setSelectedAccountId(account.id)}
            >
              <div className="flex justify-between items-start mb-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-bold text-primary truncate text-base">{getAccountDisplayName(account)}</span>
                    {account.plaid_item_id && <PlaidBadge />}
                  </div>
                  {hasAccountDisplayName(account) && (
                    <div className="text-[10px] text-tertiary truncate uppercase tracking-tight mb-1">{account.name}</div>
                  )}
                  <TypeBadge type={account.type} />
                </div>
                <div className={`text-lg font-money font-bold ${total < 0 ? 'text-loss' : 'text-primary'}`}>
                  {formatCurrency(total)}
                </div>
              </div>
              <div className="flex items-center gap-4 pt-3 border-t border-border/50 text-tertiary">
                <span className="text-[10px] font-bold uppercase tracking-widest">{account.holdings_count || 0} Assets</span>
                <span className="text-[10px] font-bold uppercase tracking-widest">{account.type}</span>
              </div>
            </div>
          );
        })}
        {filteredAccounts.length === 0 && (
          <div className="p-8 text-center text-secondary text-sm">No accounts found</div>
        )}
      </div>

      {renderPagination(listTable, filteredAccounts)}
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
          className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-tertiary hover:text-accent mb-8 transition-colors group"
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
              {getAccountDisplayName(selectedAccount)}
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
            <div className="p-5 bg-surface-2 border border-border rounded-2xl shadow-glow-sm min-w-[180px]">
              <p className="text-[10px] font-bold text-tertiary uppercase tracking-widest mb-1">Account Value</p>
              <p className={`text-2xl font-money font-bold ${accountTotal < 0 ? 'text-loss' : 'text-gain'}`}>
                {formatCurrency(accountTotal)}
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-5 gap-8">
          <div className="xl:col-span-3 space-y-10">
            {/* Chart Section */}
            <section>
              <div className="flex items-center gap-2 mb-4">
                <Activity className="text-accent w-4 h-4" />
                <h2 className="text-xs font-bold uppercase tracking-widest text-secondary">Performance History</h2>
              </div>
              <AccountHistoryChart
                accountData={accountHistory}
                portfolioData={null}
                accounts={[selectedAccount]}
                selectedAccounts={[selectedAccountId]}
                showPortfolio={false}
                loading={historyLoading}
                error={historyError}
              />
            </section>

            {/* Assets Table */}
            {accountHoldings.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-4">
                  <Wallet className="text-accent w-4 h-4" />
                  <h2 className="text-xs font-bold uppercase tracking-widest text-secondary">Underlying Assets ({accountHoldings.length})</h2>
                </div>
                {renderTable(detailTable, detailColumns, 'No holdings found.')}
                
                {/* Mobile Asset Cards */}
                <div className="md:hidden space-y-3">
                  {accountHoldings.map((holding) => {
                    const value = parseFloat(holding.current_value) || parseFloat(holding.manual_value) || 0;
                    return (
                      <div key={holding.id} className="card p-4 border border-border/50">
                        <div className="flex justify-between items-start mb-2">
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-bold text-primary truncate">{holding.name}</div>
                            <div className="text-[10px] font-mono text-accent uppercase">{holding.ticker || 'N/A'}</div>
                          </div>
                          <div className={`text-base font-money font-bold ${value < 0 ? 'text-loss' : 'text-primary'}`}>
                            {formatCurrency(value)}
                          </div>
                        </div>
                        <div className="flex items-center gap-3 pt-2 border-t border-border/50">
                          <span className="text-[9px] font-bold uppercase tracking-widest text-tertiary">{holding.category || 'Other'}</span>
                          {holding.is_plaid_managed && <PlaidBadge />}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {renderPagination(detailTable, accountHoldings)}
              </section>
            )}
          </div>

          <div className="xl:col-span-2 space-y-10">
            {/* Transactions Section */}
            <section>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Receipt className="text-accent w-4 h-4" />
                  <h2 className="text-xs font-bold uppercase tracking-widest text-secondary">Recent Activity</h2>
                </div>
                {accountTransactions.length > 0 && (
                  <span className="text-[10px] font-bold text-accent px-2 py-0.5 rounded bg-accent/10 border border-accent/20">
                    {accountTransactions.length} Total
                  </span>
                )}
              </div>
              
              <div className="space-y-3">
                {txnLoading ? (
                  <div className="flex flex-col items-center justify-center py-12 gap-3 card">
                    <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                    <span className="text-[10px] font-bold uppercase text-tertiary">Fetching transactions</span>
                  </div>
                ) : accountTransactions.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 gap-2 card opacity-50">
                    <Receipt size={32} className="text-tertiary" />
                    <p className="text-[10px] font-bold uppercase tracking-widest text-tertiary">No recent transactions</p>
                  </div>
                ) : (
                  <>
                    <div className="hidden md:block">
                      {renderTable(txnTable, txnColumns, 'No transactions found.')}
                    </div>
                    
                    {/* Compact Transaction Cards for Sidebar/Mobile */}
                    <div className="md:grid grid-cols-1 gap-2 hidden xl:block">
                      {accountTransactions.slice(0, 10).map((txn) => {
                        const amount = parseFloat(txn.amount);
                        return (
                          <div key={txn.id} className="p-3 bg-surface-2 border border-border/50 rounded-xl flex items-center justify-between gap-4 hover:bg-surface-3 transition-colors">
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-bold text-primary truncate leading-tight">{txn.merchant_name || txn.name}</p>
                              <p className="text-[9px] text-tertiary uppercase font-medium mt-0.5">{formatDateDisplay(txn.date)} • {txn.category?.replace(/_/g, ' ') || 'General'}</p>
                            </div>
                            <div className={`text-xs font-money font-bold whitespace-nowrap ${amount > 0 ? 'text-loss' : 'text-gain'}`}>
                              {amount > 0 ? '—' : '+'}{formatCurrency(Math.abs(amount))}
                            </div>
                          </div>
                        );
                      })}
                      {accountTransactions.length > 10 && (
                        <p className="text-center text-[9px] font-bold text-tertiary uppercase tracking-widest pt-2">Showing latest 10 of {accountTransactions.length}</p>
                      )}
                    </div>
                    
                    {/* Mobile Only Cards */}
                    <div className="md:hidden space-y-2">
                       {accountTransactions.map((txn) => {
                        const amount = parseFloat(txn.amount);
                        return (
                          <div key={txn.id} className="p-4 bg-surface-2 border border-border/50 rounded-2xl flex items-center justify-between gap-4">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-bold text-primary truncate">{txn.merchant_name || txn.name}</p>
                              <div className="flex items-center gap-2 mt-1">
                                <span className="text-[10px] text-tertiary font-mono">{formatDateDisplay(txn.date)}</span>
                                {txn.pending && <span className="text-[9px] font-bold uppercase text-amber-500">Pending</span>}
                              </div>
                            </div>
                            <div className={`text-base font-money font-bold ${amount > 0 ? 'text-loss' : 'text-gain'}`}>
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
    <div className="container mx-auto px-4 py-6 md:py-8">
      <AnimatePresence mode="wait">
        {selectedAccountId === null ? renderListView() : renderDetailView()}
      </AnimatePresence>
    </div>
  );
};

export default AccountsPage;
