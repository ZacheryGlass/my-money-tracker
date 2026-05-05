import React, { useState, useEffect, useMemo } from 'react';
import { expenses as expensesAPI } from '../utils/api';
import { formatCurrency } from '../utils/format';
import MetricCard from '../components/MetricCard';

const Badge = ({ active, children }) => (
  <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold tracking-wider uppercase ${
    active ? 'bg-gain-bg text-gain' : 'bg-surface-3 text-tertiary'
  }`}>
    {children}
  </span>
);

const MonthlyExpenses = () => {
  const [allExpenses, setAllExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState('');
  const [activeTab, setActiveTab] = useState('bill');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState(null);
  const [deletingExpense, setDeletingExpense] = useState(null);
  const [formData, setFormData] = useState({
    type: 'bill', name: '', cost: '', is_fixed_rate: true, is_autopay: false,
    pay_account: '', company: '', who_uses: '', notes: '',
  });

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const data = await expensesAPI.getAll();
      setAllExpenses(data.expenses || []);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load expenses');
    } finally {
      setLoading(false);
    }
  };

  const showSuccess = (msg) => {
    setSuccessMessage(msg);
    setTimeout(() => setSuccessMessage(''), 3000);
  };

  const handleAddNew = () => {
    setEditingExpense(null);
    setFormData({
      type: activeTab, name: '', cost: '', is_fixed_rate: true, is_autopay: false,
      pay_account: '', company: '', who_uses: '', notes: '',
    });
    setIsFormOpen(true);
  };

  const handleEdit = (expense) => {
    setEditingExpense(expense);
    setFormData({
      type: expense.type,
      name: expense.name || '',
      cost: expense.cost ?? '',
      is_fixed_rate: expense.is_fixed_rate ?? true,
      is_autopay: expense.is_autopay ?? false,
      pay_account: expense.pay_account || '',
      company: expense.company || '',
      who_uses: expense.who_uses || '',
      notes: expense.notes || '',
    });
    setIsFormOpen(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    const payload = {
      ...formData,
      cost: parseFloat(formData.cost) || 0,
      pay_account: formData.pay_account || null,
      company: formData.company || null,
      who_uses: formData.who_uses || null,
      notes: formData.notes || null,
    };

    try {
      if (editingExpense) {
        await expensesAPI.update(editingExpense.id, payload);
        showSuccess('Expense updated');
      } else {
        await expensesAPI.create(payload);
        showSuccess('Expense created');
      }
      await fetchData();
      setIsFormOpen(false);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save');
    }
  };

  const handleDeleteConfirm = async () => {
    try {
      await expensesAPI.delete(deletingExpense.id);
      showSuccess('Expense deleted');
      await fetchData();
      setDeletingExpense(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete');
      setDeletingExpense(null);
    }
  };

  const { totalBills, totalSubs, totalAll, billCount, subCount, filtered } = useMemo(() => {
    let bills = 0, subs = 0, bc = 0, sc = 0;
    allExpenses.forEach((e) => {
      const c = parseFloat(e.cost) || 0;
      if (e.type === 'bill') { bills += c; bc++; }
      else { subs += c; sc++; }
    });
    return {
      totalBills: bills,
      totalSubs: subs,
      totalAll: bills + subs,
      billCount: bc,
      subCount: sc,
      filtered: allExpenses.filter((e) => e.type === activeTab),
    };
  }, [allExpenses, activeTab]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="w-8 h-8 border-4 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1400px] mx-auto space-y-6">
      {/* Hero */}
      <div className="animate-fade-in">
        <p className="text-[10px] font-semibold tracking-widest uppercase text-secondary mb-1">
          Total Monthly Expenses
        </p>
        <h1 className="font-mono font-bold text-loss leading-none" style={{ fontSize: 'clamp(2rem, 5vw, 3rem)' }}>
          {formatCurrency(totalAll)}
        </h1>
        <p className="text-sm text-secondary mt-1">
          {billCount} bills + {subCount} subscriptions
        </p>
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
        <MetricCard
          label="Bills"
          value={formatCurrency(totalBills)}
          change={`${billCount} items`}
          valueColor="loss"
        />
        <MetricCard
          label="Subscriptions"
          value={formatCurrency(totalSubs)}
          change={`${subCount} items`}
          valueColor="loss"
        />
        <MetricCard
          label="Annual Cost"
          value={formatCurrency(totalAll * 12)}
          valueColor="loss"
        />
      </div>

      {successMessage && (
        <div className="bg-gain-bg text-gain border border-gain/20 rounded-lg p-3 animate-fade-in">{successMessage}</div>
      )}
      {error && (
        <div className="bg-loss-bg text-loss border border-loss/20 rounded-lg p-3 animate-fade-in">{error}</div>
      )}

      {/* Tab Bar + Add Button */}
      <div className="flex items-center justify-between animate-slide-up">
        <div className="flex bg-surface rounded-lg border border-border overflow-hidden">
          {[
            { key: 'bill', label: 'Bills' },
            { key: 'subscription', label: 'Subscriptions' },
          ].map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-5 py-2.5 text-sm font-medium transition-colors duration-200 min-h-[44px] ${
                activeTab === tab.key
                  ? 'bg-accent text-inverse'
                  : 'text-secondary hover:text-primary hover:bg-surface-3'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <button
          onClick={handleAddNew}
          className="px-4 py-2 bg-accent text-inverse hover:bg-accent-hover rounded-md text-sm transition-colors duration-200 min-h-[44px] touch-manipulation"
        >
          Add {activeTab === 'bill' ? 'Bill' : 'Subscription'}
        </button>
      </div>

      {/* Table */}
      <div className="card overflow-hidden animate-slide-up">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-border">
            <thead className="bg-surface-2">
              <tr>
                {['Name', 'Cost', 'Fixed', 'Auto-pay', 'Account', activeTab === 'bill' ? 'Company' : 'Who Uses', ''].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-[10px] font-semibold tracking-widest uppercase text-secondary">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-secondary">
                    No {activeTab === 'bill' ? 'bills' : 'subscriptions'} found.
                  </td>
                </tr>
              ) : (
                filtered.map((exp) => (
                  <tr key={exp.id} className="hover:bg-surface-3 transition-colors duration-150">
                    <td className="px-4 py-3 text-sm text-primary font-medium">{exp.name}</td>
                    <td className="px-4 py-3 text-sm font-mono text-loss font-bold">{formatCurrency(exp.cost)}</td>
                    <td className="px-4 py-3 text-sm"><Badge active={exp.is_fixed_rate}>{exp.is_fixed_rate ? 'Yes' : 'No'}</Badge></td>
                    <td className="px-4 py-3 text-sm"><Badge active={exp.is_autopay}>{exp.is_autopay ? 'Yes' : 'No'}</Badge></td>
                    <td className="px-4 py-3 text-sm text-secondary">{exp.pay_account || <span className="text-tertiary">-</span>}</td>
                    <td className="px-4 py-3 text-sm text-secondary">{(activeTab === 'bill' ? exp.company : exp.who_uses) || <span className="text-tertiary">-</span>}</td>
                    <td className="px-4 py-3 text-sm whitespace-nowrap">
                      <div className="flex gap-1">
                        <button onClick={() => handleEdit(exp)} className="text-xs text-accent hover:bg-accent-muted rounded px-2 py-1.5 transition-colors duration-150 min-h-[44px]">Edit</button>
                        <button onClick={() => setDeletingExpense(exp)} className="text-xs text-loss hover:bg-loss-bg rounded px-2 py-1.5 transition-colors duration-150 min-h-[44px]">Delete</button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Form Modal */}
      {isFormOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in">
          <div className="bg-surface rounded-card border border-border shadow-xl max-w-lg w-full mx-4 p-6 max-h-[90vh] overflow-y-auto animate-slide-up">
            <h2 className="text-lg font-bold mb-4 text-primary">{editingExpense ? 'Edit' : 'Add'} {formData.type === 'bill' ? 'Bill' : 'Subscription'}</h2>
            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="block text-[10px] font-semibold tracking-widest uppercase text-secondary mb-1.5">Type</label>
                <select value={formData.type} onChange={(e) => setFormData({ ...formData, type: e.target.value })} className="w-full px-3 py-2 rounded-md border border-input-border min-h-[44px]">
                  <option value="bill">Bill</option>
                  <option value="subscription">Subscription</option>
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-semibold tracking-widest uppercase text-secondary mb-1.5">Name</label>
                <input type="text" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} className="w-full px-3 py-2 rounded-md border border-input-border min-h-[44px]" required />
              </div>
              <div>
                <label className="block text-[10px] font-semibold tracking-widest uppercase text-secondary mb-1.5">Monthly Cost</label>
                <input type="number" step="0.01" value={formData.cost} onChange={(e) => setFormData({ ...formData, cost: e.target.value })} className="w-full px-3 py-2 rounded-md border border-input-border min-h-[44px]" required />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <label className="flex items-center gap-2 cursor-pointer min-h-[44px]">
                  <input type="checkbox" checked={formData.is_fixed_rate} onChange={(e) => setFormData({ ...formData, is_fixed_rate: e.target.checked })} className="w-4 h-4 accent-accent rounded" />
                  <span className="text-sm text-primary">Fixed Rate</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer min-h-[44px]">
                  <input type="checkbox" checked={formData.is_autopay} onChange={(e) => setFormData({ ...formData, is_autopay: e.target.checked })} className="w-4 h-4 accent-accent rounded" />
                  <span className="text-sm text-primary">Auto-pay</span>
                </label>
              </div>
              <div>
                <label className="block text-[10px] font-semibold tracking-widest uppercase text-secondary mb-1.5">Payment Account</label>
                <input type="text" value={formData.pay_account} onChange={(e) => setFormData({ ...formData, pay_account: e.target.value })} className="w-full px-3 py-2 rounded-md border border-input-border min-h-[44px]" placeholder="e.g. Chase Sapphire" />
              </div>
              {formData.type === 'bill' ? (
                <div>
                  <label className="block text-[10px] font-semibold tracking-widest uppercase text-secondary mb-1.5">Company</label>
                  <input type="text" value={formData.company} onChange={(e) => setFormData({ ...formData, company: e.target.value })} className="w-full px-3 py-2 rounded-md border border-input-border min-h-[44px]" />
                </div>
              ) : (
                <div>
                  <label className="block text-[10px] font-semibold tracking-widest uppercase text-secondary mb-1.5">Who Uses</label>
                  <input type="text" value={formData.who_uses} onChange={(e) => setFormData({ ...formData, who_uses: e.target.value })} className="w-full px-3 py-2 rounded-md border border-input-border min-h-[44px]" />
                </div>
              )}
              <div>
                <label className="block text-[10px] font-semibold tracking-widest uppercase text-secondary mb-1.5">Notes</label>
                <input type="text" value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} className="w-full px-3 py-2 rounded-md border border-input-border min-h-[44px]" />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setIsFormOpen(false)} className="px-4 py-2 bg-surface-3 text-secondary hover:bg-surface-3/80 rounded-md transition-colors duration-200 min-h-[44px]">Cancel</button>
                <button type="submit" className="px-4 py-2 bg-accent text-inverse hover:bg-accent-hover rounded-md transition-colors duration-200 min-h-[44px]">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirm Modal */}
      {deletingExpense && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in">
          <div className="bg-surface rounded-card border border-border shadow-xl max-w-md w-full mx-4 p-6 animate-slide-up">
            <h2 className="text-lg font-bold mb-4 text-primary">Confirm Delete</h2>
            <p className="text-secondary mb-6">Delete "{deletingExpense.name}"?</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeletingExpense(null)} className="px-4 py-2 bg-surface-3 text-secondary hover:bg-surface-3/80 rounded-md transition-colors duration-200 min-h-[44px]">Cancel</button>
              <button onClick={handleDeleteConfirm} className="px-4 py-2 bg-loss text-inverse rounded-md hover:opacity-90 transition-opacity duration-200 min-h-[44px]">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MonthlyExpenses;
