import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  flexRender,
} from '@tanstack/react-table';
import { Link2 } from 'lucide-react';
import { holdings as holdingsAPI, accounts as accountsAPI } from '../utils/api';
import { formatCurrency } from '../utils/format';
import HoldingForm from './HoldingForm';
import SummaryStats from './SummaryStats';
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
  const [sorting, setSorting] = useState([{ id: 'value', desc: true }]);
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

  const handleCategoryFilterChange = (value) => { setCategoryFilter(value); setPagination((p) => ({ ...p, pageIndex: 0 })); };
  const handleAccountFilterChange = (value) => { setAccountFilter(value); setPagination((p) => ({ ...p, pageIndex: 0 })); };

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

  // Reset a filter whose option vanished (e.g. the filtered account's last
  // holding was deleted); otherwise the select goes blank while the table
  // silently keeps filtering by it.
  useEffect(() => {
    if (accountFilter && !accountsWithHoldings.some((a) => String(a.id) === accountFilter)) {
      setAccountFilter('');
    }
  }, [accountFilter, accountsWithHoldings]);
  useEffect(() => {
    if (categoryFilter && !distinctCategories.includes(categoryFilter)) {
      setCategoryFilter('');
    }
  }, [categoryFilter, distinctCategories]);

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
        accessorKey: 'name',
        header: 'Asset Name',
        cell: ({ row }) => (
          <div className="min-w-0">
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
              {row.original.ticker ? `${row.original.ticker} / ` : ''}{formatCategoryLabel(row.original.category)}{row.original.location ? ` / ${row.original.location}` : ''}
            </p>
          </div>
        ),
      },
      {
        id: 'value',
        accessorFn: getHoldingValue,
        header: 'Value',
        cell: ({ getValue }) => {
          const v = getValue();
          return <span className="value-emphasis text-gain">{formatCurrency(v)}</span>;
        },
      },
      {
        accessorKey: 'category',
        header: 'Category',
        cell: ({ getValue }) => <span className="block max-w-[120px] truncate text-tertiary" title={formatCategoryLabel(getValue())}>{formatCategoryLabel(getValue())}</span>,
      },
    ],
    [accountsMap, displayAccountName]
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
    <div className="px-4 py-4">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-0.5 text-caption uppercase tracking-wide text-tertiary">{pageFilter === 'assets' ? 'Assets' : 'Holdings'}</p>
          <h1 className="font-money text-display-lg text-primary">{formatCurrency(summary.totalValue)}</h1>
          <p className="text-body-sm text-tertiary">
            {scopedHoldings.length} holdings across {accountsWithHoldings.length} accounts
          </p>
        </div>
        <SummaryStats stats={[
          { label: 'Accounts', value: accountsWithHoldings.length },
          { label: 'Holdings', value: scopedHoldings.length },
        ]} />
      </div>

      {successMessage && (
        <div className="mb-3 bg-gain-bg text-gain border border-gain/20 p-2 text-body-sm">{successMessage}</div>
      )}
      {error && (
        <div className="mb-3 bg-loss-bg text-loss border border-loss/20 p-2 text-body-sm">{error}</div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-3">
        {distinctCategories.length > 0 && (
          <label className="flex items-center gap-2">
            <span className="text-caption font-semibold uppercase tracking-wide text-tertiary">Category</span>
            <select
              value={categoryFilter}
              onChange={(e) => handleCategoryFilterChange(e.target.value)}
              className="h-9 min-w-[180px] border border-border bg-surface px-2 text-body-sm text-primary"
            >
              <option value="">All categories</option>
              {distinctCategories.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          </label>
        )}
        {accountsWithHoldings.length > 0 && (
          <label className="flex items-center gap-2">
            <span className="text-caption font-semibold uppercase tracking-wide text-tertiary">Account</span>
            <select
              value={accountFilter}
              onChange={(e) => handleAccountFilterChange(e.target.value)}
              className="h-9 min-w-[180px] border border-border bg-surface px-2 text-body-sm text-primary"
            >
              <option value="">All accounts</option>
              {accountsWithHoldings.map((account) => (
                <option key={account.id} value={String(account.id)}>{displayAccountName(account)}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="card overflow-hidden">
        <div className="hidden max-w-full overflow-hidden lg:block">
          <table className="w-full table-fixed divide-y divide-border">
            <thead className="bg-surface-2">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((header) => (
                    <th key={header.id} className="px-3 py-2 text-left text-caption font-semibold text-tertiary uppercase tracking-wide cursor-pointer hover:bg-surface-3" onClick={header.column.getToggleSortingHandler()}>
                      <div className="flex items-center gap-1">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getIsSorted() && <span className="text-accent">{header.column.getIsSorted() === 'asc' ? '↑' : '↓'}</span>}
                      </div>
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody className="divide-y divide-border">
              {table.getRowModel().rows.length === 0 ? (
                <tr><td colSpan={columns.length} className="px-3 py-8 text-center text-tertiary text-body-sm">No holdings found.</td></tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className={`hover:bg-surface-2 transition-colors ${row.original.is_plaid_managed ? '' : 'cursor-pointer'}`} onClick={() => !row.original.is_plaid_managed && handleEdit(row.original)}>
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-3 py-2 text-body-sm text-secondary">{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="divide-y divide-border lg:hidden">
          {table.getRowModel().rows.length === 0 ? (
            <div className="px-3 py-8 text-center text-tertiary text-body-sm">No holdings found.</div>
          ) : (
            table.getRowModel().rows.map((row) => {
              const account = accountsMap.get(row.original.account_id);
              const value = getHoldingValue(row.original);
              return (
                <div key={row.id} className={`p-3 ${row.original.is_plaid_managed ? '' : 'cursor-pointer hover:bg-surface-2'}`} onClick={() => !row.original.is_plaid_managed && handleEdit(row.original)}>
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-body-sm font-semibold text-primary">{row.original.name}</p>
                      <p className="truncate text-caption text-tertiary">
                        {account ? displayAccountName(account) : 'Unknown'} / {formatCategoryLabel(row.original.category)}
                        {row.original.ticker ? ` / ${row.original.ticker}` : ''}
                      </p>
                    </div>
                    <p className="value-emphasis shrink-0 pl-3 text-gain">{formatCurrency(value)}</p>
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
