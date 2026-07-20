import React, { useState, useEffect, useMemo } from 'react';
import { motion as Motion, AnimatePresence } from 'framer-motion';
import { Tag, EyeOff, Eye, RotateCcw, Check, X, TrendingDown, Calendar } from 'lucide-react';
import { expenses as expensesAPI } from '../utils/api';
import { formatCurrency, formatDateDisplay, formatDayOrdinal } from '../utils/format';
import LoadingState from '../components/LoadingState';
import useTransientMessage from '../hooks/useTransientMessage';

const Badge = ({ active, children }) => (
  <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase ${
    active ? 'bg-gain-bg text-gain border border-gain/20' : 'bg-surface-3 text-tertiary border border-border'
  }`}>
    {children}
  </span>
);

const MonthlyExpenses = () => {
  const [allExpenses, setAllExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [successMessage, showSuccess] = useTransientMessage();
  const [ignoringExpense, setIgnoringExpense] = useState(null);
  const [taggingId, setTaggingId] = useState(null);
  const [tagDraft, setTagDraft] = useState('');
  const [ignoredOpen, setIgnoredOpen] = useState(false);
  const [ignored, setIgnored] = useState([]);
  const [ignoredLoading, setIgnoredLoading] = useState(false);
  const [ignoredError, setIgnoredError] = useState(null);
  const [restoringKey, setRestoringKey] = useState(null);
  const [ignoreSubmitting, setIgnoreSubmitting] = useState(false);

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

  const fetchIgnored = async () => {
    setIgnoredLoading(true);
    setIgnoredError(null);
    try {
      const data = await expensesAPI.getIgnored();
      setIgnored(data.ignored || []);
    } catch (err) {
      setIgnored([]);
      setIgnoredError(err.response?.data?.error || 'Failed to load ignored charges');
    } finally {
      setIgnoredLoading(false);
    }
  };

  const openIgnored = () => {
    setIgnoredOpen(true);
    fetchIgnored();
  };

  const startTagging = (expense) => {
    setTaggingId(expense.id);
    setTagDraft(expense.tag || '');
  };

  const handleTagSave = async (expense) => {
    try {
      await expensesAPI.setTag(expense.id, tagDraft.trim() || null);
      showSuccess(tagDraft.trim() ? `Tagged "${expense.name}"` : `Tag removed from "${expense.name}"`);
      setTaggingId(null);
      await fetchData();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save tag');
    }
  };

  const handleIgnoreConfirm = async () => {
    if (ignoreSubmitting) return;
    const expense = ignoringExpense;
    setIgnoreSubmitting(true);
    setIgnoringExpense(null);
    try {
      await expensesAPI.ignore(expense.id);
      showSuccess(`Ignored "${expense.name}"`);
      await fetchData();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to ignore');
    } finally {
      setIgnoreSubmitting(false);
    }
  };

  const handleRestore = async (item) => {
    const label = item.name || item.merchant_key;
    setRestoringKey(item.merchant_key);
    try {
      const res = await expensesAPI.restoreIgnored(item.merchant_key);
      showSuccess(res.recreated
        ? `Restored "${label}"`
        : `"${label}" un-ignored; it will reappear once it has recent recurring charges`);
      await Promise.all([fetchData(), fetchIgnored()]);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to restore');
    } finally {
      setRestoringKey(null);
    }
  };

  const { totalAll, stats } = useMemo(() => {
    let total = 0, fixedTotal = 0, variableTotal = 0;
    allExpenses.forEach((e) => {
      const c = parseFloat(e.cost) || 0;
      total += c;
      if (e.is_fixed_rate) fixedTotal += c;
      else variableTotal += c;
    });
    return { totalAll: total, stats: { fixedTotal, variableTotal } };
  }, [allExpenses]);

  if (loading) {
    return <LoadingState label="Calculating Expenses" />;
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
          <p className="text-sm text-secondary">Auto-detected across {allExpenses.length} recurring charges</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={openIgnored}
            className="flex items-center gap-2 rounded border border-border bg-surface-2 px-3 py-3 text-xs font-bold uppercase tracking-wider text-secondary shadow-sm transition-all hover:border-accent/30 hover:text-accent"
          >
            <EyeOff size={14} />
            Ignored
          </button>
          <div className="min-w-0 rounded border border-border bg-surface-2 p-3 shadow-sm sm:min-w-[140px]">
            <p className="text-[10px] font-bold text-tertiary uppercase tracking-wide mb-1">Annual Cost</p>
            <p className="text-lg font-mono font-bold text-loss">{formatCurrency(totalAll * 12)}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-5">
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
          <p className="text-[10px] font-bold uppercase tracking-wide text-tertiary">Recurring Charges</p>
          <p className="font-mono text-lg font-bold text-primary">{allExpenses.length}</p>
          <p className="text-caption text-tertiary">Synced nightly from transactions</p>
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

          <div className="card overflow-hidden">
            <div className="max-w-full overflow-hidden">
              <table className="w-full table-fixed divide-y divide-border">
                <thead className="bg-surface-2">
                  <tr>
                    {['Name', 'Monthly Cost', 'Fixed', 'Due', 'Account', 'Company', 'Actions'].map((h, index) => (
                      <th key={h} className={`px-2 py-4 text-left text-[10px] font-bold uppercase tracking-wide text-tertiary sm:px-5 ${index >= 2 && index <= 5 ? 'hidden xl:table-cell' : ''}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  <AnimatePresence mode="popLayout">
                    {allExpenses.length === 0 ? (
                      <tr key="empty">
                        <td colSpan={7} className="px-5 py-12 text-center">
                          <div className="flex flex-col items-center gap-3 opacity-40">
                            <Calendar size={32} className="text-tertiary" />
                            <p className="text-sm font-medium text-tertiary">No recurring charges detected yet</p>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      allExpenses.map((exp) => (
                        <Motion.tr
                          layout
                          key={exp.id}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          className="hover:bg-surface-3 transition-colors group"
                        >
                          <td className="px-2 py-4 sm:px-5">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="text-sm font-bold text-primary">{exp.name}</div>
                              {taggingId !== exp.id && exp.tag && (
                                <span className="inline-flex items-center gap-1 border border-accent/20 bg-accent/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-accent" title="Your tag">
                                  <Tag size={10} />
                                  {exp.tag}
                                </span>
                              )}
                              {exp.is_stale && (
                                <span className="inline-flex items-center gap-1 border border-loss/20 bg-loss/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-loss" title={`No charge since ${formatDateDisplay(exp.last_charge_date)}; expected every ${exp.charge_interval_days || 30} days`}>
                                  <Calendar size={10} />
                                  Stale
                                </span>
                              )}
                            </div>
                            {taggingId === exp.id && (
                              <div className="mt-1.5 flex items-center gap-1.5">
                                <input
                                  type="text"
                                  value={tagDraft}
                                  autoFocus
                                  maxLength={100}
                                  placeholder="e.g. Sewer & Trash"
                                  onChange={(e) => setTagDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleTagSave(exp);
                                    if (e.key === 'Escape') setTaggingId(null);
                                  }}
                                  className="w-40 bg-surface-3 border border-border rounded px-2 py-1 text-xs focus:ring-1 focus:ring-accent outline-none"
                                />
                                <button onClick={() => handleTagSave(exp)} className="p-1 border border-border bg-surface-2 text-gain hover:bg-gain/10 rounded transition-colors" title="Save tag" aria-label={`Save tag for ${exp.name}`}>
                                  <Check size={12} />
                                </button>
                                <button onClick={() => setTaggingId(null)} className="p-1 border border-border bg-surface-2 text-tertiary hover:text-primary rounded transition-colors" title="Cancel" aria-label="Cancel tag edit">
                                  <X size={12} />
                                </button>
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-4 sm:px-5">
                            <span className="text-sm font-mono font-bold text-loss">{formatCurrency(exp.cost)}</span>
                          </td>
                          <td className="hidden px-5 py-4 xl:table-cell"><Badge active={exp.is_fixed_rate}>{exp.is_fixed_rate ? 'Fixed' : 'Variable'}</Badge></td>
                          <td className="hidden px-5 py-4 xl:table-cell">
                            <span className="text-xs font-medium text-secondary" title={exp.last_charge_date ? `Last charge ${formatDateDisplay(exp.last_charge_date)}` : undefined}>
                              {formatDayOrdinal(exp.due_day) || <span className="text-tertiary">—</span>}
                            </span>
                          </td>
                          <td className="hidden px-5 py-4 xl:table-cell">
                            <span className="text-xs font-medium text-secondary">{exp.pay_account || <span className="text-tertiary">—</span>}</span>
                          </td>
                          <td className="hidden px-5 py-4 xl:table-cell">
                            <span className="text-xs font-medium text-secondary">{exp.company || <span className="text-tertiary">—</span>}</span>
                          </td>
                          <td className="px-2 py-4 text-right sm:px-5">
                            <div className="flex justify-end gap-1">
                              <button onClick={() => (taggingId === exp.id ? setTaggingId(null) : startTagging(exp))} className="p-2 border border-border bg-surface-2 text-accent hover:bg-accent/10 rounded transition-colors" title={exp.tag ? 'Edit tag' : 'Add tag'} aria-label={`${exp.tag ? 'Edit' : 'Add'} tag for ${exp.name}`}>
                                <Tag size={14} />
                              </button>
                              <button onClick={() => setIgnoringExpense(exp)} className="p-2 border border-border bg-surface-2 text-loss hover:bg-loss/10 rounded transition-colors" title="Ignore" aria-label={`Ignore ${exp.name}`}>
                                <EyeOff size={14} />
                              </button>
                            </div>
                          </td>
                        </Motion.tr>
                      ))
                    )}
                  </AnimatePresence>
                </tbody>
              </table>
            </div>
          </div>

          <div className="card p-4">
            <h2 className="mb-3 text-[10px] font-bold uppercase tracking-wide text-tertiary">Annualized Impact</h2>
            <div className="space-y-3">
              {[
                ['Fixed costs', stats.fixedTotal, 'text-primary'],
                ['Variable costs', stats.variableTotal, 'text-loss'],
                ['Everything tracked', totalAll, 'text-primary'],
              ].map(([label, value, colorClass]) => (
                <div key={label} className="flex items-center justify-between border-b border-border pb-2 last:border-0 last:pb-0">
                  <span className="text-sm text-secondary">{label}</span>
                  <span className={`font-mono text-sm font-bold ${colorClass}`}>{formatCurrency(value * 12)}/yr</span>
                </div>
              ))}
            </div>
          </div>
      </div>

      {/* Ignore Confirm Modal */}
      <AnimatePresence>
        {ignoringExpense && (
          <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4">
            <Motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/60 " onClick={() => setIgnoringExpense(null)} />
            <Motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} className="relative w-full max-w-sm border border-border bg-surface p-5 text-center shadow-2xl sm:rounded-3xl sm:p-6">
              <div className="w-16 h-16 bg-loss/10 text-loss rounded-full flex items-center justify-center mx-auto mb-4">
                <EyeOff size={24} />
              </div>
              <h2 className="text-xl font-bold text-primary mb-2">Ignore Charge</h2>
              <p className="text-sm text-secondary mb-8">
                Ignore <span className="text-primary font-bold">"{ignoringExpense.name}"</span>? It won't be counted or re-added by the nightly sync until you restore it from Ignored.
              </p>
              <div className="flex gap-3">
                <button onClick={() => setIgnoringExpense(null)} className="flex-1 py-3 bg-surface-3 text-secondary rounded text-xs font-bold uppercase tracking-wider hover:bg-surface-2 transition-all">Cancel</button>
                <button onClick={handleIgnoreConfirm} disabled={ignoreSubmitting} className="flex-1 py-3 bg-loss text-white rounded text-xs font-bold uppercase tracking-wider hover:opacity-90 transition-all disabled:opacity-50">Ignore</button>
              </div>
            </Motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Ignored List Panel */}
      <AnimatePresence>
        {ignoredOpen && (
          <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
            <Motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/60 " onClick={() => setIgnoredOpen(false)} />
            <Motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} className="relative flex max-h-[100dvh] w-full max-w-lg flex-col overflow-hidden border border-border bg-surface shadow-2xl sm:max-h-[92vh] sm:rounded-3xl">
              <div className="flex shrink-0 items-center justify-between border-b border-border p-4 sm:p-6">
                <div className="flex items-center gap-2">
                  <EyeOff size={18} className="text-secondary" />
                  <h2 className="text-lg font-bold text-primary">Ignored Charges</h2>
                </div>
                <button onClick={() => setIgnoredOpen(false)} className="text-tertiary hover:text-primary transition-colors"><X size={20} /></button>
              </div>
              <div className="overflow-y-auto p-4 sm:p-6">
                {ignoredLoading ? (
                  <LoadingState label={null} className="py-8" />
                ) : ignoredError ? (
                  <div className="p-4 bg-loss-bg border border-loss/20 text-loss rounded text-xs flex items-center gap-3">
                    <X size={16} />
                    {ignoredError}
                  </div>
                ) : ignored.length === 0 ? (
                  <div className="flex flex-col items-center gap-3 py-8 opacity-40">
                    <Eye size={32} className="text-tertiary" />
                    <p className="text-sm font-medium text-tertiary">Nothing ignored</p>
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {ignored.map((item) => (
                      <div key={item.merchant_key} className="flex items-center justify-between gap-4 py-3">
                        <div className="min-w-0">
                          <div className="text-sm font-bold text-primary truncate">{item.name || item.merchant_key}</div>
                          <div className="flex items-center gap-3 mt-0.5 text-[10px] text-tertiary">
                            {item.last_cost != null && <span className="font-mono">{formatCurrency(item.last_cost)}/mo</span>}
                            <span>Ignored {formatDateDisplay(item.created_at)}</span>
                          </div>
                        </div>
                        <button
                          onClick={() => handleRestore(item)}
                          disabled={restoringKey === item.merchant_key}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-accent/10 text-accent border border-accent/30 rounded text-[10px] font-bold uppercase tracking-wider hover:bg-accent hover:text-white transition-all disabled:opacity-50"
                        >
                          <RotateCcw size={12} />
                          {restoringKey === item.merchant_key ? 'Restoring' : 'Restore'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <p className="mt-4 text-caption text-tertiary">Restoring re-runs detection so the charge reappears immediately.</p>
              </div>
            </Motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default MonthlyExpenses;
