import React, { useMemo } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
} from '@tanstack/react-table';

const formatCurrency = (value) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value);
};

const DashboardTable = ({ items }) => {
  const [sorting, setSorting] = React.useState([
    { id: 'value', desc: true },
  ]);

  const columns = useMemo(
    () => [
      {
        accessorKey: 'name',
        header: 'Name',
      },
      {
        accessorKey: 'ticker',
        header: 'Ticker',
        cell: ({ getValue }) => getValue() || '-',
      },
      {
        accessorKey: 'value',
        header: 'Value',
        cell: ({ row }) => {
          const value = row.original.value;
          const isLiability = row.original.type === 'liability';
          return (
            <span className={isLiability ? 'text-red-600 font-medium' : 'text-green-600 font-medium'}>
              {formatCurrency(Math.abs(value))}
            </span>
          );
        },
      },
      {
        accessorKey: 'account',
        header: 'Account',
      },
      {
        accessorKey: 'category',
        header: 'Category',
      },
      {
        accessorKey: 'type',
        header: 'Type',
        cell: ({ getValue }) => {
          const type = getValue();
          return (
            <span
              className={`px-2 py-1 text-xs font-medium rounded ${
                type === 'liability'
                  ? 'bg-red-100 text-red-800'
                  : 'bg-green-100 text-green-800'
              }`}
            >
              {type === 'liability' ? 'Liability' : 'Asset'}
            </span>
          );
        },
      },
    ],
    []
  );

  const table = useReactTable({
    data: items,
    columns,
    state: {
      sorting,
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  // Calculate account subtotals
  const accountTotals = useMemo(() => {
    const totals = {};
    items.forEach((item) => {
      if (!totals[item.account]) {
        totals[item.account] = 0;
      }
      totals[item.account] += item.value;
    });
    return Object.entries(totals).sort((a, b) => b[1] - a[1]);
  }, [items]);

  // Calculate category breakdown
  const categoryTotals = useMemo(() => {
    const totals = {};
    items.forEach((item) => {
      if (!totals[item.category]) {
        totals[item.category] = 0;
      }
      totals[item.category] += item.value;
    });
    return Object.entries(totals).sort((a, b) => b[1] - a[1]);
  }, [items]);

  return (
    <div className="space-y-6">
      {/* Holdings Table */}
      <div className="bg-white shadow-md rounded-lg">
        {/* Desktop Table View - Hidden on mobile */}
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
                    No holdings found.
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

        {/* Mobile Card View - Visible only on mobile */}
        <div className="md:hidden divide-y divide-gray-200">
          {table.getRowModel().rows.length === 0 ? (
            <div className="px-4 py-8 text-center text-gray-500">
              No holdings found.
            </div>
          ) : (
            table.getRowModel().rows.map((row) => (
              <div key={row.id} className="p-4 hover:bg-gray-50 active:bg-gray-100">
                <div className="space-y-2">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-semibold text-gray-900">{row.original.name}</div>
                      <div className="text-sm text-gray-600">{row.original.ticker || '-'}</div>
                    </div>
                    <span className={`px-2 py-1 text-xs font-medium rounded ${
                      row.original.type === 'liability'
                        ? 'bg-red-100 text-red-800'
                        : 'bg-green-100 text-green-800'
                    }`}>
                      {row.original.type === 'liability' ? 'Liability' : 'Asset'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <span className="text-gray-500">Account:</span>
                      <div className="font-medium text-gray-900">{row.original.account}</div>
                    </div>
                    <div>
                      <span className="text-gray-500">Category:</span>
                      <div className="font-medium text-gray-900">{row.original.category}</div>
                    </div>
                  </div>
                  <div className="pt-2 border-t border-gray-100">
                    <span className={`text-lg font-bold ${
                      row.original.type === 'liability' ? 'text-red-600' : 'text-green-600'
                    }`}>
                      {formatCurrency(Math.abs(row.original.value))}
                    </span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Account Subtotals and Category Breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Account Subtotals */}
        <div className="bg-white shadow-md rounded-lg p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Account Subtotals</h3>
          <div className="space-y-2">
            {accountTotals.map(([account, total]) => (
              <div key={account} className="flex justify-between items-center">
                <span className="text-gray-700">{account}</span>
                <span className={`font-medium ${total < 0 ? 'text-red-600' : 'text-green-600'}`}>
                  {formatCurrency(total)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Category Breakdown */}
        <div className="bg-white shadow-md rounded-lg p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Category Breakdown</h3>
          <div className="space-y-2">
            {categoryTotals.map(([category, total]) => (
              <div key={category} className="flex justify-between items-center">
                <span className="text-gray-700">{category}</span>
                <span className={`font-medium ${total < 0 ? 'text-red-600' : 'text-green-600'}`}>
                  {formatCurrency(total)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default DashboardTable;
