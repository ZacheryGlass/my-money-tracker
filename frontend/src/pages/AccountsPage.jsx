import React, { useState, useEffect, useMemo } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  flexRender,
} from '@tanstack/react-table';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, Link2 } from 'lucide-react';
import { accounts as accountsAPI, holdings as holdingsAPI, history as historyApi, transactions as transactionsApi } from '../utils/api';
import { formatCurrency, formatDateDisplay } from '../utils/format';
import AccountHistoryChart from '../components/AccountHistoryChart';

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
  <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full border ${TYPE_COLORS[type] || TYPE_COLORS.other}`}>
    {type}
  </span>
);

const PlaidBadge = () => (
  <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full bg-accent/10 text-accent border border-accent/20">
    <Link2 size={10} />
    Plaid
  </span>
);

const AccountsPage = () => {
  const [accounts, setAccounts] = useState([]);
  const [holdings, setHoldings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [typeFilter, setTypeFilterRaw] = useState('');
  const setTypeFilter = (v) => { setTypeFilterRaw(v); setPagination(prev => ({ ...prev, pageIndex: 0 })); };
  const [sorting, setSorting] = useState([]);
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
    if (!typeFilter) return accounts;
    return accounts.filter((a) => a.type === typeFilter);
  }, [accounts, typeFilter]);

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
        accessorKey: 'name',
        header: 'Name',
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <span className="font-medium">{row.original.name}</span>
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
        header: 'Holdings',
        cell: ({ getValue }) => <span className="font-mono">{getValue()}</span>,
      },
      {
        id: 'total_value',
        accessorFn: (row) => accountTotals.get(row.id) || 0,
        header: 'Total Value',
        cell: ({ getValue }) => {
          const v = getValue();
          return (
            <span className={`font-mono text-base font-semibold ${v < 0 ? 'text-loss' : 'text-primary'}`}>
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
          <span className="font-mono text-secondary">{getValue() || '-'}</span>
        ),
      },
      {
        accessorKey: 'name',
        header: 'Name',
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <span>{row.original.name}</span>
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
            <span className={`font-mono text-base font-semibold ${v < 0 ? 'text-loss' : 'text-primary'}`}>
              {formatCurrency(v)}
            </span>
          );
        },
      },
      {
        accessorKey: 'category',
        header: 'Category',
        cell: ({ getValue }) => <span className="text-secondary">{getValue() || '-'}</span>,
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
          <span className="font-mono text-sm">{formatDateDisplay(getValue())}</span>
        ),
      },
      {
        id: 'description',
        accessorFn: (row) => row.merchant_name || row.name,
        header: 'Description',
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="truncate">{row.original.merchant_name || row.original.name}</div>
            {row.original.merchant_name && row.original.merchant_name !== row.original.name && (
              <div className="text-xs text-tertiary truncate">{row.original.name}</div>
            )}
          </div>
        ),
      },
      {
        accessorKey: 'category',
        header: 'Category',
        cell: ({ getValue }) => {
          const val = getValue();
          if (!val) return <span className="text-secondary">-</span>;
          const display = val.replace(/_/g, ' ').toLowerCase();
          return <span className="text-secondary capitalize">{display}</span>;
        },
      },
      {
        accessorKey: 'amount',
        header: 'Amount',
        cell: ({ getValue }) => {
          const v = parseFloat(getValue());
          return (
            <span className={`font-mono text-base font-semibold ${v > 0 ? 'text-loss' : 'text-gain'}`}>
              {v > 0 ? '-' : '+'}{formatCurrency(Math.abs(v))}
            </span>
          );
        },
      },
      {
        accessorKey: 'pending',
        header: 'Status',
        cell: ({ getValue }) => (
          getValue() ? (
            <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
              Pending
            </span>
          ) : (
            <span className="text-xs text-secondary">Posted</span>
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
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-xl text-secondary">Loading...</div>
      </div>
    );
  }

  const renderPagination = (table, data) => {
    if (data.length <= 25) return null;
    return (
      <div className="flex items-center justify-between mt-4">
        <div className="flex items-center gap-2">
          <span className="text-sm text-secondary">Rows per page:</span>
          <select
            value={table.getState().pagination.pageSize}
            onChange={(e) =>
              table.setPageSize(Number(e.target.value))
            }
            className="px-2 py-1 rounded-md text-sm"
          >
            {[10, 25, 50, 100].map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-secondary">
            Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
          </span>
          <button
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            className="px-3 py-1 text-sm bg-surface-3 text-secondary hover:bg-accent hover:text-inverse rounded-md disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Prev
          </button>
          <button
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            className="px-3 py-1 text-sm bg-surface-3 text-secondary hover:bg-accent hover:text-inverse rounded-md disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </div>
      </div>
    );
  };

  const renderTable = (table, columns, emptyMessage, onRowClick) => (
    <div className="bg-surface rounded-card border border-border overflow-hidden shadow-card">
      <div className="hidden md:block overflow-x-auto">
        <table className="min-w-full divide-y divide-border">
          <thead className="bg-surface-2">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className="px-4 py-2 text-left text-xs font-medium text-secondary uppercase tracking-wider cursor-pointer hover:bg-surface-3"
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    <div className="flex items-center gap-2">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getIsSorted() && (
                        <span className="text-secondary">{header.column.getIsSorted() === 'asc' ? '↑' : '↓'}</span>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-border">
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-6 text-center text-secondary">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-border hover:bg-surface-3 cursor-pointer"
                  onClick={() => onRowClick?.(row.original)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-4 py-1.5 whitespace-nowrap text-sm text-primary">
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
    <motion.div key="list" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="mb-3">
        <h1 className="text-xl font-bold text-primary mb-3">Accounts</h1>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div className="card p-4 md:p-5">
            <h3 className="text-xs uppercase tracking-wider text-secondary">Total Accounts</h3>
            <p className="mt-2 text-xl font-mono font-bold text-primary">{accounts.length}</p>
          </div>
          <div className="card p-4 md:p-5">
            <h3 className="text-xs uppercase tracking-wider text-secondary">Net Value</h3>
            <p className={`mt-2 text-xl font-mono font-bold ${grandTotal >= 0 ? 'text-gain' : 'text-loss'}`}>
              {formatCurrency(grandTotal)}
            </p>
          </div>
          <div className="card p-4 md:p-5">
            <h3 className="text-xs uppercase tracking-wider text-secondary">Plaid Linked</h3>
            <p className="mt-2 text-xl font-mono font-bold text-accent">{plaidCount}</p>
          </div>
        </div>

        {error && (
          <div className="mb-4 bg-loss-bg text-loss border border-loss/20 rounded-lg p-3">{error}</div>
        )}

        {distinctTypes.length > 1 && (
          <div className="flex flex-wrap gap-2 mb-3 items-center">
            <span className="text-xs font-medium text-secondary uppercase tracking-wider mr-1">Type:</span>
            <button
              onClick={() => setTypeFilter('')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors touch-manipulation min-h-[36px] ${
                typeFilter === ''
                  ? 'bg-accent text-inverse'
                  : 'bg-surface-3 text-secondary border border-border hover:text-primary'
              }`}
            >
              All
            </button>
            {distinctTypes.map((type) => (
              <button
                key={type}
                onClick={() => setTypeFilter(typeFilter === type ? '' : type)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors touch-manipulation min-h-[36px] capitalize ${
                  typeFilter === type
                    ? 'bg-accent text-inverse'
                    : 'bg-surface-3 text-secondary border border-border hover:text-primary'
                }`}
              >
                {type}
              </button>
            ))}
          </div>
        )}
      </div>

      {renderTable(listTable, listColumns, 'No accounts found.', (account) =>
        setSelectedAccountId(account.id)
      )}

      {/* Mobile cards */}
      <div className="md:hidden divide-y divide-border bg-surface rounded-card border border-border overflow-hidden shadow-card">
        {filteredAccounts.length === 0 ? (
          <div className="px-4 py-8 text-center text-secondary">No accounts found.</div>
        ) : (
          listTable.getRowModel().rows.map((row) => {
            const account = row.original;
            const total = accountTotals.get(account.id) || 0;
            return (
              <div
                key={account.id}
                className="p-3 touch-manipulation active:bg-surface-3 cursor-pointer"
                onClick={() => setSelectedAccountId(account.id)}
              >
                <div className="flex justify-between items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-semibold text-primary truncate">{account.name}</span>
                      {account.plaid_item_id && <PlaidBadge />}
                    </div>
                    <div className="flex items-center gap-2">
                      <TypeBadge type={account.type} />
                      <span className="text-xs text-secondary">{account.holdings_count || 0} holdings</span>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className={`text-lg font-bold font-mono ${total < 0 ? 'text-loss' : 'text-primary'}`}>
                      {formatCurrency(total)}
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {renderPagination(listTable, filteredAccounts)}
    </motion.div>
  );

  const renderDetailView = () => {
    if (!selectedAccount) return null;

    return (
      <motion.div
        key="detail"
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -20 }}
      >
        <button
          onClick={() => setSelectedAccountId(null)}
          className="flex items-center gap-2 text-sm text-secondary hover:text-primary mb-4 transition-colors"
        >
          <ArrowLeft size={16} />
          <span>Back to Accounts</span>
        </button>

        <div className="mb-4">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl font-bold text-primary">{selectedAccount.name}</h1>
            <TypeBadge type={selectedAccount.type} />
            {selectedAccount.plaid_item_id && <PlaidBadge />}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div className="card p-4 md:p-5">
            <h3 className="text-xs uppercase tracking-wider text-secondary">Total Value</h3>
            <p className={`mt-2 text-xl font-mono font-bold ${accountTotal < 0 ? 'text-loss' : 'text-gain'}`}>
              {formatCurrency(accountTotal)}
            </p>
          </div>
          <div className="card p-4 md:p-5">
            <h3 className="text-xs uppercase tracking-wider text-secondary">Holdings</h3>
            <p className="mt-2 text-xl font-mono font-bold text-primary">{accountHoldings.length}</p>
          </div>
        </div>

        <div className="mb-6">
          <h2 className="text-sm font-bold uppercase tracking-wider text-secondary mb-3">Balance History</h2>
          <AccountHistoryChart
            accountData={accountHistory}
            portfolioData={null}
            accounts={[selectedAccount]}
            selectedAccounts={[selectedAccountId]}
            showPortfolio={false}
            loading={historyLoading}
            error={historyError}
          />
        </div>

        {accountHoldings.length > 0 && (
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wider text-secondary mb-3">Holdings</h2>

            {renderTable(detailTable, detailColumns, 'No holdings found.')}

            {/* Mobile cards */}
            <div className="md:hidden divide-y divide-border bg-surface rounded-card border border-border overflow-hidden shadow-card">
              {detailTable.getRowModel().rows.map((row) => {
                const holding = row.original;
                const value = parseFloat(holding.current_value) || parseFloat(holding.manual_value) || 0;
                return (
                  <div key={holding.id} className="p-3">
                    <div className="flex justify-between items-center gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="font-semibold text-primary truncate">{holding.name}</span>
                          {holding.is_plaid_managed && <PlaidBadge />}
                        </div>
                        <div className="flex items-center gap-2">
                          {holding.ticker && (
                            <span className="text-xs font-mono text-secondary">{holding.ticker}</span>
                          )}
                          {holding.category && (
                            <span className="text-xs text-secondary">{holding.category}</span>
                          )}
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className={`text-lg font-bold font-mono ${value < 0 ? 'text-loss' : 'text-primary'}`}>
                          {formatCurrency(value)}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {renderPagination(detailTable, accountHoldings)}
          </div>
        )}

        {txnLoading ? (
          <div className="mt-6 text-sm text-secondary">Loading transactions...</div>
        ) : accountTransactions.length > 0 && (
          <div className="mt-6">
            <h2 className="text-sm font-bold uppercase tracking-wider text-secondary mb-3">
              Transactions ({accountTransactions.length})
            </h2>

            {renderTable(txnTable, txnColumns, 'No transactions found.')}

            {/* Mobile cards */}
            <div className="md:hidden divide-y divide-border bg-surface rounded-card border border-border overflow-hidden shadow-card">
              {txnTable.getRowModel().rows.map((row) => {
                const txn = row.original;
                const amount = parseFloat(txn.amount);
                return (
                  <div key={txn.id} className="p-3">
                    <div className="flex justify-between items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-primary truncate">
                          {txn.merchant_name || txn.name}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs font-mono text-secondary">
                            {formatDateDisplay(txn.date)}
                          </span>
                          {txn.category && (
                            <span className="text-xs text-secondary capitalize">
                              {txn.category.replace(/_/g, ' ').toLowerCase()}
                            </span>
                          )}
                          {txn.pending && (
                            <span className="text-[10px] font-bold uppercase text-amber-400">Pending</span>
                          )}
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className={`text-base font-bold font-mono ${amount > 0 ? 'text-loss' : 'text-gain'}`}>
                          {amount > 0 ? '-' : '+'}{formatCurrency(Math.abs(amount))}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {renderPagination(txnTable, accountTransactions)}
          </div>
        )}
      </motion.div>
    );
  };

  return (
    <div className="container mx-auto px-4 py-2 md:py-4">
      <AnimatePresence mode="wait">
        {selectedAccountId === null ? renderListView() : renderDetailView()}
      </AnimatePresence>
    </div>
  );
};

export default AccountsPage;
