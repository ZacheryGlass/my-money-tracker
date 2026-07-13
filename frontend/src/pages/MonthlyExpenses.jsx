import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion as Motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, Copy, CreditCard, Receipt, Edit2, Trash2, Check, X, TrendingDown, Calendar, Search, Zap } from 'lucide-react';
import { expenses as expensesAPI, analytics } from '../utils/api';
import { formatCurrency, formatDateDisplay } from '../utils/format';

const Badge = ({ active, children }) => (
  <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase ${
    active ? 'bg-gain-bg text-gain border border-gain/20' : 'bg-surface-3 text-tertiary border border-border'
  }`}>
    {children}
  </span>
);

const ROUGH_NAMES = new Set(['bullshit', 'misc', 'miscellaneous', 'other', 'unknown', 'stuff']);

function getCleanupFlag(expense) {
  const name = String(expense.name || '').trim();
  if (!name) return 'Missing name';
  if (name.length < 4) return 'Too short';
  if (ROUGH_NAMES.has(name.toLowerCase())) return 'Review name';
  if (!expense.company && !expense.who_uses && !expense.notes) return 'Add details';
  return null;
}

function getPaymentConfidence(expense) {
  if (expense.is_autopay && expense.pay_account) {
    return { label: 'High', detail: 'Autopay + account', tone: 'gain' };
  }
  if (expense.is_autopay || expense.pay_account) {
    return { label: 'Medium', detail: expense.is_autopay ? 'Autopay, no account' : 'Manual, account set', tone: 'accent' };
  }
  return { label: 'Low', detail: 'Manual, no account', tone: 'loss' };
}

const MonthlyExpenses = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [allExpenses, setAllExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState('');
  const [activeTab, setActiveTab] = useState('bill');
  const [detectedSubs, setDetectedSubs] = useState([]);
  const [detectedLoading, setDetectedLoading] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState(null);
  const [deletingExpense, setDeletingExpense] = useState(null);
  const [formData, setFormData] = useState({
    type: 'bill', name: '', cost: '', is_fixed_rate: true, is_autopay: false,
    pay_account: '', company: '', who_uses: '', notes: '',
  });

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

  useEffect(() => { fetchData(); }, []);

  useEffect(() => {
    if (activeTab === 'detected') {
      setDetectedLoading(true);
      analytics.getDetectedSubscriptions()
        .then((res) => setDetectedSubs(res.data || []))
        .catch(() => setDetectedSubs([]))
        .finally(() => setDetectedLoading(false));
    }
  }, [activeTab]);

  const showSuccess = (msg) => {
    setSuccessMessage(msg);
    setTimeout(() => setSuccessMessage(''), 3000);
  };

  const handleAddNew = useCallback((requestedType = activeTab) => {
    const entryType = requestedType === 'subscription' ? 'subscription' : 'bill';
    setActiveTab(entryType);
    setEditingExpense(null);
    setFormData({
      type: entryType, name: '', cost: '', is_fixed_rate: true, is_autopay: false,
      pay_account: '', company: '', who_uses: '', notes: '',
    });
    setIsFormOpen(true);
  }, [activeTab]);

  useEffect(() => {
    if (location.state?.openAdd === 'bill' || location.state?.openAdd === 'subscription') {
      handleAddNew(location.state.openAdd);
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [handleAddNew, location.pathname, location.state, navigate]);

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

  const handleDuplicate = async (expense) => {
    try {
      await expensesAPI.create({
        type: expense.type,
        name: `${expense.name} Copy`,
        cost: parseFloat(expense.cost) || 0,
        is_fixed_rate: expense.is_fixed_rate,
        is_autopay: expense.is_autopay,
        pay_account: expense.pay_account || null,
        company: expense.company || null,
        who_uses: expense.who_uses || null,
        notes: expense.notes || null,
      });
      showSuccess(`Duplicated "${expense.name}"`);
      await fetchData();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to duplicate expense');
    }
  };

  const handleTrackDetected = async (sub) => {
    try {
      await expensesAPI.create({
        type: 'subscription',
        name: sub.merchant,
        cost: parseFloat(sub.avg_amount) || 0,
        is_fixed_rate: true,
        is_autopay: true,
        company: sub.merchant,
        notes: `Auto-detected from ${sub.occurrence_count} charges`,
      });
      showSuccess(`Now tracking "${sub.merchant}"`);
      await fetchData();
      setDetectedSubs((prev) => prev.filter((d) => d.merchant !== sub.merchant));
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to track subscription');
    }
  };

  const trackedNames = useMemo(() =>
    new Set(allExpenses.map((e) => e.name.toLowerCase())),
  [allExpenses]);

  const filteredDetected = useMemo(() =>
    detectedSubs.filter((d) => !trackedNames.has(d.merchant.toLowerCase())),
  [detectedSubs, trackedNames]);

  const { totalBills, totalSubs, totalAll, billCount, subCount, filtered, stats } = useMemo(() => {
    let bills = 0, subs = 0, bc = 0, sc = 0;
    let fixedTotal = 0, variableTotal = 0, autopayCount = 0, manualCount = 0, missingAccountCount = 0, cleanupCount = 0;
    allExpenses.forEach((e) => {
      const c = parseFloat(e.cost) || 0;
      if (e.type === 'bill') { bills += c; bc++; }
      else { subs += c; sc++; }
      if (e.is_fixed_rate) fixedTotal += c;
      else variableTotal += c;
      if (e.is_autopay) autopayCount++;
      else manualCount++;
      if (!e.pay_account) missingAccountCount++;
      if (getCleanupFlag(e)) cleanupCount++;
    });
    return {
      totalBills: bills,
      totalSubs: subs,
      totalAll: bills + subs,
      billCount: bc,
      subCount: sc,
      filtered: allExpenses.filter((e) => e.type === activeTab),
      stats: { fixedTotal, variableTotal, autopayCount, manualCount, missingAccountCount, cleanupCount },
    };
  }, [allExpenses, activeTab]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        <span className="text-xs font-bold tracking-wide uppercase text-tertiary ">Calculating Expenses</span>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 md:py-8 max-w-[1600px]">
      {/* Hero Section */}
      <div className="flex flex-col md:flex-row md:items-end justify-between mb-6 gap-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <TrendingDown className="text-loss w-5 h-5" />
            <span className="text-[10px] font-bold uppercase tracking-wide text-secondary">Monthly Burn Rate</span>
          </div>
          <h1 className="text-3xl md:text-5xl font-bold text-primary tracking-tighter leading-none mb-2">
            {formatCurrency(totalAll)}
          </h1>
          <p className="text-sm text-secondary">Aggregated across {billCount} bills and {subCount} subscriptions</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 rounded border border-border bg-surface-2 p-3 shadow-sm sm:min-w-[140px]">
            <p className="text-[10px] font-bold text-tertiary uppercase tracking-wide mb-1">Annual Cost</p>
            <p className="text-lg font-mono font-bold text-loss">{formatCurrency(totalAll * 12)}</p>
          </div>
          <div className="min-w-0 rounded border border-border bg-surface-2 p-3 shadow-sm sm:min-w-[140px]">
            <p className="text-[10px] font-bold text-tertiary uppercase tracking-wide mb-1">Manual Pays</p>
            <p className="text-lg font-mono font-bold text-primary">{stats.manualCount}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <div className="border border-border bg-surface p-3">
          <p className="text-[10px] font-bold uppercase tracking-wide text-tertiary">Fixed Monthly</p>
          <p className="font-mono text-lg font-bold text-primary">{formatCurrency(stats.fixedTotal)}</p>
          <p className="text-caption text-tertiary">Annual {formatCurrency(stats.fixedTotal * 12)}</p>
        </div>
        <div className="border border-border bg-surface p-3">
          <p className="text-[10px] font-bold uppercase tracking-wide text-tertiary">Variable Monthly</p>
          <p className="font-mono text-lg font-bold text-loss">{formatCurrency(stats.variableTotal)}</p>
          <p className="text-caption text-tertiary">Annual {formatCurrency(stats.variableTotal * 12)}</p>
        </div>
        <div className="border border-border bg-surface p-3">
          <p className="text-[10px] font-bold uppercase tracking-wide text-tertiary">Subscriptions</p>
          <p className="font-mono text-lg font-bold text-primary">{formatCurrency(totalSubs)}</p>
          <p className="text-caption text-tertiary">{subCount} tracked items</p>
        </div>
        <div className="border border-border bg-surface p-3">
          <p className="text-[10px] font-bold uppercase tracking-wide text-tertiary">Cleanup Flags</p>
          <p className={`font-mono text-lg font-bold ${stats.cleanupCount > 0 ? 'text-loss' : 'text-gain'}`}>{stats.cleanupCount}</p>
          <p className="text-caption text-tertiary">Names or details to review</p>
        </div>
      </div>

      <div className="mb-5 rounded border border-border bg-surface overflow-hidden">
        <div className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2 shrink-0">
            <Receipt size={16} className="text-accent" />
            <span className="text-sm font-bold uppercase tracking-wide text-primary">Categories</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              { key: 'bill', label: 'Fixed Bills', icon: Receipt, count: billCount, total: totalBills },
              { key: 'subscription', label: 'Subscriptions', icon: CreditCard, count: subCount, total: totalSubs },
              { key: 'detected', label: 'Detected', icon: Search, count: filteredDetected.length, total: null },
            ].map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex min-w-0 items-center justify-between gap-4 rounded border px-3 py-2 transition-all ${
                  activeTab === tab.key
                    ? 'bg-accent/10 border-accent/30 text-accent ring-1 ring-accent/10'
                    : 'bg-surface-2 border-transparent text-secondary hover:border-border hover:text-primary'
                }`}
              >
                <div className="flex items-center gap-3">
                  <tab.icon size={16} />
                  <div className="text-left">
                    <p className="text-xs font-bold uppercase tracking-wider">{tab.label}</p>
                    <p className="text-[10px] opacity-70 font-medium">{tab.count} items</p>
                  </div>
                </div>
                <p className="text-xs font-mono font-bold">{tab.total !== null ? formatCurrency(tab.total) : ''}</p>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-6">
          {error && (
            <div className="p-4 bg-loss-bg border border-loss/20 text-loss rounded text-xs flex items-center gap-3">
              <X size={16} />
              {error}
            </div>
          )}

          {successMessage && (
            <Motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="p-4 bg-gain-bg border border-gain/20 text-gain rounded text-xs flex items-center gap-3">
              <Check size={16} />
              {successMessage}
            </Motion.div>
          )}
          
          {activeTab !== 'detected' ? (
            <div className="card overflow-hidden">
              <div className="max-w-full overflow-hidden">
                <table className="w-full table-fixed divide-y divide-border">
                  <thead className="bg-surface-2">
                    <tr>
                      {['Name', 'Monthly Cost', 'Fixed', 'Auto-pay', 'Payment', 'Account', activeTab === 'bill' ? 'Company' : 'Who Uses', 'Actions'].map((h, index) => (
                        <th key={h} className={`px-2 py-4 text-left text-[10px] font-bold uppercase tracking-wide text-tertiary sm:px-5 ${index >= 2 && index <= 6 ? 'hidden xl:table-cell' : ''}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    <AnimatePresence mode="popLayout">
                      {filtered.length === 0 ? (
                        <tr key="empty">
                          <td colSpan={8} className="px-5 py-12 text-center">
                            <div className="flex flex-col items-center gap-3 opacity-40">
                              <Calendar size={32} className="text-tertiary" />
                              <p className="text-sm font-medium text-tertiary">No {activeTab}s tracked yet</p>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        filtered.map((exp) => {
                          const cleanupFlag = getCleanupFlag(exp);
                          const payment = getPaymentConfidence(exp);
                          const toneClass = payment.tone === 'gain' ? 'text-gain' : payment.tone === 'loss' ? 'text-loss' : 'text-accent';
                          return (
                            <Motion.tr
                              layout
                              key={exp.id}
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              exit={{ opacity: 0 }}
                              className="hover:bg-surface-3 transition-colors group"
                            >
                              <td className="px-2 py-4 sm:px-5">
                                <div className="flex items-center gap-2">
                                  <div className="text-sm font-bold text-primary">{exp.name}</div>
                                  {cleanupFlag && (
                                    <span className="inline-flex items-center gap-1 border border-loss/20 bg-loss/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-loss" title={cleanupFlag}>
                                      <AlertTriangle size={10} />
                                      Review
                                    </span>
                                  )}
                                </div>
                                {exp.notes && <div className="text-[10px] text-tertiary truncate max-w-[190px]">{exp.notes}</div>}
                              </td>
                              <td className="px-2 py-4 sm:px-5">
                                <span className="text-sm font-mono font-bold text-loss">{formatCurrency(exp.cost)}</span>
                              </td>
                              <td className="hidden px-5 py-4 xl:table-cell"><Badge active={exp.is_fixed_rate}>{exp.is_fixed_rate ? 'Fixed' : 'Variable'}</Badge></td>
                              <td className="hidden px-5 py-4 xl:table-cell"><Badge active={exp.is_autopay}>{exp.is_autopay ? 'Auto' : 'Manual'}</Badge></td>
                              <td className="hidden px-5 py-4 xl:table-cell">
                                <div className="space-y-0.5">
                                  <p className={`text-[10px] font-bold uppercase tracking-wide ${toneClass}`}>{payment.label}</p>
                                  <p className="text-[10px] text-tertiary">{payment.detail}</p>
                                </div>
                              </td>
                              <td className="hidden px-5 py-4 xl:table-cell">
                                <span className="text-xs font-medium text-secondary">{exp.pay_account || <span className="text-tertiary">—</span>}</span>
                              </td>
                              <td className="hidden px-5 py-4 xl:table-cell">
                                <span className="text-xs font-medium text-secondary">{(activeTab === 'bill' ? exp.company : exp.who_uses) || <span className="text-tertiary">—</span>}</span>
                              </td>
                              <td className="px-2 py-4 text-right sm:px-5">
                                <div className="flex justify-end gap-1">
                                  <button onClick={() => handleEdit(exp)} className="p-2 border border-border bg-surface-2 text-accent hover:bg-accent/10 rounded transition-colors" title="Edit" aria-label={`Edit ${exp.name}`}>
                                    <Edit2 size={14} />
                                  </button>
                                  <button onClick={() => handleDuplicate(exp)} className="p-2 border border-border bg-surface-2 text-secondary hover:bg-surface-3 rounded transition-colors" title="Duplicate" aria-label={`Duplicate ${exp.name}`}>
                                    <Copy size={14} />
                                  </button>
                                  <button onClick={() => setDeletingExpense(exp)} className="p-2 border border-border bg-surface-2 text-loss hover:bg-loss/10 rounded transition-colors" title="Delete" aria-label={`Delete ${exp.name}`}>
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              </td>
                            </Motion.tr>
                          );
                        })
                      )}
                    </AnimatePresence>
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="card overflow-hidden">
              <div className="p-4 border-b border-border  flex items-center gap-2">
                <Zap size={16} className="text-accent" />
                <span className="text-sm font-bold text-primary">Auto-Detected Recurring Charges</span>
                <span className="text-[10px] text-tertiary ml-auto">from Plaid transactions</span>
              </div>
              {detectedLoading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                </div>
              ) : filteredDetected.length === 0 ? (
                <div className="px-5 py-12 text-center">
                  <div className="flex flex-col items-center gap-3 opacity-40">
                    <Search size={32} className="text-tertiary" />
                    <p className="text-sm font-medium text-tertiary">No untracked recurring charges detected</p>
                  </div>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {filteredDetected.map((sub) => (
                    <Motion.div
                      key={sub.merchant}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="flex items-center justify-between px-5 py-4 hover:bg-surface-3 transition-colors group"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-bold text-primary truncate">{sub.merchant}</div>
                        <div className="flex items-center gap-3 mt-1 text-[10px] text-tertiary">
                          <span>{sub.occurrence_count} charges</span>
                          <span>Last: {formatDateDisplay(sub.last_charge)}</span>
                          {sub.category && <span className="text-secondary">{sub.category}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="text-sm font-mono font-bold text-loss">{formatCurrency(sub.avg_amount)}/mo</span>
                        <button
                          onClick={() => handleTrackDetected(sub)}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-accent/10 text-accent border border-accent/30 rounded text-[10px] font-bold uppercase tracking-wider hover:bg-accent hover:text-white transition-all"
                        >
                          <Plus size={12} />
                          Track
                        </button>
                      </div>
                    </Motion.div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="card p-4">
              <h2 className="mb-3 text-[10px] font-bold uppercase tracking-wide text-tertiary">Annualized Impact</h2>
              <div className="space-y-3">
                {[
                  ['Fixed bills', stats.fixedTotal, 'text-primary'],
                  ['Variable bills', stats.variableTotal, 'text-loss'],
                  ['Subscriptions', totalSubs, 'text-primary'],
                ].map(([label, value, colorClass]) => (
                  <div key={label} className="flex items-center justify-between border-b border-border pb-2 last:border-0 last:pb-0">
                    <span className="text-sm text-secondary">{label}</span>
                    <span className={`font-mono text-sm font-bold ${colorClass}`}>{formatCurrency(value * 12)}/yr</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="card p-4">
              <h2 className="mb-3 text-[10px] font-bold uppercase tracking-wide text-tertiary">Payment Readiness</h2>
              <div className="grid grid-cols-3 gap-2">
                <div className="border border-border bg-surface-2 p-3">
                  <p className="text-caption uppercase text-tertiary">Autopay</p>
                  <p className="font-mono text-lg font-bold text-gain">{stats.autopayCount}</p>
                </div>
                <div className="border border-border bg-surface-2 p-3">
                  <p className="text-caption uppercase text-tertiary">Manual</p>
                  <p className="font-mono text-lg font-bold text-primary">{stats.manualCount}</p>
                </div>
                <div className="border border-border bg-surface-2 p-3">
                  <p className="text-caption uppercase text-tertiary">No Account</p>
                  <p className={`font-mono text-lg font-bold ${stats.missingAccountCount > 0 ? 'text-loss' : 'text-gain'}`}>{stats.missingAccountCount}</p>
                </div>
              </div>
              <p className="mt-3 text-caption text-tertiary">Due dates are not stored yet, so readiness uses autopay and payment-account coverage.</p>
            </div>
          </div>
          
          <div className="flex items-center justify-center gap-6 text-[10px] text-tertiary uppercase tracking-wide font-bold">
            <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-loss" /> Expenditure tracking</span>
            <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-surface-3 border border-border" /> Recurring liability</span>
            <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-surface-3 border border-border" /> Fixed vs Variable</span>
          </div>
      </div>

      {/* Form Modal */}
      <AnimatePresence>
        {isFormOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <Motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/60 " onClick={() => setIsFormOpen(false)} />
            <Motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} className="relative bg-surface rounded-3xl border border-border shadow-2xl max-w-lg w-full overflow-hidden">
              <div className="p-6 border-b border-border  flex items-center justify-between">
                <h2 className="text-lg font-bold text-primary">{editingExpense ? 'Modify' : 'Track New'} {formData.type === 'bill' ? 'Bill' : 'Subscription'}</h2>
                <button onClick={() => setIsFormOpen(false)} className="text-tertiary hover:text-primary transition-colors"><X size={20} /></button>
              </div>
              <form onSubmit={handleSave} className="p-6 space-y-5">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wide text-tertiary mb-2 px-1">Type</label>
                    <select value={formData.type} onChange={(e) => setFormData({ ...formData, type: e.target.value })} className="w-full bg-surface-3 border-border rounded px-3 py-2.5 text-sm focus:ring-1 focus:ring-accent outline-none">
                      <option value="bill">Fixed Bill</option>
                      <option value="subscription">Subscription</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wide text-tertiary mb-2 px-1">Monthly Cost</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-tertiary font-mono">$</span>
                      <input type="number" step="0.01" value={formData.cost} onChange={(e) => setFormData({ ...formData, cost: e.target.value })} className="w-full bg-surface-3 border-border rounded pl-7 pr-3 py-2.5 text-sm font-mono focus:ring-1 focus:ring-accent outline-none" required />
                    </div>
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wide text-tertiary mb-2 px-1">Name / Descriptor</label>
                  <input type="text" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} className="w-full bg-surface-3 border-border rounded px-3 py-2.5 text-sm focus:ring-1 focus:ring-accent outline-none" placeholder="e.g. Fiber Internet, Netflix" required />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <button type="button" onClick={() => setFormData({ ...formData, is_fixed_rate: !formData.is_fixed_rate })} className={`flex items-center justify-center gap-2 p-3 rounded border transition-all text-[10px] font-bold uppercase tracking-wider ${formData.is_fixed_rate ? 'bg-accent/10 border-accent/30 text-accent' : 'bg-surface-3 border-border text-tertiary'}`}>
                    {formData.is_fixed_rate ? <Check size={12} /> : null} Fixed Rate
                  </button>
                  <button type="button" onClick={() => setFormData({ ...formData, is_autopay: !formData.is_autopay })} className={`flex items-center justify-center gap-2 p-3 rounded border transition-all text-[10px] font-bold uppercase tracking-wider ${formData.is_autopay ? 'bg-accent/10 border-accent/30 text-accent' : 'bg-surface-3 border-border text-tertiary'}`}>
                    {formData.is_autopay ? <Check size={12} /> : null} Auto-pay
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wide text-tertiary mb-2 px-1">Payment Account</label>
                    <input type="text" value={formData.pay_account} onChange={(e) => setFormData({ ...formData, pay_account: e.target.value })} className="w-full bg-surface-3 border-border rounded px-3 py-2.5 text-sm focus:ring-1 focus:ring-accent outline-none" placeholder="e.g. Chase" />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wide text-tertiary mb-2 px-1">{formData.type === 'bill' ? 'Company' : 'Who Uses'}</label>
                    <input type="text" value={formData.type === 'bill' ? formData.company : formData.who_uses} onChange={(e) => setFormData({ ...formData, [formData.type === 'bill' ? 'company' : 'who_uses']: e.target.value })} className="w-full bg-surface-3 border-border rounded px-3 py-2.5 text-sm focus:ring-1 focus:ring-accent outline-none" />
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wide text-tertiary mb-2 px-1">Notes</label>
                  <textarea value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} className="w-full bg-surface-3 border-border rounded px-3 py-2.5 text-sm focus:ring-1 focus:ring-accent outline-none min-h-[80px]" />
                </div>
                <div className="flex justify-end gap-3 pt-4">
                  <button type="button" onClick={() => setIsFormOpen(false)} className="px-6 py-3 bg-surface-2 text-secondary hover:text-primary rounded text-xs font-bold uppercase tracking-wider transition-all">Cancel</button>
                  <button type="submit" className="px-8 py-3 bg-accent text-white hover:bg-accent-hover rounded text-xs font-bold uppercase tracking-wider transition-all">Save Entry</button>
                </div>
              </form>
            </Motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Delete Confirm Modal */}
      <AnimatePresence>
        {deletingExpense && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <Motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/60 " onClick={() => setDeletingExpense(null)} />
            <Motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} className="relative bg-surface rounded-3xl border border-border shadow-2xl max-w-sm w-full p-6 text-center">
              <div className="w-16 h-16 bg-loss/10 text-loss rounded-full flex items-center justify-center mx-auto mb-4">
                <Trash2 size={24} />
              </div>
              <h2 className="text-xl font-bold text-primary mb-2">Confirm Delete</h2>
              <p className="text-sm text-secondary mb-8">Are you sure you want to delete <span className="text-primary font-bold">"{deletingExpense.name}"</span>? This action cannot be undone.</p>
              <div className="flex gap-3">
                <button onClick={() => setDeletingExpense(null)} className="flex-1 py-3 bg-surface-3 text-secondary rounded text-xs font-bold uppercase tracking-wider hover:bg-surface-2 transition-all">Cancel</button>
                <button onClick={handleDeleteConfirm} className="flex-1 py-3 bg-loss text-white rounded text-xs font-bold uppercase tracking-wider hover:opacity-90 transition-all">Delete</button>
              </div>
            </Motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default MonthlyExpenses;
