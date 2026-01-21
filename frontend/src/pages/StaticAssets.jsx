import React, { useState, useEffect, useMemo } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
} from '@tanstack/react-table';
import { holdings as holdingsAPI, accounts as accountsAPI } from '../utils/api';
import StaticAssetsForm from '../components/StaticAssetsForm';

const formatCurrency = (value) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value);
};

const StaticAssets = () => {
  const [assets, setAssets] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState('');
  const [sorting, setSorting] = useState([]);
  const [accountFilter, setAccountFilter] = useState('');
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
      
      // Filter only static assets (holdings without tickers)
      const staticAssets = (holdingsData.holdings || []).filter(
        (holding) => !holding.ticker && holding.manual_value !== null
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
    try {
      if (editingAsset) {
        await holdingsAPI.update(editingAsset.id, data);
        showSuccess('Static asset updated successfully');
      } else {
        await holdingsAPI.create(data);
        showSuccess('Static asset created successfully');
      }
      await fetchData();
      setIsFormOpen(false);
    } catch (error) {
      throw error; // Let the form handle the error
    }
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
            <span className={isLiability ? 'text-red-600 font-medium' : 'text-green-600 font-medium'}>
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
            <span className="text-sm text-gray-600 truncate max-w-xs block" title={value}>
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
              className="px-3 py-1 text-sm text-white bg-blue-600 rounded hover:bg-blue-700"
            >
              Edit
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteClick(row.original);
              }}
              className="px-3 py-1 text-sm text-white bg-red-600 rounded hover:bg-red-700"
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
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  // Calculate totals
  const { totalAssets, totalLiabilities, netWorth } = useMemo(() => {
    let assetsTotal = 0;
    let liabilitiesTotal = 0;

    assets.forEach((asset) => {
      if (asset.manual_value < 0) {
        liabilitiesTotal += Math.abs(asset.manual_value);
      } else {
        assetsTotal += asset.manual_value;
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
        <div className="text-xl text-gray-600">Loading...</div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900 mb-4">Static Assets & Liabilities</h1>
        <p className="text-gray-600 mb-4">
          Manage assets and liabilities that don't have ticker symbols (real estate, loans, etc.)
        </p>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="bg-white shadow-md rounded-lg p-6">
            <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Assets</h3>
            <p className="mt-2 text-2xl font-bold text-green-600">
              {formatCurrency(totalAssets)}
            </p>
          </div>
          <div className="bg-white shadow-md rounded-lg p-6">
            <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Liabilities</h3>
            <p className="mt-2 text-2xl font-bold text-red-600">
              {formatCurrency(totalLiabilities)}
            </p>
          </div>
          <div className="bg-white shadow-md rounded-lg p-6">
            <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Net Worth</h3>
            <p className={`mt-2 text-2xl font-bold ${netWorth >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {formatCurrency(netWorth)}
            </p>
          </div>
        </div>

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
        <div className="flex flex-wrap gap-4 items-center mb-4">
          <button
            onClick={handleAddNew}
            className="px-4 py-2 text-white bg-blue-600 rounded-md hover:bg-blue-700"
          >
            Add New Asset/Liability
          </button>

          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">Filter by Account:</label>
            <select
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
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
      <div className="overflow-x-auto bg-white shadow-md rounded-lg">
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
                  No static assets or liabilities found. Click "Add New Asset/Liability" to get started.
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr key={row.id} className="hover:bg-gray-50">
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className="px-6 py-4 whitespace-nowrap text-sm text-gray-900"
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

      {/* Form Modal */}
      <StaticAssetsForm
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        onSave={handleSave}
        asset={editingAsset}
        accounts={accounts}
      />

      {/* Delete Confirmation Modal */}
      {deletingAsset && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
            <h2 className="text-xl font-bold mb-4 text-gray-900">Confirm Delete</h2>
            <p className="text-gray-700 mb-6">
              Are you sure you want to delete "{deletingAsset.name}"? This action cannot be
              undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeletingAsset(null)}
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

export default StaticAssets;
