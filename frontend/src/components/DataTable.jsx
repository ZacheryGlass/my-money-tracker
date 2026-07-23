import React from 'react';
import { flexRender } from '@tanstack/react-table';

// Where the desktop table takes over from the stacked mobile rows. Full class
// strings (never interpolated) so Tailwind's scanner keeps them.
const BREAKPOINTS = {
  md: { desktopOnly: 'hidden md:block', mobileOnly: 'md:hidden' },
  lg: { desktopOnly: 'hidden lg:block', mobileOnly: 'lg:hidden' },
};

const SORT_INDICATOR = { asc: '↑', desc: '↓' };

// Shared shell for TanStack tables: a card holding sortable headers, optional
// stacked mobile rows, and optional header/footer slots. Column sizing and
// alignment come from columnDef.meta: { width, align, headerClassName,
// cellClassName }.
//
// `mobile` picks the small-screen behaviour:
//   'rows'   renderMobileRow(row) below the breakpoint (the default whenever
//            renderMobileRow is supplied)
//   'table'  keep the table at every width — pair with columnVisibility to
//            drop columns on small screens
//   'hidden' hide the card entirely below the breakpoint (the default
//            otherwise); the page supplies its own mobile layout
const DataTable = ({
  table,
  emptyMessage,
  onRowClick,
  rowClassName,
  renderMobileRow,
  mobile = renderMobileRow ? 'rows' : 'hidden',
  breakpoint = 'lg',
  header,
  footer,
  bare = false,
  className = '',
}) => {
  const rows = table.getRowModel().rows;
  const visibleColumns = table.getVisibleLeafColumns();
  const { desktopOnly, mobileOnly } = BREAKPOINTS[breakpoint];

  return (
    <div
      className={`w-full min-w-0 overflow-hidden ${bare ? '' : 'card'} ${
        mobile === 'hidden' ? desktopOnly : ''
      } ${className}`}
    >
      {header}

      <div className={`max-w-full overflow-hidden ${mobile === 'table' ? '' : desktopOnly}`}>
        {/* table-fixed takes its widths from the header row, so meta.width
            lands on the <th>. A <colgroup> would reserve space for columns a
            headerClassName has hidden at this breakpoint. */}
        <table className="w-full table-fixed divide-y divide-border">
          <thead className="bg-surface-2">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const meta = header.column.columnDef.meta || {};
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  const toggleSort = header.column.getToggleSortingHandler();
                  return (
                    <th
                      key={header.id}
                      style={meta.width ? { width: meta.width } : undefined}
                      aria-sort={sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : undefined}
                      tabIndex={canSort ? 0 : undefined}
                      className={`px-3 py-2 text-left text-caption font-semibold uppercase tracking-wide text-tertiary transition-colors hover:bg-surface-3 ${
                        canSort ? 'cursor-pointer' : ''
                      } ${meta.headerClassName || ''}`}
                      onClick={toggleSort}
                      onKeyDown={canSort ? (event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        toggleSort(event);
                      } : undefined}
                    >
                      <div className={`flex items-center gap-1 ${meta.align === 'right' ? 'justify-end' : ''}`}>
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sorted && <span className="text-accent">{SORT_INDICATOR[sorted]}</span>}
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
                <td colSpan={visibleColumns.length} className="px-3 py-10 text-center text-body-sm text-tertiary">
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

      {mobile === 'rows' && renderMobileRow && (
        <div className={`divide-y divide-border ${mobileOnly}`}>
          {rows.length === 0 ? (
            <div className="px-3 py-8 text-center text-body-sm text-tertiary">{emptyMessage}</div>
          ) : (
            rows.map((row) => renderMobileRow(row))
          )}
        </div>
      )}

      {footer}
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
