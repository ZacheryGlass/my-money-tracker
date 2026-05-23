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
  const handleEdit = (holding) => { setEditingHolding(holding); setIsFormOpen(true); };

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

  const accountsMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const accountsWithHoldings = useMemo(() => {
    const ids = new Set(holdings.map((h) => h.account_id));
    let filtered = accounts.filter((a) => ids.has(a.id));
    if (pageFilter === 'assets') filtered = filtered.filter((a) => ASSET_TYPES.has(a.type));
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
        cell: ({ getValue }) => <span className="truncate max-w-[200px] block" title={getValue()}>{getValue()}</span>,
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
          <div className="flex items-center gap-2 max-w-[250px]">
            <span className="truncate" title={row.original.name}>{row.original.name}</span>
            {row.original.is_plaid_managed && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-caption bg-accent-muted text-accent border border-accent/20 flex-shrink-0">
                <Link2 size={10} />
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
          return <span className="font-mono font-semibold text-primary">{display}</span>;
        },
      },
      {
        accessorKey: 'category',
        header: 'Category',
        cell: ({ getValue }) => <span className="text-tertiary">{getValue() || '-'}</span>,
      },
    ],
    []
  );

  const filteredData = useMemo(() => {
    let data = holdings.filter((h) => Math.abs(h.current_value ?? 0) >= 10);
    if (pageFilter === 'assets') {
      const assetAccountIds = new Set(accounts.filter((a) => ASSET_TYPES.has(a.type)).map((a) => a.id));
      data = data.filter((h) => assetAccountIds.has(h.account_id));
    }
    if (accountFilter) data = data.filter((h) => h.account_id === parseInt(accountFilter));
    if (categoryFilter) data = data.filter((h) => h.category === categoryFilter);
    return data;
  }, [holdings, accounts, pageFilter, accountFilter, categoryFilter]);

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
        <h1 className="text-display-md text-primary mb-2">{pageFilter === 'assets' ? 'Assets' : 'Holdings'}</h1>

        {successMessage && (
          <div className="mb-3 bg-gain-bg text-gain border border-gain/20 p-2 text-body-sm">{successMessage}</div>
        )}
        {error && (
          <div className="mb-3 bg-loss-bg text-loss border border-loss/20 p-2 text-body-sm">{error}</div>
        )}

        <div className="flex flex-wrap gap-2 items-center mb-3">
          <button onClick={handleAddNew} className="px-3 py-1.5 bg-accent text-white hover:bg-accent-hover rounded text-button font-semibold">
            Add New Holding
          </button>
          <button onClick={handleExportHoldings} className="px-3 py-1.5 bg-surface-3 text-secondary border border-border hover:border-border-hover rounded text-button">
            Export CSV
          </button>
        </div>

        {distinctCategories.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2 items-center">
            <span className="text-caption font-semibold text-tertiary uppercase mr-1">Category:</span>
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
              >{cat}</button>
            ))}
          </div>
        )}

        {accountsWithHoldings.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2 items-center">
            <span className="text-caption font-semibold text-tertiary uppercase mr-1">Account:</span>
            <button
              onClick={() => handleAccountFilterChange('')}
              className={`px-2 py-1 rounded text-caption transition-colors ${
                accountFilter === '' ? 'bg-accent text-white' : 'bg-surface-3 text-secondary border border-border hover:text-primary'
              }`}
            >All</button>
            {accountsWithHoldings.map((account) => (
              <button
                key={account.id}
                onClick={() => handleAccountFilterChange(accountFilter === String(account.id) ? '' : String(account.id))}
                className={`px-2 py-1 rounded text-caption transition-colors ${
                  accountFilter === String(account.id) ? 'bg-accent text-white' : 'bg-surface-3 text-secondary border border-border hover:text-primary'
                }`}
              >{getAccountDisplayName(account)}</button>
            ))}
          </div>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="hidden md:block overflow-x-auto">
          <table className="min-w-full divide-y divide-border">
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
                      <td key={cell.id} className="px-3 py-2 whitespace-nowrap text-body-sm text-secondary">{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                    ))}
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
                    <div>{account ? getAccountDisplayName(account) : 'Unknown'}</div>
                    {row.original.category && <div>{row.original.category}</div>}
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
