import React, { useMemo } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
} from '@tanstack/react-table';
import { formatCurrency } from '../utils/format';

const DashboardTable = ({ items }) => {
  const [sorting, setSorting] = React.useState([{ id: 'value', desc: true }]);

  const columns = useMemo(
    () => [
      { accessorKey: 'name', header: 'Name' },
      {
        accessorKey: 'ticker',
        header: 'Ticker',
        cell: ({ getValue }) => (
          <span className="font-mono text-secondary">{getValue() || '-'}</span>
        ),
      },
      {
        accessorKey: 'value',
        header: 'Value',
        cell: ({ row }) => {
          const value = row.original.value;
          const isLiability = row.original.type === 'liability';
          return (
            <span className={`font-mono font-medium ${isLiability ? 'text-loss' : 'text-gain'}`}>
              {formatCurrency(Math.abs(value))}
            </span>
          );
        },
      },
      { accessorKey: 'account', header: 'Account' },
      {
        accessorKey: 'category',
        header: 'Category',
        cell: ({ getValue }) => <span className="text-secondary">{getValue() || '-'}</span>,
      },
      {
        accessorKey: 'type',
        header: 'Type',
        cell: ({ getValue }) => {
          const type = getValue();
          return (
            <span
              className={`px-2 py-0.5 text-xs font-medium rounded ${
                type === 'liability' ? 'bg-loss-bg text-loss' : 'bg-gain-bg text-gain'
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
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const accountTotals = useMemo(() => {
    const totals = {};
    items.forEach((item) => {
      if (!totals[item.account]) totals[item.account] = 0;
      totals[item.account] += item.value;
    });
    return Object.entries(totals).sort((a, b) => b[1] - a[1]);
  }, [items]);

  const categoryTotals = useMemo(() => {
    const totals = {};
    items.forEach((item) => {
      if (!totals[item.category]) totals[item.category] = 0;
      totals[item.category] += item.value;
    });
    return Object.entries(totals).sort((a, b) => b[1] - a[1]);
  }, [items]);

  return (
    <div className="space-y-6">
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
                          <span>{header.column.getIsSorted() === 'asc' ? '↑' : '↓'}</span>
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
                    No holdings found.
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className="hover:bg-surface-3">
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-6 py-4 whitespace-nowrap text-sm text-primary">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile Card View */}
        <div className="md:hidden divide-y divide-border">
          {table.getRowModel().rows.length === 0 ? (
            <div className="px-4 py-8 text-center text-secondary">No holdings found.</div>
          ) : (
            table.getRowModel().rows.map((row) => (
              <div key={row.id} className="p-4 hover:bg-surface-3">
                <div className="space-y-2">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-semibold text-primary">{row.original.name}</div>
                      <div className="text-sm font-mono text-secondary">{row.original.ticker || '-'}</div>
                    </div>
                    <span
                      className={`px-2 py-0.5 text-xs font-medium rounded ${
                        row.original.type === 'liability' ? 'bg-loss-bg text-loss' : 'bg-gain-bg text-gain'
                      }`}
                    >
                      {row.original.type === 'liability' ? 'Liability' : 'Asset'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <span className="text-tertiary text-xs">Account</span>
                      <div className="text-primary">{row.original.account}</div>
                    </div>
                    <div>
                      <span className="text-tertiary text-xs">Category</span>
                      <div className="text-primary">{row.original.category}</div>
                    </div>
                  </div>
                  <div className="pt-2 border-t border-border">
                    <span className={`text-lg font-bold font-mono ${row.original.type === 'liability' ? 'text-loss' : 'text-gain'}`}>
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
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card p-5">
          <h3 className="text-[10px] font-semibold tracking-widest uppercase text-secondary mb-4">
            Account Subtotals
          </h3>
          <div className="space-y-2">
            {accountTotals.map(([account, total]) => (
              <div key={account} className="flex justify-between items-center">
                <span className="text-secondary text-sm">{account}</span>
                <span className={`font-mono text-sm font-medium ${total < 0 ? 'text-loss' : 'text-gain'}`}>
                  {formatCurrency(total)}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="card p-5">
          <h3 className="text-[10px] font-semibold tracking-widest uppercase text-secondary mb-4">
            Category Breakdown
          </h3>
          <div className="space-y-2">
            {categoryTotals.map(([category, total]) => (
              <div key={category} className="flex justify-between items-center">
                <span className="text-secondary text-sm">{category}</span>
                <span className={`font-mono text-sm font-medium ${total < 0 ? 'text-loss' : 'text-gain'}`}>
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
