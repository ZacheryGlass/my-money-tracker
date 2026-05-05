import React, { useState, useEffect, useMemo } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  flexRender,
} from '@tanstack/react-table';
import { holdings as holdingsAPI, accounts as accountsAPI } from '../utils/api';
import { formatCurrency } from '../utils/format';
import StaticAssetsForm from '../components/StaticAssetsForm';

const StaticAssets = () => {
  const [assets, setAssets] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState('');
  const [sorting, setSorting] = useState([]);
  const [accountFilter, setAccountFilter] = useState('');
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 });
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState(null);
  const [deletingAsset, setDeletingAsset] = useState(null);

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

      const staticAssets = (holdingsData.holdings || []).filter(
        (holding) => !holding.ticker && holding.manual_value != null
      );

      setAssets(staticAssets);
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
    setEditingAsset(null);
    setIsFormOpen(true);
  };

  const handleEdit = (asset) => {
    setEditingAsset(asset);
    setIsFormOpen(true);
  };

  const handleSave = async (data) => {
    if (editingAsset) {
      await holdingsAPI.update(editingAsset.id, data);
      showSuccess('Static asset updated successfully');
    } else {
      await holdingsAPI.create(data);
      showSuccess('Static asset created successfully');
    }
    await fetchData();
    setIsFormOpen(false);
  };

  const handleDeleteClick = (asset) => {
    setDeletingAsset(asset);
  };

  const handleDeleteConfirm = async () => {
    try {
      await holdingsAPI.delete(deletingAsset.id);
      showSuccess('Static asset deleted successfully');
      await fetchData();
      setDeletingAsset(null);
    } catch (err) {
      console.error('Error deleting asset:', err);
      setError(err.response?.data?.error || 'Failed to delete asset');
      setDeletingAsset(null);
    }
  };

  const columns = useMemo(
    () => [
      {
        accessorKey: 'account_name',
        header: 'Account',
      },
      {
        accessorKey: 'name',
        header: 'Name',
      },
      {
        accessorKey: 'manual_value',
        header: 'Value',
        cell: ({ getValue }) => {
          const value = getValue();
          const isLiability = value < 0;
          return (
            <span className={`font-mono ${isLiability ? 'text-loss' : 'text-gain'}`}>
              {formatCurrency(value)}
            </span>
          );
        },
      },
      {
        accessorKey: 'category',
        header: 'Category',
        cell: ({ getValue }) => {
          const value = getValue();
          return value || '-';
        },
      },
      {
        accessorKey: 'notes',
        header: 'Notes',
        cell: ({ getValue }) => {
          const value = getValue();
          return value ? (
            <span className="text-sm text-secondary truncate max-w-xs block" title={value}>
              {value}
            </span>
          ) : (
            '-'
          );
        },
      },
      {
        id: 'actions',
        header: 'Actions',
        cell: ({ row }) => (
          <div className="flex gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleEdit(row.original);
              }}
              className="text-accent hover:bg-accent-muted rounded p-1 min-h-[44px] touch-manipulation"
            >
              Edit
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteClick(row.original);
              }}
              className="text-loss hover:bg-loss-bg rounded p-1 min-h-[44px] touch-manipulation"
            >
              Delete
            </button>
          </div>
        ),
      },
    ],
    []
  );

  const filteredData = useMemo(() => {
    if (!accountFilter) return assets;
    return assets.filter((a) => a.account_id === parseInt(accountFilter));
  }, [assets, accountFilter]);

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

  const { totalAssets, totalLiabilities, netWorth } = useMemo(() => {
    let assetsTotal = 0;
    let liabilitiesTotal = 0;

    assets.forEach((asset) => {
      const value = parseFloat(asset.manual_value) || 0;
      if (value < 0) {
        liabilitiesTotal += Math.abs(value);
      } else {
        assetsTotal += value;
      }
    });

    return {
      totalAssets: assetsTotal,
      totalLiabilities: liabilitiesTotal,
      netWorth: assetsTotal - liabilitiesTotal,
    };
  }, [assets]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-xl text-secondary">Loading...</div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-primary mb-2">Static Assets & Liabilities</h1>
        <p className="text-secondary mb-4">
          Manage assets and liabilities that don't have ticker symbols (real estate, loans, etc.)
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="card p-4 md:p-5">
            <h3 className="text-xs uppercase tracking-wider text-secondary">Assets</h3>
            <p className="mt-2 text-xl font-mono font-bold text-gain">
              {formatCurrency(totalAssets)}
            </p>
          </div>
          <div className="card p-4 md:p-5">
            <h3 className="text-xs uppercase tracking-wider text-secondary">Liabilities</h3>
            <p className="mt-2 text-xl font-mono font-bold text-loss">
              {formatCurrency(totalLiabilities)}
            </p>
          </div>
          <div className="card p-4 md:p-5">
            <h3 className="text-xs uppercase tracking-wider text-secondary">Net Worth</h3>
            <p className={`mt-2 text-xl font-mono font-bold ${netWorth >= 0 ? 'text-gain' : 'text-loss'}`}>
              {formatCurrency(netWorth)}
            </p>
          </div>
        </div>

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

        <div className="flex flex-wrap gap-4 items-center mb-4">
          <button
            onClick={handleAddNew}
            className="px-4 py-2 bg-accent text-inverse hover:bg-accent-hover rounded-md min-h-[44px] touch-manipulation"
          >
            Add New Asset/Liability
          </button>

          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-secondary">Filter by Account:</label>
            <select
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
              className="px-3 py-2 rounded-md min-h-[44px] touch-manipulation"
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
        <div className="overflow-x-auto">
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
                    No static assets or liabilities found. Click "Add New Asset/Liability" to get started.
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className="hover:bg-surface-3 border-b border-border">
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        className="px-4 py-1.5 whitespace-nowrap text-sm text-primary"
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

      <StaticAssetsForm
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        onSave={handleSave}
        asset={editingAsset}
        accounts={accounts}
      />

      {deletingAsset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-surface rounded-card border border-border shadow-xl max-w-md w-full mx-4 p-6">
            <h2 className="text-xl font-bold mb-4 text-primary">Confirm Delete</h2>
            <p className="text-secondary mb-6">
              Are you sure you want to delete "{deletingAsset.name}"? This action cannot be
              undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeletingAsset(null)}
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

export default StaticAssets;
