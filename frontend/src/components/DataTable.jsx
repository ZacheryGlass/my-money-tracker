import React from 'react';
import { flexRender } from '@tanstack/react-table';

// Shared shell for TanStack tables: desktop table in a card with sortable
// headers, optional stacked mobile rows, and pagination controls. Column
// sizing/alignment comes from columnDef.meta: { width, align, headerClassName,
// cellClassName }. Without renderMobileRow the whole card is hidden below lg —
// pages provide their own mobile layout (and should hide desktop-only
// pagination the same way).
const DataTable = ({ table, columns, emptyMessage, onRowClick, rowClassName, renderMobileRow }) => {
  const rows = table.getRowModel().rows;

  return (
    <div className={`card w-full min-w-0 overflow-hidden ${renderMobileRow ? '' : 'hidden lg:block'}`}>
      <div className="hidden max-w-full overflow-hidden lg:block">
        <table className="w-full table-fixed divide-y divide-border">
          <colgroup>
            {columns.map((column, index) => (
              <col
                key={column.id || column.accessorKey || index}
                style={column.meta?.width ? { width: column.meta.width } : undefined}
              />
            ))}
          </colgroup>
          <thead className="bg-surface-2">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const meta = header.column.columnDef.meta || {};
                  return (
                    <th
                      key={header.id}
                      className={`px-3 py-2 text-left text-caption font-semibold uppercase tracking-wide text-tertiary transition-colors hover:bg-surface-3 ${
                        header.column.getCanSort() ? 'cursor-pointer' : ''
                      } ${meta.headerClassName || ''}`}
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      <div className={`flex items-center gap-1 ${meta.align === 'right' ? 'justify-end' : ''}`}>
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getIsSorted() && (
                          <span className="text-accent">{header.column.getIsSorted() === 'asc' ? '↑' : '↓'}</span>
                        )}
                      </div>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-border bg-surface">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-10 text-center text-body-sm text-tertiary">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.id}
                  className={`transition-colors hover:bg-surface-2 ${
                    rowClassName ? rowClassName(row.original) : onRowClick ? 'cursor-pointer' : ''
                  }`}
                  onClick={() => onRowClick?.(row.original)}
                >
                  {row.getVisibleCells().map((cell) => {
                    const meta = cell.column.columnDef.meta || {};
                    return (
                      <td
                        key={cell.id}
                        className={`px-3 py-2 align-middle text-body-sm text-secondary ${meta.cellClassName || 'whitespace-nowrap'}`}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {renderMobileRow && (
        <div className="divide-y divide-border lg:hidden">
          {rows.length === 0 ? (
            <div className="px-3 py-8 text-center text-body-sm text-tertiary">{emptyMessage}</div>
          ) : (
            rows.map((row) => renderMobileRow(row))
          )}
        </div>
      )}
    </div>
  );
};

// Renders nothing until the row count exceeds the page size.
export const DataTablePagination = ({ table, total, className = '' }) => {
  if (total <= table.getState().pagination.pageSize) return null;
  return (
    <div className={`mt-3 flex items-center justify-between ${className}`}>
      <div className="flex items-center gap-2">
        <span className="text-caption text-tertiary">Rows:</span>
        <select
          value={table.getState().pagination.pageSize}
          onChange={(e) => {
            table.setPageIndex(0);
            table.setPageSize(Number(e.target.value));
          }}
          className="rounded border border-border bg-surface-3 px-2 py-1 text-caption text-secondary"
        >
          {[10, 25, 50, 100].map((size) => (
            <option key={size} value={size}>{size}</option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-caption text-tertiary">
          Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
        </span>
        <button
          onClick={() => table.previousPage()}
          disabled={!table.getCanPreviousPage()}
          className="rounded border border-border bg-surface-3 px-2 py-1 text-caption text-secondary disabled:opacity-30"
        >
          Prev
        </button>
        <button
          onClick={() => table.nextPage()}
          disabled={!table.getCanNextPage()}
          className="rounded border border-border bg-surface-3 px-2 py-1 text-caption text-secondary disabled:opacity-30"
        >
          Next
        </button>
      </div>
    </div>
  );
};

export default DataTable;
