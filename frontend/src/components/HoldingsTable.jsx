import React, { useState, useEffect, useMemo } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
} from '@tanstack/react-table';
import { holdings as holdingsAPI, accounts as accountsAPI, exportData } from '../utils/api';
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

  // Create accounts map for O(1) lookup
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
          const value = row.original.manual_value || row.original.current_value || 0;
          return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
          }).format(value);
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
        id: 'actions',
        header: 'Actions',
        cell: ({ row }) => (
          <button
            onClick={() => handleDeleteClick(row.original)}
            className="px-3 py-1 text-sm text-white bg-red-600 rounded hover:bg-red-700"
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
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-xl text-gray-600">Loading...</div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-4 md:py-8">
      <div className="mb-4 md:mb-6">
        <h1 className="text-2xl md:text-3xl font-bold text-gray-900 mb-4">Holdings Management</h1>

        {/* Success Message */}
        {successMessage && (
          <div className="mb-4 p-4 bg-green-100 border border-green-400 text-green-700 rounded">
            {successMessage}
          </div>
        )}

        {/* Error Message */}
        {error && (
          <div className="mb-4 p-4 bg-red-100 border border-red-400 text-red-700 rounded">
            {error}
          </div>
        )}

        {/* Controls */}
        <div className="flex flex-col sm:flex-row flex-wrap gap-3 md:gap-4 items-stretch sm:items-center mb-4">
          <button
            onClick={handleAddNew}
            className="px-4 py-2 text-white bg-blue-600 rounded-md hover:bg-blue-700 touch-manipulation"
          >
            Add New Holding
          </button>

          <button
            onClick={() => setIsBulkImportOpen(true)}
            className="px-4 py-2 text-white bg-green-600 rounded-md hover:bg-green-700 touch-manipulation"
          >
            Bulk Import
          </button>

          <button
            onClick={handleExportHoldings}
            className="px-4 py-2 text-white bg-purple-600 rounded-md hover:bg-purple-700 touch-manipulation"
          >
            Export CSV
          </button>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 flex-1">
            <label className="text-sm font-medium text-gray-700 sm:whitespace-nowrap">Filter by Account:</label>
            <select
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
              className="flex-1 sm:flex-initial px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-[44px] touch-manipulation"
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

      {/* Table */}
      <div className="bg-white shadow-md rounded-lg">
        {/* Desktop Table - Hidden on mobile */}
        <div className="hidden md:block overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      <div className="flex items-center gap-2">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getIsSorted() && (
                          <span>{header.column.getIsSorted() === 'asc' ? '↑' : '↓'}</span>
                        )}
                      </div>
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {table.getRowModel().rows.length === 0 ? (
                <tr>
                  <td colSpan={columns.length} className="px-6 py-8 text-center text-gray-500">
                    No holdings found. Click "Add New Holding" to get started.
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className="hover:bg-gray-50 cursor-pointer"
                    onClick={() => handleEdit(row.original)}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        className="px-6 py-4 whitespace-nowrap text-sm text-gray-900"
                        onClick={(e) => {
                          // Prevent row click when clicking on action buttons
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

        {/* Mobile Card View - Visible only on mobile */}
        <div className="md:hidden divide-y divide-gray-200">
          {table.getRowModel().rows.length === 0 ? (
            <div className="px-4 py-8 text-center text-gray-500">
              No holdings found. Click "Add New Holding" to get started.
            </div>
          ) : (
            table.getRowModel().rows.map((row) => {
              const account = accountsMap.get(row.original.account_id);
              const value = row.original.manual_value || row.original.current_value || 0;
              return (
                <div
                  key={row.id}
                  className="p-4 active:bg-gray-100 touch-manipulation"
                  onClick={() => handleEdit(row.original)}
                >
                  <div className="space-y-3">
                    <div className="flex justify-between items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-gray-900 truncate">{row.original.name}</div>
                        {row.original.ticker && (
                          <div className="text-sm text-gray-600">{row.original.ticker}</div>
                        )}
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="text-lg font-bold text-green-600">
                          {new Intl.NumberFormat('en-US', {
                            style: 'currency',
                            currency: 'USD',
                          }).format(value)}
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <span className="text-gray-500 block">Account</span>
                        <div className="font-medium text-gray-900 truncate">
                          {account ? account.name : 'Unknown'}
                        </div>
                      </div>
                      {row.original.category && (
                        <div>
                          <span className="text-gray-500 block">Category</span>
                          <div className="font-medium text-gray-900 truncate">{row.original.category}</div>
                        </div>
                      )}
                    </div>
                    <div className="flex justify-end pt-2 border-t border-gray-100">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteClick(row.original);
                        }}
                        className="px-4 py-2 text-sm text-white bg-red-600 rounded hover:bg-red-700 active:bg-red-800 min-h-[44px] touch-manipulation"
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

      {/* Form Modal */}
      <HoldingForm
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        onSave={handleSave}
        holding={editingHolding}
        accounts={accounts}
      />

      {/* Bulk Import Modal */}
      <BulkImportForm
        isOpen={isBulkImportOpen}
        onClose={() => setIsBulkImportOpen(false)}
        onSuccess={handleBulkImportSuccess}
      />

      {/* Delete Confirmation Modal */}
      {deletingHolding && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
            <h2 className="text-xl font-bold mb-4 text-gray-900">Confirm Delete</h2>
            <p className="text-gray-700 mb-6">
              Are you sure you want to delete "{deletingHolding.name}"? This action cannot be
              undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeletingHolding(null)}
                className="px-4 py-2 text-gray-700 bg-gray-200 rounded-md hover:bg-gray-300"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteConfirm}
                className="px-4 py-2 text-white bg-red-600 rounded-md hover:bg-red-700"
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
