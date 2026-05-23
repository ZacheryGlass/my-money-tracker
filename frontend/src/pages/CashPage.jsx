import React, { useState, useEffect, useMemo } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  flexRender,
} from '@tanstack/react-table';
import { motion as Motion } from 'framer-motion';
import { Wallet, Plus, Link2, Filter, Check, X } from 'lucide-react';
import { holdings as holdingsAPI, accounts as accountsAPI } from '../utils/api';
import { formatCurrency } from '../utils/format';
import HoldingForm from '../components/HoldingForm';
import { getAccountDisplayName } from '../utils/accountDisplay';

const CASH_TYPES = new Set(['depository']);

const CashPage = () => {
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
      showSuccess('Cash account updated');
    } else {
      await holdingsAPI.create(data);
      showSuccess('Cash account added');
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

  const cashAccounts = useMemo(() => {
    return accounts.filter((a) => CASH_TYPES.has(a.type));
  }, [accounts]);

  const cashAccountIds = useMemo(() => {
    return new Set(cashAccounts.map((a) => a.id));
  }, [cashAccounts]);

  const filteredData = useMemo(() => {
    let data = holdings.filter((h) => cashAccountIds.has(h.account_id));
    if (accountFilter) data = data.filter((h) => h.account_id === parseInt(accountFilter));
    return data;
  }, [holdings, cashAccountIds, accountFilter]);

  const totalCash = useMemo(() => {
    return filteredData.reduce((sum, h) => sum + (parseFloat(h.current_value) || 0), 0);
  }, [filteredData]);

  const columns = useMemo(
    () => [
      {
        accessorKey: 'account_name',
        header: 'Institution',
        cell: ({ getValue }) => <span className="text-xs font-bold text-secondary uppercase tracking-tight">{getValue()}</span>,
      },
      {
        accessorKey: 'name',
        header: 'Account Name',
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <span className="font-bold text-primary">{row.original.name}</span>
            {row.original.is_plaid_managed && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded-full bg-accent/10 text-accent border border-accent/20">
                <Link2 size={10} />
                Linked
              </span>
            )}
          </div>
        ),
      },
      {
        id: 'value',
        accessorFn: (row) => row.current_value ?? row.manual_value ?? 0,
        header: 'Balance',
        cell: ({ getValue }) => {
          const v = parseFloat(getValue()) || 0;
          return <span className="font-money text-sm font-bold text-gain">{formatCurrency(v)}</span>;
        },
      },
      {
        accessorKey: 'category',
        header: 'Type',
        cell: ({ getValue }) => {
          const value = getValue();
          return <span className="text-[10px] font-bold uppercase text-tertiary tracking-widest">{value || 'Depository'}</span>;
        },
      },
    ],
    []
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
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <div className="w-10 h-10 border-4 border-accent border-t-transparent rounded-full animate-spin shadow-glow" />
        <span className="text-xs font-bold tracking-widest uppercase text-tertiary animate-pulse">Auditing Cash</span>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 md:py-8">
      {/* Hero Section */}
      <div className="flex flex-col md:flex-row md:items-end justify-between mb-10 gap-6">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Wallet className="text-accent w-5 h-5" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-secondary">Liquidity Overview</span>
          </div>
          <h1 className="text-3xl md:text-5xl font-bold text-primary tracking-tighter leading-none mb-2">
            {formatCurrency(totalCash)}
          </h1>
          <p className="text-sm text-secondary">Total liquid capital across {cashAccounts.length} depository accounts</p>
        </div>

        <div className="flex items-center gap-4">
          <div className="p-4 bg-surface-2 border border-border rounded-2xl shadow-sm min-w-[120px]">
            <p className="text-[10px] font-bold text-tertiary uppercase tracking-widest mb-1">Accounts</p>
            <p className="text-lg font-mono font-bold text-primary">{cashAccounts.length}</p>
          </div>
          <button
            onClick={handleAddNew}
            className="flex items-center gap-2 px-6 py-4 bg-accent text-inverse hover:bg-accent-hover rounded-lg text-sm font-bold transition-all shadow-glow"
          >
            <Plus size={18} />
            <span>Add Entry</span>
          </button>
        </div>
      </div>

      <div className="mb-5 rounded-2xl border border-border bg-surface overflow-hidden">
        <div className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2 shrink-0">
            <Filter size={16} className="text-accent" />
            <span className="text-sm font-bold uppercase tracking-widest text-primary">Accounts</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setAccountFilter('')}
              className={`flex items-center gap-2 rounded-xl border px-3 py-2 transition-all ${
                accountFilter === ''
                  ? 'bg-accent/10 border-accent/30 text-accent ring-1 ring-accent/10'
                  : 'bg-surface-2 border-transparent text-secondary hover:border-border hover:text-primary'
              }`}
            >
              <span className="text-xs font-bold uppercase tracking-wider">All Accounts</span>
              {accountFilter === '' && <Check size={14} />}
            </button>
            {cashAccounts.map((account) => (
              <button
                key={account.id}
                onClick={() => setAccountFilter(String(account.id))}
                className={`flex items-center gap-2 rounded-xl border px-3 py-2 transition-all ${
                  accountFilter === String(account.id)
                    ? 'bg-accent/10 border-accent/30 text-accent ring-1 ring-accent/10'
                    : 'bg-surface-2 border-transparent text-secondary hover:border-border hover:text-primary'
                }`}
              >
                <span className="max-w-[220px] truncate text-xs font-bold uppercase tracking-wider">{getAccountDisplayName(account)}</span>
                {accountFilter === String(account.id) && <Check size={14} />}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-6">
          {error && (
            <div className="p-4 bg-loss-bg border border-loss/20 text-loss rounded-xl text-xs flex items-center gap-3">
              <X size={16} />
              {error}
            </div>
          )}

          {successMessage && (
            <Motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="p-4 bg-gain-bg border border-gain/20 text-gain rounded-xl text-xs flex items-center gap-3">
              <Check size={16} />
              {successMessage}
            </Motion.div>
          )}

          <div className="card overflow-hidden">
            <div className="hidden md:block overflow-x-auto">
              <table className="min-w-full divide-y divide-border">
                <thead className="bg-surface-2">
                  {table.getHeaderGroups().map((headerGroup) => (
                    <tr key={headerGroup.id}>
                      {headerGroup.headers.map((header) => (
                        <th
                          key={header.id}
                          className="px-5 py-4 text-left text-[10px] font-bold text-tertiary uppercase tracking-widest cursor-pointer hover:bg-surface-3 transition-colors"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          <div className="flex items-center gap-2">
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {header.column.getIsSorted() && (
                              <span className="text-accent">{header.column.getIsSorted() === 'asc' ? '↑' : '↓'}</span>
                            )}
                          </div>
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody className="divide-y divide-border bg-surface">
                  {table.getRowModel().rows.length === 0 ? (
                    <tr>
                      <td colSpan={columns.length} className="px-5 py-12 text-center text-tertiary text-sm font-medium">
                        No cash accounts found. Add a depository account to get started.
                      </td>
                    </tr>
                  ) : (
                    table.getRowModel().rows.map((row) => (
                      <tr
                        key={row.id}
                        className={`hover:bg-surface-2 transition-colors ${
                          row.original.is_plaid_managed ? '' : 'cursor-pointer'
                        }`}
                        onClick={() => !row.original.is_plaid_managed && handleEdit(row.original)}
                      >
                        {row.getVisibleCells().map((cell) => (
                          <td key={cell.id} className="px-5 py-3 whitespace-nowrap text-sm text-primary">
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Mobile View */}
            <div className="md:hidden space-y-3 p-4">
              {table.getRowModel().rows.length === 0 ? (
                <div className="py-8 text-center text-tertiary text-xs uppercase tracking-widest font-bold">No entries found</div>
              ) : (
                table.getRowModel().rows.map((row) => {
                  const value = parseFloat(row.original.current_value ?? row.original.manual_value ?? 0);
                  return (
                    <div
                      key={row.id}
                      className={`card p-4 border border-border/50 active:bg-surface-3 transition-all ${
                        row.original.is_plaid_managed ? '' : 'cursor-pointer'
                      }`}
                      onClick={() => !row.original.is_plaid_managed && handleEdit(row.original)}
                    >
                      <div className="flex justify-between items-start mb-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold text-primary truncate">{row.original.name}</p>
                          <p className="text-[10px] font-bold text-tertiary uppercase tracking-tight">{row.original.account_name}</p>
                        </div>
                        <p className="text-base font-money font-bold text-gain">{formatCurrency(value)}</p>
                      </div>
                      <div className="flex items-center gap-3 pt-2 border-t border-border/50">
                        <span className="text-[9px] font-bold uppercase tracking-widest text-tertiary">{row.original.category || 'Depository'}</span>
                        {row.original.is_plaid_managed && <Link2 size={10} className="text-accent" />}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="flex items-center justify-center gap-6 text-[10px] text-tertiary uppercase tracking-widest font-bold">
            <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-gain shadow-glow" /> Liquid Assets</span>
            <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-surface-3 border border-border" /> Immediate Access</span>
            <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-surface-3 border border-border" /> Depository Tracking</span>
          </div>
      </div>

      <HoldingForm
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        onSave={handleSave}
        onDelete={handleDelete}
        holding={editingHolding}
        accounts={cashAccounts}
      />
    </div>
  );
};

export default CashPage;
