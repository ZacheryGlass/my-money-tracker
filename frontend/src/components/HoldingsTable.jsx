import React, { useState, useEffect, useMemo } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  flexRender,
} from '@tanstack/react-table';
import { holdings as holdingsAPI, accounts as accountsAPI, exportData } from '../utils/api';
import { formatCurrency } from '../utils/format';
import HoldingForm from './HoldingForm';
import BulkImportForm from './BulkImportForm';

const HoldingsTable = () => {
  const [holdings, setHoldings] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState('');
  const [sorting, setSorting] = useState([]);
  const [accountFilter, setAccountFilter] = useState('');
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 });
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingHolding, setEditingHolding] = useState(null);
  const [deletingHolding, setDeletingHolding] = useState(null);
  const [isBulkImportOpen, setIsBulkImportOpen] = useState(false);

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

  const handleDeleteClick = (holding) => {
    setDeletingHolding(holding);
  };

  const handleDeleteConfirm = async () => {
    try {
      await holdingsAPI.delete(deletingHolding.id);
      showSuccess('Holding deleted successfully');
      await fetchData();
      setDeletingHolding(null);
    } catch (err) {
      console.error('Error deleting holding:', err);
      setError(err.response?.data?.error || 'Failed to delete holding');
      setDeletingHolding(null);
    }
  };

  const handleBulkImportSuccess = (result) => {
    showSuccess(`Successfully imported ${result.summary.imported} holdings`);
    fetchData();
  };

  const handleExportHoldings = () => {
    exportData.downloadHoldings();
  };

  const accountsMap = useMemo(() => {
    return new Map(accounts.map((account) => [account.id, account]));
  }, [accounts]);

  const columns = useMemo(
    () => [
      {
        accessorKey: 'account_name',
        header: 'Account',
        cell: ({ row }) => {
          const account = accountsMap.get(row.original.account_id);
          return account ? account.name : 'Unknown';
        },
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
      },
      {
        accessorKey: 'value',
        header: 'Value',
        cell: ({ row }) => {
          const value = row.original.current_value ?? 0;
          return <span className="font-mono">{formatCurrency(value)}</span>;
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
      {
        accessorKey: 'location',
        header: 'Location',
        cell: ({ getValue }) => {
          const value = getValue();
          return <span className="text-secondary">{value || '-'}</span>;
        },
      },
      {
        id: 'actions',
        header: 'Actions',
        cell: ({ row }) => (
          <button
            onClick={() => handleDeleteClick(row.original)}
            className="text-loss hover:bg-loss-bg rounded p-1 min-h-[44px] touch-manipulation"
          >
            Delete
          </button>
        ),
      },
    ],
    [accounts]
  );

  const filteredData = useMemo(() => {
    if (!accountFilter) return holdings;
    return holdings.filter((h) => h.account_id === parseInt(accountFilter));
  }, [holdings, accountFilter]);

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
    <div className="container mx-auto px-4 py-4 md:py-8">
      <div className="mb-4 md:mb-6">
        <h1 className="text-xl font-bold text-primary mb-4">Holdings Management</h1>

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

        <div className="flex flex-col sm:flex-row flex-wrap gap-3 md:gap-4 items-stretch sm:items-center mb-4">
          <button
            onClick={handleAddNew}
            className="px-4 py-2 bg-accent text-inverse hover:bg-accent-hover rounded-md min-h-[44px] touch-manipulation"
          >
            Add New Holding
          </button>

          <button
            onClick={() => setIsBulkImportOpen(true)}
            className="px-4 py-2 bg-surface-3 text-secondary border border-border hover:border-border-hover rounded-md min-h-[44px] touch-manipulation"
          >
            Bulk Import
          </button>

          <button
            onClick={handleExportHoldings}
            className="px-4 py-2 bg-surface-3 text-secondary border border-border hover:border-border-hover rounded-md min-h-[44px] touch-manipulation"
          >
            Export CSV
          </button>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 flex-1">
            <label className="text-sm font-medium text-secondary sm:whitespace-nowrap">Filter by Account:</label>
            <select
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
              className="flex-1 sm:flex-initial px-3 py-2 rounded-md min-h-[44px] touch-manipulation"
            >
              <option value="">All Accounts</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </div>
        </div>
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
                      className="px-6 py-3 text-left text-xs font-medium text-secondary uppercase tracking-wider cursor-pointer hover:bg-surface-3"
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
                  <td colSpan={columns.length} className="px-6 py-8 text-center text-secondary">
                    No holdings found. Click "Add New Holding" to get started.
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className="hover:bg-surface-3 border-b border-border cursor-pointer"
                    onClick={() => handleEdit(row.original)}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        className="px-6 py-4 whitespace-nowrap text-sm text-primary"
                        onClick={(e) => {
                          if (cell.column.id === 'actions') {
                            e.stopPropagation();
                          }
                        }}
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
                  className="card p-3 active:bg-surface-3 touch-manipulation"
                  onClick={() => handleEdit(row.original)}
                >
                  <div className="space-y-3">
                    <div className="flex justify-between items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-primary truncate">{row.original.name}</div>
                        {row.original.ticker && (
                          <div className="text-sm text-secondary">{row.original.ticker}</div>
                        )}
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="text-lg font-bold font-mono text-primary">
                          {formatCurrency(value)}
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <span className="text-xs text-secondary block">Account</span>
                        <div className="font-medium text-primary truncate">
                          {account ? account.name : 'Unknown'}
                        </div>
                      </div>
                      {row.original.category && (
                        <div>
                          <span className="text-xs text-secondary block">Category</span>
                          <div className="font-medium text-primary truncate">{row.original.category}</div>
                        </div>
                      )}
                    </div>
                    <div className="flex justify-end pt-2 border-t border-border">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteClick(row.original);
                        }}
                        className="px-4 py-2 text-sm text-loss hover:bg-loss-bg rounded min-h-[44px] touch-manipulation"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {filteredData.length > 0 && (
        <div className="flex items-center justify-between mt-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-secondary">Rows per page:</span>
            <select
              value={pagination.pageSize}
              onChange={(e) => setPagination((p) => ({ ...p, pageIndex: 0, pageSize: Number(e.target.value) }))}
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
      )}

      <HoldingForm
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        onSave={handleSave}
        holding={editingHolding}
        accounts={accounts}
      />

      <BulkImportForm
        isOpen={isBulkImportOpen}
        onClose={() => setIsBulkImportOpen(false)}
        onSuccess={handleBulkImportSuccess}
      />

      {deletingHolding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-surface rounded-card border border-border shadow-xl max-w-md w-full mx-4 p-6">
            <h2 className="text-xl font-bold mb-4 text-primary">Confirm Delete</h2>
            <p className="text-secondary mb-6">
              Are you sure you want to delete "{deletingHolding.name}"? This action cannot be
              undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeletingHolding(null)}
                className="px-4 py-2 bg-surface-3 text-secondary hover:bg-surface-3/80 rounded-md"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteConfirm}
                className="px-4 py-2 bg-loss text-inverse rounded-md hover:opacity-90"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default HoldingsTable;
