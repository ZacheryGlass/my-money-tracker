import React, { useState, useEffect, useMemo } from 'react';
import { motion as Motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, CreditCard, Receipt, Plus, Tag, Trash2, Check, X, TrendingDown, Calendar, Search, Zap } from 'lucide-react';
import { expenses as expensesAPI, analytics } from '../utils/api';
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

const ROUGH_NAMES = new Set(['bullshit', 'misc', 'miscellaneous', 'other', 'unknown', 'stuff']);

const PROVENANCE_LABELS = {
  merchant: { label: 'Auto', title: 'Synced nightly from linked transactions' },
  budget: { label: 'Budget', title: 'Rolling 3-month average of category spending' },
  manual: { label: 'Manual', title: 'Hand-maintained entry' },
};

// A tag resolves any naming concern; derived rows (merchant/budget) get their
// details from transactions, so only manual entries are held to the
// name-length and company checks.
function getCleanupFlag(expense) {
  const name = String(expense.name || '').trim();
  if (!name) return 'Missing name';
  if (expense.tag) return null;
  if (ROUGH_NAMES.has(name.toLowerCase())) return 'Review name';
  if (expense.provenance !== 'manual') return null;
  if (name.length < 4) return 'Too short';
  if (!expense.company) return 'Add details';
  return null;
}

const MonthlyExpenses = () => {
  const [allExpenses, setAllExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [successMessage, showSuccess] = useTransientMessage();
  const [activeTab, setActiveTab] = useState('tracked');
  const [detectedSubs, setDetectedSubs] = useState([]);
  const [detectedLoading, setDetectedLoading] = useState(false);
  const [deletingExpense, setDeletingExpense] = useState(null);
  const [taggingId, setTaggingId] = useState(null);
  const [tagDraft, setTagDraft] = useState('');

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

  const handleTrackDetected = async (sub) => {
    try {
      await expensesAPI.create({
        name: sub.merchant,
        cost: parseFloat(sub.avg_amount) || 0,
        is_fixed_rate: true,
        company: sub.merchant,
      });
      showSuccess(`Now tracking "${sub.merchant}"`);
      await fetchData();
      setDetectedSubs((prev) => prev.filter((d) => d.merchant !== sub.merchant));
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to track merchant');
    }
  };

  const trackedNames = useMemo(() =>
    new Set(allExpenses.map((e) => e.name.toLowerCase())),
  [allExpenses]);

  const trackedMerchants = useMemo(() =>
    new Set(allExpenses.map((e) => e.merchant_key).filter(Boolean)),
  [allExpenses]);

  const filteredDetected = useMemo(() =>
    detectedSubs.filter((d) => !trackedNames.has(d.merchant.toLowerCase()) && !trackedMerchants.has(d.merchant)),
  [detectedSubs, trackedNames, trackedMerchants]);

  const { totalAll, filtered, stats } = useMemo(() => {
    let total = 0, fixedTotal = 0, variableTotal = 0, autoCount = 0, cleanupCount = 0;
    allExpenses.forEach((e) => {
      const c = parseFloat(e.cost) || 0;
      total += c;
      if (e.is_fixed_rate) fixedTotal += c;
      else variableTotal += c;
      if (e.provenance !== 'manual') autoCount++;
      if (getCleanupFlag(e)) cleanupCount++;
    });
    return {
      totalAll: total,
      filtered: allExpenses,
      stats: { fixedTotal, variableTotal, autoCount, cleanupCount },
    };
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
          <p className="text-sm text-secondary">Aggregated across {allExpenses.length} tracked recurring costs</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 rounded border border-border bg-surface-2 p-3 shadow-sm sm:min-w-[140px]">
            <p className="text-[10px] font-bold text-tertiary uppercase tracking-wide mb-1">Annual Cost</p>
            <p className="text-lg font-mono font-bold text-loss">{formatCurrency(totalAll * 12)}</p>
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
          <p className="text-[10px] font-bold uppercase tracking-wide text-tertiary">Automated</p>
          <p className="font-mono text-lg font-bold text-primary">{stats.autoCount}/{allExpenses.length}</p>
          <p className="text-caption text-tertiary">Entries derived from transactions</p>
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
              { key: 'tracked', label: 'Tracked', icon: CreditCard, count: allExpenses.length, total: totalAll },
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
                      {['Name', 'Monthly Cost', 'Fixed', 'Due', 'Source', 'Account', 'Company', 'Actions'].map((h, index) => (
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
                              <p className="text-sm font-medium text-tertiary">Nothing tracked yet; check the Detected tab</p>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        filtered.map((exp) => {
                          const cleanupFlag = getCleanupFlag(exp);
                          const provenance = PROVENANCE_LABELS[exp.provenance] || PROVENANCE_LABELS.manual;
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
                                <div className="flex flex-wrap items-center gap-2">
                                  <div className="text-sm font-bold text-primary">{exp.name}</div>
                                  {taggingId !== exp.id && exp.tag && (
                                    <span className="inline-flex items-center gap-1 border border-accent/20 bg-accent/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-accent" title="Your tag">
                                      <Tag size={10} />
                                      {exp.tag}
                                    </span>
                                  )}
                                  {cleanupFlag && (
                                    <span className="inline-flex items-center gap-1 border border-loss/20 bg-loss/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-loss" title={cleanupFlag}>
                                      <AlertTriangle size={10} />
                                      Review
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
                                <Badge active={exp.provenance === 'merchant'}><span title={provenance.title}>{provenance.label}</span></Badge>
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
                <LoadingState label={null} className="py-12" />
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
          
          <div className="flex items-center justify-center gap-6 text-[10px] text-tertiary uppercase tracking-wide font-bold">
            <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-loss" /> Expenditure tracking</span>
            <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-surface-3 border border-border" /> Recurring liability</span>
            <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-surface-3 border border-border" /> Fixed vs Variable</span>
          </div>
      </div>

      {/* Delete Confirm Modal */}
      <AnimatePresence>
        {deletingExpense && (
          <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4">
            <Motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/60 " onClick={() => setDeletingExpense(null)} />
            <Motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} className="relative w-full max-w-sm border border-border bg-surface p-5 text-center shadow-2xl sm:rounded-3xl sm:p-6">
              <div className="w-16 h-16 bg-loss/10 text-loss rounded-full flex items-center justify-center mx-auto mb-4">
                <Trash2 size={24} />
              </div>
              <h2 className="text-xl font-bold text-primary mb-2">Stop Tracking</h2>
              <p className="text-sm text-secondary mb-8">
                Remove <span className="text-primary font-bold">"{deletingExpense.name}"</span> from your burn rate?
                {deletingExpense.merchant_key
                  ? ' This merchant will not be auto-tracked again; you can re-track it from the Detected tab.'
                  : ' This action cannot be undone.'}
              </p>
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
