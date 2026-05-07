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
import { holdings as holdingsAPI, accounts as accountsAPI } from '../utils/api';
import { formatCurrency } from '../utils/format';
import HoldingForm from '../components/HoldingForm';

const LIABILITY_TYPES = new Set(['credit', 'loan']);

const LiabilitiesPage = () => {
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
    if (holding.is_plaid_managed) return;
    setEditingHolding(holding);
    setIsFormOpen(true);
  };

  const handleSave = async (data) => {
    if (editingHolding) {
      await holdingsAPI.update(editingHolding.id, data);
      showSuccess('Liability updated');
    } else {
      await holdingsAPI.create(data);
      showSuccess('Liability added');
    }
    await fetchData();
    setIsFormOpen(false);
  };

  const handleDelete = async (id) => {
    try {
      await holdingsAPI.delete(id);
      showSuccess('Entry deleted');
      setIsFormOpen(false);
      setEditingHolding(null);
      await fetchData();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete');
    }
  };

  const liabilityAccounts = useMemo(() => {
    return accounts.filter((a) => LIABILITY_TYPES.has(a.type));
  }, [accounts]);

  const liabilityAccountIds = useMemo(() => {
    return new Set(liabilityAccounts.map((a) => a.id));
  }, [liabilityAccounts]);

  const filteredData = useMemo(() => {
    let data = holdings.filter((h) => liabilityAccountIds.has(h.account_id));
    if (accountFilter) data = data.filter((h) => h.account_id === parseInt(accountFilter));
    return data;
  }, [holdings, liabilityAccountIds, accountFilter]);

  const { totalCredit, totalLoans, totalLiabilities } = useMemo(() => {
    let credit = 0;
    let loans = 0;
    const accountTypeMap = new Map(accounts.map((a) => [a.id, a.type]));

    filteredData.forEach((h) => {
      const value = Math.abs(parseFloat(h.current_value ?? h.manual_value) || 0);
      const type = accountTypeMap.get(h.account_id);
      if (type === 'credit') credit += value;
      else loans += value;
    });

    return { totalCredit: credit, totalLoans: loans, totalLiabilities: credit + loans };
  }, [filteredData, accounts]);

  const columns = useMemo(
    () => [
      {
        accessorKey: 'account_name',
        header: 'Account',
      },
      {
        accessorKey: 'name',
        header: 'Name',
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <span>{row.original.name}</span>
            {row.original.is_plaid_managed && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full bg-accent/10 text-accent border border-accent/20">
                <Link2 size={10} />
                Plaid
              </span>
            )}
          </div>
        ),
      },
      {
        id: 'value',
        accessorFn: (row) => Math.abs(parseFloat(row.current_value ?? row.manual_value) || 0),
        header: 'Owed',
        cell: ({ getValue }) => {
          const v = getValue();
          return <span className="font-mono text-base font-semibold text-loss">{formatCurrency(v)}</span>;
        },
      },
      {
        id: 'type',
        accessorFn: (row) => {
          const acct = accounts.find((a) => a.id === row.account_id);
          return acct?.type === 'credit' ? 'Credit' : 'Loan';
        },
        header: 'Type',
        cell: ({ getValue }) => <span className="text-secondary">{getValue()}</span>,
      },
    ],
    [accounts]
  );

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
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-xl text-secondary">Loading...</div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-2 md:py-4">
      <div className="mb-3">
        <h1 className="text-xl font-bold text-primary mb-3">Liabilities</h1>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div className="card p-4 md:p-5">
            <h3 className="text-xs uppercase tracking-wider text-secondary">Credit</h3>
            <p className="mt-2 text-xl font-mono font-bold text-loss">
              {formatCurrency(totalCredit)}
            </p>
          </div>
          <div className="card p-4 md:p-5">
            <h3 className="text-xs uppercase tracking-wider text-secondary">Loans</h3>
            <p className="mt-2 text-xl font-mono font-bold text-loss">
              {formatCurrency(totalLoans)}
            </p>
          </div>
          <div className="card p-4 md:p-5">
            <h3 className="text-xs uppercase tracking-wider text-secondary">Total Owed</h3>
            <p className="mt-2 text-xl font-mono font-bold text-loss">
              {formatCurrency(totalLiabilities)}
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

        <div className="flex flex-col sm:flex-row flex-wrap gap-3 items-stretch sm:items-center mb-3">
          <button
            onClick={handleAddNew}
            className="px-4 py-2 bg-accent text-inverse hover:bg-accent-hover rounded-md min-h-[44px] touch-manipulation"
          >
            Add Liability
          </button>
        </div>

        {liabilityAccounts.length > 1 && (
          <div className="flex flex-wrap gap-2 mb-2 items-center">
            <span className="text-xs font-medium text-secondary uppercase tracking-wider mr-1">Account:</span>
            <button
              onClick={() => setAccountFilter('')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors touch-manipulation min-h-[36px] ${
                accountFilter === ''
                  ? 'bg-accent text-inverse'
                  : 'bg-surface-3 text-secondary border border-border hover:text-primary'
              }`}
            >
              All
            </button>
            {liabilityAccounts.map((account) => (
              <button
                key={account.id}
                onClick={() => setAccountFilter(accountFilter === String(account.id) ? '' : String(account.id))}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors touch-manipulation min-h-[36px] ${
                  accountFilter === String(account.id)
                    ? 'bg-accent text-inverse'
                    : 'bg-surface-3 text-secondary border border-border hover:text-primary'
                }`}
              >
                {account.name}
              </button>
            ))}
          </div>
        )}
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
                    No liabilities found. Add a credit or loan account to get started.
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className={`border-b border-border ${
                      row.original.is_plaid_managed
                        ? 'hover:bg-surface-2'
                        : 'hover:bg-surface-3 cursor-pointer'
                    }`}
                    onClick={() => !row.original.is_plaid_managed && handleEdit(row.original)}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-4 py-1.5 whitespace-nowrap text-sm text-primary">
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
              No liabilities found.
            </div>
          ) : (
            table.getRowModel().rows.map((row) => {
              const value = Math.abs(parseFloat(row.original.current_value ?? row.original.manual_value ?? 0));
              const acct = accounts.find((a) => a.id === row.original.account_id);
              return (
                <div
                  key={row.id}
                  className={`card p-3 touch-manipulation ${
                    row.original.is_plaid_managed ? '' : 'active:bg-surface-3 cursor-pointer'
                  }`}
                  onClick={() => !row.original.is_plaid_managed && handleEdit(row.original)}
                >
                  <div className="flex justify-between items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-primary truncate">{row.original.name}</div>
                      <div className="text-sm text-secondary">
                        {row.original.account_name} - {acct?.type === 'credit' ? 'Credit' : 'Loan'}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-lg font-bold font-mono text-loss">
                        {formatCurrency(value)}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {filteredData.length > 25 && (
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
        onDelete={handleDelete}
        holding={editingHolding}
        accounts={liabilityAccounts}
      />
    </div>
  );
};

export default LiabilitiesPage;
