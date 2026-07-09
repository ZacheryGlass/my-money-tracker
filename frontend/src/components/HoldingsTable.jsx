import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  flexRender,
} from '@tanstack/react-table';
import { Download, FilterX, Link2, Pencil, Plus } from 'lucide-react';
import { holdings as holdingsAPI, accounts as accountsAPI, exportData } from '../utils/api';
import { formatCurrency } from '../utils/format';
import HoldingForm from './HoldingForm';
import { buildAccountDisplayNameMap, getAccountDisplayName } from '../utils/accountDisplay';
import { formatCategoryLabel } from '../utils/dataLabels';

const ASSET_TYPES = new Set(['investment', 'crypto', 'property', 'other']);

const getHoldingValue = (holding) => parseFloat(holding.current_value ?? holding.manual_value ?? 0) || 0;

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

  useEffect(() => { fetchData(); }, []);

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
      setError(err.response?.data?.error || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const showSuccess = (message) => {
    setSuccessMessage(message);
    setTimeout(() => setSuccessMessage(''), 3000);
  };

  const handleAddNew = () => { setEditingHolding(null); setIsFormOpen(true); };
  const handleEdit = useCallback((holding) => { setEditingHolding(holding); setIsFormOpen(true); }, []);

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

  const handleExportHoldings = () => { exportData.downloadHoldings(); };
  const handleCategoryFilterChange = (value) => { setCategoryFilter(value); setPagination((p) => ({ ...p, pageIndex: 0 })); };
  const handleAccountFilterChange = (value) => { setAccountFilter(value); setPagination((p) => ({ ...p, pageIndex: 0 })); };
  const clearFilters = () => {
    setCategoryFilter('');
    setAccountFilter('');
    setPagination((p) => ({ ...p, pageIndex: 0 }));
  };

  const accountsMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const accountDisplayNames = useMemo(() => buildAccountDisplayNameMap(accounts), [accounts]);
  const displayAccountName = useMemo(
    () => (account) => accountDisplayNames.get(account.id) || getAccountDisplayName(account),
    [accountDisplayNames]
  );

  const scopedHoldings = useMemo(() => {
    let data = holdings.filter((h) => Math.abs(h.current_value ?? 0) >= 10);
    if (pageFilter === 'assets') {
      const assetAccountIds = new Set(accounts.filter((a) => ASSET_TYPES.has(a.type)).map((a) => a.id));
      data = data.filter((h) => assetAccountIds.has(h.account_id));
    }
    return data;
  }, [holdings, accounts, pageFilter]);

  const accountsWithHoldings = useMemo(() => {
    const ids = new Set(scopedHoldings.map((h) => h.account_id));
    let filtered = accounts.filter((a) => ids.has(a.id));
    if (pageFilter === 'assets') filtered = filtered.filter((a) => ASSET_TYPES.has(a.type));
    return filtered;
  }, [accounts, scopedHoldings, pageFilter]);

  const distinctCategories = useMemo(() => {
    const cats = new Set();
    scopedHoldings.forEach((h) => { cats.add(formatCategoryLabel(h.category)); });
    return Array.from(cats).sort();
  }, [scopedHoldings]);

  const filteredData = useMemo(() => {
    let data = scopedHoldings;
    if (accountFilter) data = data.filter((h) => h.account_id === parseInt(accountFilter));
    if (categoryFilter) data = data.filter((h) => formatCategoryLabel(h.category) === categoryFilter);
    return data;
  }, [scopedHoldings, accountFilter, categoryFilter]);

  const summary = useMemo(() => {
    const totalValue = scopedHoldings.reduce((sum, h) => sum + getHoldingValue(h), 0);
    const visibleValue = filteredData.reduce((sum, h) => sum + getHoldingValue(h), 0);
    const categoryValue = categoryFilter
      ? scopedHoldings.filter((h) => formatCategoryLabel(h.category) === categoryFilter).reduce((sum, h) => sum + getHoldingValue(h), 0)
      : totalValue;
    const accountValue = accountFilter
      ? scopedHoldings.filter((h) => h.account_id === parseInt(accountFilter)).reduce((sum, h) => sum + getHoldingValue(h), 0)
      : totalValue;
    const selectedAccount = accountFilter ? accountsMap.get(parseInt(accountFilter)) : null;

    return {
      totalValue,
      visibleValue,
      categoryValue,
      accountValue,
      selectedAccount,
      selectedCategory: categoryFilter || 'All categories',
      activeFilters: Number(Boolean(accountFilter)) + Number(Boolean(categoryFilter)),
    };
  }, [scopedHoldings, filteredData, categoryFilter, accountFilter, accountsMap]);

  const columns = useMemo(
    () => [
      {
        id: 'account',
        accessorFn: (row) => {
          const account = accountsMap.get(row.account_id);
          return account ? displayAccountName(account) : row.account_name || 'Unknown';
        },
        header: 'Account',
        cell: ({ row, getValue }) => {
          const account = accountsMap.get(row.original.account_id);
          return (
            <div className="min-w-[150px] max-w-[210px]">
              <span className="truncate block text-primary" title={getValue()}>{getValue()}</span>
              <span className="text-caption text-tertiary uppercase">{account?.type || 'Account'}</span>
            </div>
          );
        },
      },
      {
        accessorKey: 'ticker',
        header: 'Ticker',
        cell: ({ getValue }) => getValue() || '-',
      },
      {
        accessorKey: 'name',
        header: 'Name',
        cell: ({ row }) => (
          <div className="min-w-[220px] max-w-[300px]">
            <div className="flex items-center gap-2">
              <span className="truncate font-semibold text-primary" title={row.original.name}>{row.original.name}</span>
              {row.original.is_plaid_managed && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-caption bg-accent-muted text-accent border border-accent/20 flex-shrink-0">
                  <Link2 size={10} />
                  Plaid
                </span>
              )}
            </div>
            <p className="text-caption text-tertiary truncate" title={row.original.location || row.original.notes || ''}>
              {formatCategoryLabel(row.original.category)}{row.original.location ? ` / ${row.original.location}` : ''}
            </p>
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
          return <span className="font-mono font-semibold text-primary">{display}</span>;
        },
      },
      {
        accessorKey: 'category',
        header: 'Category',
        cell: ({ getValue }) => <span className="block max-w-[120px] truncate text-tertiary" title={formatCategoryLabel(getValue())}>{formatCategoryLabel(getValue())}</span>,
      },
      {
        id: 'actions',
        header: 'Actions',
        enableSorting: false,
        cell: ({ row }) => (
          row.original.is_plaid_managed ? (
            <span className="inline-flex items-center gap-1 px-2 py-1 text-caption bg-accent-muted text-accent border border-accent/20">
              <Link2 size={11} /> Linked
            </span>
          ) : (
            <button
              onClick={(event) => {
                event.stopPropagation();
                handleEdit(row.original);
              }}
              className="inline-flex items-center gap-1 px-2 py-1 text-caption bg-surface-3 text-secondary border border-border hover:text-primary hover:border-border-hover"
            >
              <Pencil size={11} /> Edit
            </button>
          )
        ),
      },
    ],
    [accountsMap, displayAccountName, handleEdit]
  );

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { sorting, pagination },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <span className="text-caption text-tertiary">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-3">
      <div className="mb-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between mb-3">
          <div>
            <h1 className="text-display-md text-primary mb-1">{pageFilter === 'assets' ? 'Assets' : 'Holdings'}</h1>
            <p className="text-body-sm text-tertiary">
              {filteredData.length} visible holdings across {accountsWithHoldings.length} accounts
            </p>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <button onClick={handleAddNew} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-accent text-white hover:bg-accent-hover rounded text-button font-semibold">
              <Plus size={14} /> Add Holding
            </button>
            <button onClick={handleExportHoldings} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-surface-3 text-secondary border border-border hover:border-border-hover rounded text-button">
              <Download size={14} /> Export CSV
            </button>
          </div>
        </div>

        {successMessage && (
          <div className="mb-3 bg-gain-bg text-gain border border-gain/20 p-2 text-body-sm">{successMessage}</div>
        )}
        {error && (
          <div className="mb-3 bg-loss-bg text-loss border border-loss/20 p-2 text-body-sm">{error}</div>
        )}

        <div className="grid gap-3 mb-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="border border-border bg-surface p-3">
            <p className="text-caption text-tertiary uppercase tracking-wide">Total Assets</p>
            <p className="font-mono text-xl font-semibold text-primary">{formatCurrency(summary.totalValue)}</p>
            <p className="text-caption text-tertiary">{scopedHoldings.length} tracked rows</p>
          </div>
          <div className="border border-border bg-surface p-3">
            <p className="text-caption text-tertiary uppercase tracking-wide">Visible Total</p>
            <p className="font-mono text-xl font-semibold text-gain">{formatCurrency(summary.visibleValue)}</p>
            <p className="text-caption text-tertiary">{summary.activeFilters || 'No'} active filters</p>
          </div>
          <div className="border border-border bg-surface p-3">
            <p className="text-caption text-tertiary uppercase tracking-wide">Category Total</p>
            <p className="font-mono text-xl font-semibold text-primary">{formatCurrency(summary.categoryValue)}</p>
            <p className="text-caption text-tertiary truncate" title={summary.selectedCategory}>{summary.selectedCategory}</p>
          </div>
          <div className="border border-border bg-surface p-3">
            <p className="text-caption text-tertiary uppercase tracking-wide">Account Total</p>
            <p className="font-mono text-xl font-semibold text-primary">{formatCurrency(summary.accountValue)}</p>
            <p className="text-caption text-tertiary truncate" title={summary.selectedAccount ? displayAccountName(summary.selectedAccount) : 'All accounts'}>
              {summary.selectedAccount ? displayAccountName(summary.selectedAccount) : 'All accounts'}
            </p>
          </div>
        </div>

        <div className="card p-3 mb-3 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-caption text-tertiary uppercase tracking-wide">Filters</p>
              <p className="text-body-sm text-secondary">
                {summary.activeFilters ? `${summary.activeFilters} active filter${summary.activeFilters === 1 ? '' : 's'}` : 'All holdings shown'}
              </p>
            </div>
            {summary.activeFilters > 0 && (
              <button onClick={clearFilters} className="inline-flex items-center gap-1.5 text-caption text-accent hover:text-accent-hover">
                <FilterX size={13} /> Clear filters
              </button>
            )}
          </div>

          {distinctCategories.length > 0 && (
            <div>
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-caption font-semibold text-tertiary uppercase">Category</span>
                <span className="text-caption text-tertiary">{distinctCategories.length} categories</span>
              </div>
              <div className="flex flex-wrap gap-1">
            <button
              onClick={() => handleCategoryFilterChange('')}
              className={`px-2 py-1 rounded text-caption transition-colors ${
                categoryFilter === '' ? 'bg-accent text-white' : 'bg-surface-3 text-secondary border border-border hover:text-primary'
              }`}
            >All</button>
            {distinctCategories.map((cat) => (
              <button
                key={cat}
                onClick={() => handleCategoryFilterChange(categoryFilter === cat ? '' : cat)}
                className={`px-2 py-1 rounded text-caption transition-colors ${
                  categoryFilter === cat ? 'bg-accent text-white' : 'bg-surface-3 text-secondary border border-border hover:text-primary'
                }`}
                title={cat}
              >
                <span className="inline-block max-w-[180px] truncate align-bottom">{cat}</span>
              </button>
            ))}
              </div>
            </div>
          )}

          {accountsWithHoldings.length > 0 && (
            <div>
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-caption font-semibold text-tertiary uppercase">Account</span>
                <span className="text-caption text-tertiary">{accountsWithHoldings.length} accounts</span>
              </div>
              <div className="flex flex-wrap gap-1">
                <button
                  onClick={() => handleAccountFilterChange('')}
                  className={`px-2 py-1 rounded text-caption transition-colors ${
                    accountFilter === '' ? 'bg-accent text-white' : 'bg-surface-3 text-secondary border border-border hover:text-primary'
                  }`}
                >All</button>
                {accountsWithHoldings.map((account) => {
                  const accountName = displayAccountName(account);
                  return (
                    <button
                      key={account.id}
                      onClick={() => handleAccountFilterChange(accountFilter === String(account.id) ? '' : String(account.id))}
                      className={`px-2 py-1 rounded text-caption transition-colors ${
                        accountFilter === String(account.id) ? 'bg-accent text-white' : 'bg-surface-3 text-secondary border border-border hover:text-primary'
                      }`}
                      title={accountName}
                    >
                      <span className="inline-block max-w-[190px] truncate align-bottom">{accountName}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          </div>
      </div>

      <div className="card overflow-hidden">
        <div className="hidden md:block overflow-x-auto">
          <table className="min-w-[840px] w-full divide-y divide-border">
            <thead className="bg-surface-2">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((header) => {
                    const isActions = header.column.id === 'actions';
                    return (
                    <th key={header.id} className={`px-3 py-2 text-left text-caption font-semibold text-tertiary uppercase tracking-wide cursor-pointer hover:bg-surface-3 ${isActions ? 'sticky right-0 z-20 bg-surface-2 shadow-[-8px_0_12px_rgba(0,0,0,0.18)]' : ''}`} onClick={header.column.getToggleSortingHandler()}>
                      <div className="flex items-center gap-1">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getIsSorted() && <span className="text-accent">{header.column.getIsSorted() === 'asc' ? '↑' : '↓'}</span>}
                      </div>
                    </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody className="divide-y divide-border">
              {table.getRowModel().rows.length === 0 ? (
                <tr><td colSpan={columns.length} className="px-3 py-8 text-center text-tertiary text-body-sm">No holdings found.</td></tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className={`hover:bg-surface-2 transition-colors ${row.original.is_plaid_managed ? '' : 'cursor-pointer'}`} onClick={() => !row.original.is_plaid_managed && handleEdit(row.original)}>
                    {row.getVisibleCells().map((cell) => {
                      const isActions = cell.column.id === 'actions';
                      return (
                      <td key={cell.id} className={`px-3 py-2 whitespace-nowrap text-body-sm text-secondary ${isActions ? 'sticky right-0 z-10 bg-surface shadow-[-8px_0_12px_rgba(0,0,0,0.18)]' : ''}`}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="md:hidden divide-y divide-border">
          {table.getRowModel().rows.length === 0 ? (
            <div className="px-3 py-8 text-center text-tertiary text-body-sm">No holdings found.</div>
          ) : (
            table.getRowModel().rows.map((row) => {
              const account = accountsMap.get(row.original.account_id);
              const value = row.original.current_value ?? 0;
              return (
                <div key={row.id} className={`p-3 ${row.original.is_plaid_managed ? '' : 'cursor-pointer hover:bg-surface-2'}`} onClick={() => !row.original.is_plaid_managed && handleEdit(row.original)}>
                  <div className="flex justify-between items-start mb-1">
                    <div className="flex-1 min-w-0">
                      <div className="text-body-sm font-semibold text-primary truncate">{row.original.name}</div>
                      {row.original.is_plaid_managed && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-caption bg-accent-muted text-accent border border-accent/20 mt-0.5">
                          <Link2 size={10} /> Plaid
                        </span>
                      )}
                      {row.original.ticker && <div className="text-caption text-tertiary mt-0.5">{row.original.ticker}</div>}
                    </div>
                    <div className="font-mono font-semibold text-primary">{formatCurrency(value)}</div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-caption text-tertiary">
                    <div>{account ? displayAccountName(account) : 'Unknown'}</div>
                    <div>{formatCategoryLabel(row.original.category)}</div>
                  </div>
                  <div className="mt-2">
                    {row.original.is_plaid_managed ? (
                      <span className="inline-flex items-center gap-1 px-2 py-1 text-caption bg-accent-muted text-accent border border-accent/20">
                        <Link2 size={11} /> Linked
                      </span>
                    ) : (
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          handleEdit(row.original);
                        }}
                        className="inline-flex items-center gap-1 px-2 py-1 text-caption bg-surface-3 text-secondary border border-border"
                      >
                        <Pencil size={11} /> Edit
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {filteredData.length > 0 && (
        <div className="flex items-center justify-between mt-3">
          <div className="flex items-center gap-2">
            <span className="text-caption text-tertiary">Rows:</span>
            <select
              value={pagination.pageSize}
              onChange={(e) => setPagination((p) => ({ ...p, pageIndex: 0, pageSize: Number(e.target.value) }))}
              className="px-2 py-1 text-caption"
            >
              {[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-caption text-tertiary">
              Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
            </span>
            <button onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} className="px-2 py-1 bg-surface-3 text-secondary border border-border rounded text-caption disabled:opacity-30">Prev</button>
            <button onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} className="px-2 py-1 bg-surface-3 text-secondary border border-border rounded text-caption disabled:opacity-30">Next</button>
          </div>
        </div>
      )}

      <HoldingForm isOpen={isFormOpen} onClose={() => setIsFormOpen(false)} onSave={handleSave} onDelete={handleDelete} holding={editingHolding} accounts={accounts} />
    </div>
  );
};

export default HoldingsTable;
