import React, { useState, useEffect, useMemo } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  flexRender,
} from '@tanstack/react-table';
import { Link2 } from 'lucide-react';
import { holdings as holdingsAPI, accounts as accountsAPI, exportData } from '../utils/api';
import { formatCurrency } from '../utils/format';
import HoldingForm from './HoldingForm';
import { getAccountDisplayName } from '../utils/accountDisplay';

const ASSET_TYPES = new Set(['investment', 'crypto', 'property', 'other']);

const HoldingsTable = ({ pageFilter }) => {
  const [holdings, setHoldings] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState('');
  const [sorting, setSorting] = useState([]);
  const [accountFilter, setAccountFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 });
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingHolding, setEditingHolding] = useState(null);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [holdingsData, accountsData] = await Promise.all([
        holdingsAPI.getAll(),
        accountsAPI.getAll(),
      ]);
      setHoldings(holdingsData.holdings || []);
      setAccounts(accountsData.accounts || []);
      setError(null);
    } catch (err) {
      console.error('Error fetching data:', err);
      setError(err.response?.data?.error || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const showSuccess = (message) => {
    setSuccessMessage(message);
    setTimeout(() => setSuccessMessage(''), 3000);
  };

  const handleAddNew = () => {
    setEditingHolding(null);
    setIsFormOpen(true);
  };

  const handleEdit = (holding) => {
    setEditingHolding(holding);
    setIsFormOpen(true);
  };

  const handleSave = async (data) => {
    if (editingHolding) {
      await holdingsAPI.update(editingHolding.id, data);
      showSuccess('Holding updated successfully');
    } else {
      await holdingsAPI.create(data);
      showSuccess('Holding created successfully');
    }
    await fetchData();
    setIsFormOpen(false);
  };

  const handleDelete = async (id) => {
    try {
      await holdingsAPI.delete(id);
      showSuccess('Holding deleted');
      setIsFormOpen(false);
      setEditingHolding(null);
      await fetchData();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete holding');
    }
  };

  const handleExportHoldings = () => {
    exportData.downloadHoldings();
  };

  const handleCategoryFilterChange = (value) => {
    setCategoryFilter(value);
    setPagination((p) => ({ ...p, pageIndex: 0 }));
  };

  const handleAccountFilterChange = (value) => {
    setAccountFilter(value);
    setPagination((p) => ({ ...p, pageIndex: 0 }));
  };

  const accountsMap = useMemo(() => {
    return new Map(accounts.map((account) => [account.id, account]));
  }, [accounts]);

  const accountsWithHoldings = useMemo(() => {
    const ids = new Set(holdings.map((h) => h.account_id));
    let filtered = accounts.filter((a) => ids.has(a.id));
    if (pageFilter === 'assets') {
      filtered = filtered.filter((a) => ASSET_TYPES.has(a.type));
    }
    return filtered;
  }, [accounts, holdings, pageFilter]);

  const distinctCategories = useMemo(() => {
    const cats = new Set();
    holdings.forEach((h) => { if (h.category) cats.add(h.category); });
    return Array.from(cats).sort();
  }, [holdings]);

  const columns = useMemo(
    () => [
      {
        accessorKey: 'account_name',
        header: 'Account',
        cell: ({ getValue }) => (
          <span className="block truncate max-w-[200px]" title={getValue()}>{getValue()}</span>
        ),
      },
      {
        accessorKey: 'ticker',
        header: 'Ticker',
        cell: ({ getValue }) => {
          const value = getValue();
          return value || '-';
        },
      },
      {
        accessorKey: 'name',
        header: 'Name',
        cell: ({ row }) => (
          <div className="flex items-center gap-2 max-w-[250px]">
            <span className="truncate" title={row.original.name}>{row.original.name}</span>
            {row.original.is_plaid_managed && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-bold uppercase tracking-wider rounded-full bg-accent/10 text-accent border border-accent/20 flex-shrink-0">
                <Link2 size={12} />
                Plaid
              </span>
            )}
          </div>
        ),
      },
      {
        id: 'value',
        accessorFn: (row) => row.current_value ?? 0,
        header: 'Value',
        cell: ({ getValue }) => {
          const v = getValue();
          const abs = Math.abs(v);
          const sign = v < 0 ? '-' : '';
          let display;
          if (abs >= 1_000_000) display = `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
          else if (abs >= 1_000) display = `${sign}$${(abs / 1_000).toFixed(1)}k`;
          else display = formatCurrency(v);
          return <span className="font-money text-lg font-bold text-primary">{display}</span>;
        },
      },
      {
        accessorKey: 'category',
        header: 'Category',
        cell: ({ getValue }) => {
          const value = getValue();
          return <span className="text-secondary">{value || '-'}</span>;
        },
      },
    ],
    []
  );

  const filteredData = useMemo(() => {
    let data = holdings.filter((h) => Math.abs(h.current_value ?? 0) >= 10);
    if (pageFilter === 'assets') {
      const assetAccountIds = new Set(
        accounts.filter((a) => ASSET_TYPES.has(a.type)).map((a) => a.id)
      );
      data = data.filter((h) => assetAccountIds.has(h.account_id));
    }
    if (accountFilter) data = data.filter((h) => h.account_id === parseInt(accountFilter));
    if (categoryFilter) data = data.filter((h) => h.category === categoryFilter);
    return data;
  }, [holdings, accounts, pageFilter, accountFilter, categoryFilter]);

  const table = useReactTable({
    data: filteredData,
    columns,
    state: {
      sorting,
      pagination,
    },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-xl text-secondary">Loading...</div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-2 md:py-4">
      <div className="mb-3">
        <h1 className="text-xl font-bold text-primary mb-3">{pageFilter === 'assets' ? 'Assets' : 'Holdings'}</h1>

        {successMessage && (
          <div className="mb-4 bg-gain-bg text-gain border border-gain/20 rounded-lg p-3">
            {successMessage}
          </div>
        )}

        {error && (
          <div className="mb-4 bg-loss-bg text-loss border border-loss/20 rounded-lg p-3">
            {error}
          </div>
        )}

        <div className="flex flex-col sm:flex-row flex-wrap gap-3 items-stretch sm:items-center mb-3">
          <button
            onClick={handleAddNew}
            className="px-4 py-2 bg-accent text-inverse hover:bg-accent-hover rounded-md min-h-[44px] touch-manipulation"
          >
            Add New Holding
          </button>

          <button
            onClick={handleExportHoldings}
            className="px-4 py-2 bg-surface-3 text-secondary border border-border hover:border-border-hover rounded-md min-h-[44px] touch-manipulation"
          >
            Export CSV
          </button>
        </div>

        {distinctCategories.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2 items-center">
            <span className="text-sm font-semibold text-secondary uppercase tracking-wider mr-1">Category:</span>
            <button
              onClick={() => handleCategoryFilterChange('')}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-colors touch-manipulation min-h-[40px] ${
                categoryFilter === ''
                  ? 'bg-accent text-inverse'
                  : 'bg-surface-3 text-secondary border border-border hover:text-primary'
              }`}
            >
              All
            </button>
            {distinctCategories.map((cat) => (
              <button
                key={cat}
                onClick={() => handleCategoryFilterChange(categoryFilter === cat ? '' : cat)}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors touch-manipulation min-h-[40px] ${
                  categoryFilter === cat
                    ? 'bg-accent text-inverse'
                    : 'bg-surface-3 text-secondary border border-border hover:text-primary'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        )}

        {accountsWithHoldings.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2 items-center">
            <span className="text-sm font-semibold text-secondary uppercase tracking-wider mr-1">Account:</span>
            <button
              onClick={() => handleAccountFilterChange('')}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-colors touch-manipulation min-h-[40px] ${
                accountFilter === ''
                  ? 'bg-accent text-inverse'
                  : 'bg-surface-3 text-secondary border border-border hover:text-primary'
              }`}
            >
              All
            </button>
            {accountsWithHoldings.map((account) => (
              <button
                key={account.id}
                onClick={() => handleAccountFilterChange(accountFilter === String(account.id) ? '' : String(account.id))}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors touch-manipulation min-h-[40px] ${
                  accountFilter === String(account.id)
                    ? 'bg-accent text-inverse'
                    : 'bg-surface-3 text-secondary border border-border hover:text-primary'
                }`}
              >
                {getAccountDisplayName(account)}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="bg-surface rounded-card border border-border overflow-hidden shadow-card">
        <div className="hidden md:block overflow-x-auto">
          <table className="min-w-full divide-y divide-border">
            <thead className="bg-surface-2">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      className={`px-4 py-3 text-left text-sm font-bold text-secondary uppercase tracking-wider ${header.column.getCanSort() ? 'cursor-pointer hover:bg-surface-3' : ''}`}
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
                  <td colSpan={columns.length} className="px-4 py-8 text-center text-secondary">
                    No holdings found. Click "Add New Holding" to get started.
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className={`border-b border-border ${
                      row.original.is_plaid_managed
                        ? 'hover:bg-surface-2'
                        : 'hover:bg-surface-3 cursor-pointer'
                    }`}
                    onClick={() => !row.original.is_plaid_managed && handleEdit(row.original)}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        className="px-4 py-3 text-base text-primary"
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="md:hidden divide-y divide-border">
          {table.getRowModel().rows.length === 0 ? (
            <div className="px-4 py-8 text-center text-secondary">
              No holdings found. Click "Add New Holding" to get started.
            </div>
          ) : (
            table.getRowModel().rows.map((row) => {
              const account = accountsMap.get(row.original.account_id);
              const value = row.original.current_value ?? 0;
              return (
                <div
                  key={row.id}
                  className={`card p-4 touch-manipulation ${
                    row.original.is_plaid_managed ? '' : 'active:bg-surface-3 cursor-pointer'
                  }`}
                  onClick={() => !row.original.is_plaid_managed && handleEdit(row.original)}
                >
                  <div className="space-y-4">
                    <div className="flex justify-between items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-lg font-bold text-primary truncate">{row.original.name}</div>
                        {row.original.is_plaid_managed && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-bold uppercase tracking-wider rounded-full bg-accent/10 text-accent border border-accent/20 mt-1 w-fit">
                            <Link2 size={12} />
                            Plaid
                          </span>
                        )}
                        {row.original.ticker && (
                          <div className="text-base text-secondary mt-0.5">{row.original.ticker}</div>
                        )}
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="text-xl font-bold font-money text-primary">
                          {formatCurrency(value)}
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-base">
                      <div>
                        <span className="text-sm font-semibold text-secondary block mb-0.5">Account</span>
                        <div className="font-medium text-primary truncate">
                          {account ? getAccountDisplayName(account) : 'Unknown'}
                        </div>
                      </div>
                      {row.original.category && (
                        <div>
                          <span className="text-sm font-semibold text-secondary block mb-0.5">Category</span>
                          <div className="font-medium text-primary truncate">{row.original.category}</div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {filteredData.length > 0 && (
        <div className="flex items-center justify-between mt-6">
          <div className="flex items-center gap-3">
            <span className="text-base text-secondary">Rows per page:</span>
            <select
              value={pagination.pageSize}
              onChange={(e) => setPagination((p) => ({ ...p, pageIndex: 0, pageSize: Number(e.target.value) }))}
              className="px-3 py-1.5 rounded-md text-base"
            >
              {[10, 25, 50, 100].map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-base text-secondary">
              Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
            </span>
            <button
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              className="px-4 py-2 text-base bg-surface-3 text-secondary hover:bg-surface-2 hover:text-primary rounded-md disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Prev
            </button>
            <button
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              className="px-4 py-2 text-base bg-surface-3 text-secondary hover:bg-surface-2 hover:text-primary rounded-md disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}

      <HoldingForm
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        onSave={handleSave}
        onDelete={handleDelete}
        holding={editingHolding}
        accounts={accounts}
      />
    </div>
  );
};

export default HoldingsTable;
