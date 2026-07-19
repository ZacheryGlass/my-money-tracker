import React, { useMemo, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useReactTable, getCoreRowModel, getPaginationRowModel } from '@tanstack/react-table';
import DataTable, { DataTablePagination } from './DataTable';

function Harness({ rowCount, onRowClick }) {
  const data = useMemo(
    () => Array.from({ length: rowCount }, (_, i) => ({ id: i, name: `Row ${i}` })),
    [rowCount]
  );
  const columns = useMemo(() => [{ accessorKey: 'name', header: 'Name' }], []);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 });
  const table = useReactTable({
    data,
    columns,
    state: { pagination },
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  return (
    <>
      <DataTable table={table} columns={columns} emptyMessage="Nothing here." onRowClick={onRowClick} />
      <DataTablePagination table={table} total={rowCount} />
    </>
  );
}

describe('DataTable', () => {
  it('pages rows and shows controls when rows exceed the page size', () => {
    render(<Harness rowCount={30} />);

    expect(screen.getByText('Row 0')).toBeInTheDocument();
    expect(screen.queryByText('Row 25')).toBeNull();
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
    expect(screen.getByText('Row 25')).toBeInTheDocument();
  });

  it('hides pagination when all rows fit on one page', () => {
    render(<Harness rowCount={5} />);
    expect(screen.queryByText(/Page 1 of/)).toBeNull();
  });

  it('invokes onRowClick with the row data and shows the empty message', () => {
    const onRowClick = vi.fn();
    const { unmount } = render(<Harness rowCount={5} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByText('Row 2'));
    expect(onRowClick).toHaveBeenCalledWith({ id: 2, name: 'Row 2' });
    unmount();

    render(<Harness rowCount={0} />);
    expect(screen.getByText('Nothing here.')).toBeInTheDocument();
  });
});
