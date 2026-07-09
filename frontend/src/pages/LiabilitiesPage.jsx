import React, { useState, useEffect, useMemo } from 'react';
import {
  useReactTable, getCoreRowModel, getSortedRowModel, getFilteredRowModel, getPaginationRowModel, flexRender,
} from '@tanstack/react-table';
import { Plus, Link2, Check, X } from 'lucide-react';
import { holdings as holdingsAPI, accounts as accountsAPI } from '../utils/api';
import { formatCurrency } from '../utils/format';
import HoldingForm from '../components/HoldingForm';
import { buildAccountDisplayNameMap, getAccountDisplayName } from '../utils/accountDisplay';

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

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [holdingsData, accountsData] = await Promise.all([holdingsAPI.getAll(), accountsAPI.getAll()]);
      setHoldings(holdingsData.holdings || []); setAccounts(accountsData.accounts || []); setError(null);
    } catch (err) { setError(err.response?.data?.error || 'Failed to load data'); }
    finally { setLoading(false); }
  };

  const showSuccess = (message) => { setSuccessMessage(message); setTimeout(() => setSuccessMessage(''), 3000); };
  const handleAddNew = () => { setEditingHolding(null); setIsFormOpen(true); };
  const handleEdit = (holding) => { if (holding.is_plaid_managed) return; setEditingHolding(holding); setIsFormOpen(true); };

  const handleSave = async (data) => {
    if (editingHolding) { await holdingsAPI.update(editingHolding.id, data); showSuccess('Liability updated'); }
    else { await holdingsAPI.create(data); showSuccess('Liability added'); }
    await fetchData(); setIsFormOpen(false);
  };

  const handleDelete = async (id) => {
    try { await holdingsAPI.delete(id); showSuccess('Entry deleted'); setIsFormOpen(false); setEditingHolding(null); await fetchData(); }
    catch (err) { setError(err.response?.data?.error || 'Failed to delete'); }
  };

  const liabilityAccounts = useMemo(() => accounts.filter((a) => LIABILITY_TYPES.has(a.type)), [accounts]);
  const liabilityAccountIds = useMemo(() => new Set(liabilityAccounts.map((a) => a.id)), [liabilityAccounts]);
  const accountsMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const accountDisplayNames = useMemo(() => buildAccountDisplayNameMap(accounts), [accounts]);
  const displayAccountName = useMemo(
    () => (account) => account ? accountDisplayNames.get(account.id) || getAccountDisplayName(account) : 'Account',
    [accountDisplayNames]
  );

  const filteredData = useMemo(() => {
    let data = holdings.filter((h) => liabilityAccountIds.has(h.account_id));
    if (accountFilter) data = data.filter((h) => h.account_id === parseInt(accountFilter));
    return data;
  }, [holdings, liabilityAccountIds, accountFilter]);

  const { totalCredit, totalLoans, totalLiabilities } = useMemo(() => {
    let credit = 0, loans = 0;
    filteredData.forEach((h) => {
      const value = Math.abs(parseFloat(h.current_value ?? h.manual_value) || 0);
      const type = accountsMap.get(h.account_id)?.type;
      if (type === 'credit') credit += value; else loans += value;
    });
    return { totalCredit: credit, totalLoans: loans, totalLiabilities: credit + loans };
  }, [filteredData, accountsMap]);

  const columns = useMemo(() => [
    {
      id: 'account',
      accessorFn: (row) => displayAccountName(accountsMap.get(row.account_id)) || row.account_name || 'Account',
      header: 'Institution',
      cell: ({ getValue }) => <span className="text-caption text-tertiary uppercase">{getValue()}</span>,
    },
    { accessorKey: 'name', header: 'Account Name', cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <span className="font-semibold text-primary">{row.original.name}</span>
        {row.original.is_plaid_managed && <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-caption bg-accent-muted text-accent border border-accent/20"><Link2 size={10} />Linked</span>}
      </div>
    )},
    { id: 'value', accessorFn: (row) => Math.abs(parseFloat(row.current_value ?? row.manual_value) || 0), header: 'Owed',
      cell: ({ getValue }) => <span className="font-mono font-semibold text-loss">{formatCurrency(getValue())}</span> },
    { id: 'type', accessorFn: (row) => accountsMap.get(row.account_id)?.type === 'credit' ? 'Credit' : 'Loan',
      header: 'Type', cell: ({ getValue }) => <span className="text-caption text-tertiary uppercase">{getValue()}</span> },
  ], [accountsMap, displayAccountName]);

  const table = useReactTable({ data: filteredData, columns, state: { sorting, pagination }, onSortingChange: setSorting, onPaginationChange: setPagination, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(), getFilteredRowModel: getFilteredRowModel(), getPaginationRowModel: getPaginationRowModel() });

  if (loading) {
    return <div className="flex flex-col items-center justify-center min-h-[400px] gap-3"><div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" /><span className="text-caption text-tertiary">Loading...</span></div>;
  }

  return (
    <div className="px-4 py-4">
      <div className="flex flex-col md:flex-row md:items-end justify-between mb-4 gap-4">
        <div>
          <p className="text-caption text-tertiary uppercase tracking-wide mb-0.5">Liabilities</p>
          <h1 className="text-display-lg font-money text-primary">{formatCurrency(totalLiabilities)}</h1>
          <p className="text-body-sm text-tertiary">{liabilityAccounts.length} accounts</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="border border-border bg-surface-3 p-2">
            <p className="text-caption text-tertiary uppercase mb-0.5">Credit Cards</p>
            <p className="font-mono font-semibold text-loss">{formatCurrency(totalCredit)}</p>
          </div>
          <div className="border border-border bg-surface-3 p-2">
            <p className="text-caption text-tertiary uppercase mb-0.5">Loans</p>
            <p className="font-mono font-semibold text-loss">{formatCurrency(totalLoans)}</p>
          </div>
          <button onClick={handleAddNew} className="flex items-center gap-1.5 px-3 py-1.5 bg-accent text-white rounded text-button font-semibold hover:bg-accent-hover">
            <Plus size={14} /> Add Entry
          </button>
        </div>
      </div>

      <div className="card mb-4">
        <div className="flex flex-wrap gap-1 p-3">
          <button onClick={() => setAccountFilter('')} className={`flex items-center gap-1.5 border px-2 py-1 text-caption transition-colors ${accountFilter === '' ? 'bg-accent-muted border-accent/30 text-accent' : 'bg-surface border-border text-tertiary hover:text-secondary'}`}>
            All Accounts {accountFilter === '' && <Check size={12} />}
          </button>
          {liabilityAccounts.map((account) => (
            <button key={account.id} onClick={() => setAccountFilter(String(account.id))} className={`flex items-center gap-1.5 border px-2 py-1 text-caption transition-colors ${accountFilter === String(account.id) ? 'bg-accent-muted border-accent/30 text-accent' : 'bg-surface border-border text-tertiary hover:text-secondary'}`}>
              <span className="max-w-[200px] truncate">{displayAccountName(account)}</span>
              {accountFilter === String(account.id) && <Check size={12} />}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="p-2 bg-loss-bg border border-loss/20 text-loss text-body-sm flex items-center gap-2 mb-3"><X size={14} />{error}</div>}
      {successMessage && <div className="p-2 bg-gain-bg border border-gain/20 text-gain text-body-sm flex items-center gap-2 mb-3"><Check size={14} />{successMessage}</div>}

      <div className="card overflow-hidden">
        <div className="hidden md:block overflow-x-auto">
          <table className="min-w-full divide-y divide-border">
            <thead className="bg-surface-2">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((header) => (
                    <th key={header.id} className="px-3 py-2 text-left text-caption font-semibold text-tertiary uppercase tracking-wide cursor-pointer hover:bg-surface-3" onClick={header.column.getToggleSortingHandler()}>
                      <div className="flex items-center gap-1">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getIsSorted() && <span className="text-accent">{header.column.getIsSorted() === 'asc' ? '↑' : '↓'}</span>}
                      </div>
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody className="divide-y divide-border">
              {table.getRowModel().rows.length === 0 ? (
                <tr><td colSpan={columns.length} className="px-3 py-8 text-center text-tertiary text-body-sm">No liabilities found.</td></tr>
              ) : table.getRowModel().rows.map((row) => (
                <tr key={row.id} className={`hover:bg-surface-2 transition-colors ${row.original.is_plaid_managed ? '' : 'cursor-pointer'}`} onClick={() => !row.original.is_plaid_managed && handleEdit(row.original)}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2 whitespace-nowrap text-body-sm">{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="md:hidden divide-y divide-border">
          {table.getRowModel().rows.map((row) => {
            const value = Math.abs(parseFloat(row.original.current_value ?? row.original.manual_value ?? 0));
            return (
              <div key={row.id} className={`p-3 ${row.original.is_plaid_managed ? '' : 'cursor-pointer hover:bg-surface-2'}`} onClick={() => !row.original.is_plaid_managed && handleEdit(row.original)}>
                <div className="flex justify-between items-start">
                  <div className="flex-1 min-w-0">
                    <p className="text-body-sm font-semibold text-primary truncate">{row.original.name}</p>
                    <p className="text-caption text-tertiary">{displayAccountName(accountsMap.get(row.original.account_id))}</p>
                  </div>
                  <p className="font-mono font-semibold text-loss">{formatCurrency(value)}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <HoldingForm isOpen={isFormOpen} onClose={() => setIsFormOpen(false)} onSave={handleSave} onDelete={handleDelete} holding={editingHolding} accounts={liabilityAccounts} />
    </div>
  );
};

export default LiabilitiesPage;
