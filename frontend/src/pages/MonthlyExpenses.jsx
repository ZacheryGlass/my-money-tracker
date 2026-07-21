import React, { useState, useEffect, useMemo } from 'react';
import { motion as Motion, AnimatePresence } from 'framer-motion';
import { Tag, EyeOff, Check, X, TrendingDown, Calendar, ChevronRight } from 'lucide-react';
import { expenses as expensesAPI } from '../utils/api';
import { formatCurrency, formatDateDisplay, formatDayOrdinal } from '../utils/format';
import LoadingState from '../components/LoadingState';
import TransactionHistoryList from '../components/expenses/TransactionHistoryList';
import IgnoreConfirmModal from '../components/expenses/IgnoreConfirmModal';
import IgnoredMerchantsModal from '../components/expenses/IgnoredMerchantsModal';
import useIgnoredMerchants from '../hooks/useIgnoredMerchants';
import useTransientMessage from '../hooks/useTransientMessage';
import { useMediaQuery } from '../hooks/useMediaQuery';

const Badge = ({ active, children }) => (
  <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase ${
    active ? 'bg-gain-bg text-gain border border-gain/20' : 'bg-surface-3 text-tertiary border border-border'
  }`}>
    {children}
  </span>
);

// Table columns. Constant-content columns (Cost, Fixed badge, Date, Actions)
// get fixed widths sized to their content; Name, Account and Company have no
// width so table-fixed splits the leftover space evenly between whichever of
// them are visible. Optional columns reveal progressively (sm -> md -> xl ->
// 2xl); Account/Company wait for xl/2xl because the sidebar appears at lg.
const COLUMNS = [
  { label: 'Name', className: 'text-left' },
  { label: 'Monthly Cost', className: 'w-24 text-left sm:w-28' },
  { label: 'Fixed', className: 'hidden w-32 text-left sm:table-cell' },
  { label: 'Date', className: 'hidden w-32 text-left md:table-cell' },
  { label: 'Account', className: 'hidden text-left xl:table-cell' },
  { label: 'Company', className: 'hidden text-left 2xl:table-cell' },
  { label: 'Actions', className: 'w-24 text-right sm:w-28' },
];

const MonthlyExpenses = () => {
  const [allExpenses, setAllExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [successMessage, showSuccess] = useTransientMessage();
  const [ignoringExpense, setIgnoringExpense] = useState(null);
  const [taggingId, setTaggingId] = useState(null);
  const [tagDraft, setTagDraft] = useState('');
  const [ignoreSubmitting, setIgnoreSubmitting] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [txById, setTxById] = useState({});

  // Number of currently visible table columns; must mirror the reveal
  // breakpoints in COLUMNS. Spanned rows (empty state, expanded detail) need
  // an exact colSpan — spanning more than the visible columns creates phantom
  // columns that render wider than the real rows.
  const isSm = useMediaQuery('(min-width: 640px)');
  const isMd = useMediaQuery('(min-width: 768px)');
  const isXl = useMediaQuery('(min-width: 1280px)');
  const is2xl = useMediaQuery('(min-width: 1536px)');
  const visibleColumns = 3 + isSm + isMd + isXl + is2xl;

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

  const ignoredPanel = useIgnoredMerchants({
    scope: 'expenses',
    onRestored: async (res, item) => {
      const label = item.name || item.merchant_key;
      showSuccess(res.recreated
        ? `Restored "${label}"`
        : `"${label}" un-ignored; it will reappear once it has recent recurring charges`);
      await fetchData();
    },
    onError: setError,
  });

  const startTagging = (expense) => {
    setTaggingId(expense.id);
    setTagDraft(expense.tag || '');
  };

  const fetchTransactions = async (expense) => {
    setTxById((prev) => ({ ...prev, [expense.id]: { loading: true, error: null, transactions: [] } }));
    try {
      const data = await expensesAPI.getTransactions(expense.id);
      setTxById((prev) => ({ ...prev, [expense.id]: { loading: false, error: null, transactions: data.transactions || [] } }));
    } catch (err) {
      setTxById((prev) => ({ ...prev, [expense.id]: { loading: false, error: err.response?.data?.error || 'Failed to load transactions', transactions: [] } }));
    }
  };

  const toggleExpand = (expense) => {
    const next = expandedId === expense.id ? null : expense.id;
    setExpandedId(next);
    if (next !== null && !txById[expense.id]) fetchTransactions(expense);
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

  // Expenses past 2.0x their charge interval are dropped by the backend flag;
  // they fall off the list (and totals) but stay tracked, reappearing if the
  // merchant charges again.
  const visibleExpenses = useMemo(
    () => allExpenses.filter((e) => !e.is_dropped),
    [allExpenses]
  );

  const { totalAll, stats } = useMemo(() => {
    let total = 0, fixedTotal = 0, variableTotal = 0;
    visibleExpenses.forEach((e) => {
      const c = parseFloat(e.cost) || 0;
      total += c;
      if (e.is_fixed_rate) fixedTotal += c;
      else variableTotal += c;
    });
    return { totalAll: total, stats: { fixedTotal, variableTotal } };
  }, [visibleExpenses]);

  if (loading) {
    return <LoadingState label="Calculating Expenses" />;
  }

  return (
    <div className="container mx-auto px-4 py-6 md:py-8 max-w-[1600px]">
      {/* Hero Section */}
      <div className="flex flex-row items-start justify-between gap-3 mb-6 sm:items-end sm:gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <TrendingDown className="text-loss w-5 h-5" />
            <span className="text-[10px] font-bold uppercase tracking-wide text-secondary">Monthly Burn Rate</span>
          </div>
          <h1 className="text-3xl md:text-5xl font-bold text-primary tracking-tighter leading-none mb-2">
            {formatCurrency(totalAll)}
          </h1>
          <p className="text-sm text-secondary">Auto-detected across {visibleExpenses.length} recurring charges</p>
        </div>

        <div className="shrink-0 rounded border border-border bg-surface-2 p-2.5 shadow-sm sm:min-w-[140px] sm:p-3">
          <p className="text-[10px] font-bold text-tertiary uppercase tracking-wide mb-1">Annual Cost</p>
          <p className="text-base font-mono font-bold text-loss sm:text-lg">{formatCurrency(totalAll * 12)}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
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
        <div className="col-span-2 flex flex-row items-center justify-between gap-3 border border-border bg-surface p-3 sm:col-span-1 sm:flex-col sm:items-start sm:justify-start sm:gap-1.5 lg:flex-row lg:items-center lg:justify-between lg:gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-wide text-tertiary">Recurring Charges</p>
            <p className="font-mono text-lg font-bold text-primary">{visibleExpenses.length}</p>
            <p className="text-caption text-tertiary">Synced nightly from transactions</p>
          </div>
          <button
            onClick={ignoredPanel.openPanel}
            className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[10px] font-bold uppercase tracking-wide text-tertiary transition-colors hover:text-accent sm:-ml-1 lg:ml-0"
          >
            <EyeOff size={11} />
            Ignored
          </button>
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
                    {COLUMNS.map((col) => (
                      <th key={col.label} className={`px-2 py-4 text-[10px] font-bold uppercase tracking-wide text-tertiary sm:px-5 ${col.className}`}>{col.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  <AnimatePresence mode="popLayout">
                    {visibleExpenses.length === 0 ? (
                      <tr key="empty">
                        <td colSpan={visibleColumns} className="px-5 py-12 text-center">
                          <div className="flex flex-col items-center gap-3 opacity-40">
                            <Calendar size={32} className="text-tertiary" />
                            <p className="text-sm font-medium text-tertiary">No recurring charges detected yet</p>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      visibleExpenses.flatMap((exp) => {
                        const isExpanded = expandedId === exp.id;
                        const rows = [
                        <Motion.tr
                          layout
                          key={exp.id}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          onClick={() => toggleExpand(exp)}
                          aria-expanded={isExpanded}
                          className={`cursor-pointer transition-colors group ${isExpanded ? 'bg-surface-3' : 'hover:bg-surface-3'}`}
                        >
                          <td className="px-2 py-4 sm:px-5">
                            <div className="flex flex-wrap items-center gap-2">
                              <ChevronRight
                                size={14}
                                className={`shrink-0 transition-transform ${isExpanded ? 'rotate-90 text-accent' : 'text-tertiary group-hover:text-secondary'}`}
                              />
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
                              <div className="mt-1.5 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
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
                          <td className="hidden px-5 py-4 sm:table-cell"><Badge active={exp.is_fixed_rate}>{exp.is_fixed_rate ? 'Fixed' : 'Variable'}</Badge></td>
                          <td className="hidden px-5 py-4 md:table-cell">
                            <span className="text-xs font-medium text-secondary" title={exp.due_day ? `Typically billed on the ${formatDayOrdinal(exp.due_day)}` : undefined}>
                              {exp.last_charge_date ? formatDateDisplay(exp.last_charge_date) : <span className="text-tertiary">—</span>}
                            </span>
                          </td>
                          <td className="hidden px-5 py-4 xl:table-cell">
                            <span className="text-xs font-medium text-secondary">{exp.pay_account || <span className="text-tertiary">—</span>}</span>
                          </td>
                          <td className="hidden px-5 py-4 2xl:table-cell">
                            <span className="text-xs font-medium text-secondary">{exp.company || <span className="text-tertiary">—</span>}</span>
                          </td>
                          <td className="px-2 py-4 text-right sm:px-5" onClick={(e) => e.stopPropagation()}>
                            <div className="flex justify-end gap-1">
                              <button onClick={() => (taggingId === exp.id ? setTaggingId(null) : startTagging(exp))} className="shrink-0 p-2 border border-border bg-surface-2 text-accent hover:bg-accent/10 rounded transition-colors" title={exp.tag ? 'Edit tag' : 'Add tag'} aria-label={`${exp.tag ? 'Edit' : 'Add'} tag for ${exp.name}`}>
                                <Tag size={14} />
                              </button>
                              <button onClick={() => setIgnoringExpense(exp)} className="shrink-0 p-2 border border-border bg-surface-2 text-loss hover:bg-loss/10 rounded transition-colors" title="Ignore" aria-label={`Ignore ${exp.name}`}>
                                <EyeOff size={14} />
                              </button>
                            </div>
                          </td>
                        </Motion.tr>,
                        ];
                        if (isExpanded) {
                          // Plain <tr> (not Motion): it unmounts instantly on
                          // collapse. A Motion.tr here gets stuck mid-exit
                          // because AnimatePresence's popLayout absolutely-
                          // positions exiting rows, which breaks table layout.
                          rows.push(
                            <tr key={`${exp.id}-detail`} className="bg-base">
                              <td colSpan={visibleColumns} className="px-2 py-0 sm:px-5">
                                <Motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                                  <TransactionHistoryList detail={txById[exp.id]} />
                                </Motion.div>
                              </td>
                            </tr>
                          );
                        }
                        return rows;
                      })
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

      <IgnoreConfirmModal
        item={ignoringExpense}
        title="Ignore Charge"
        description={ignoringExpense && (
          <>Ignore <span className="text-primary font-bold">"{ignoringExpense.name}"</span>? It won't be counted or re-added by the nightly sync until you restore it from Ignored.</>
        )}
        submitting={ignoreSubmitting}
        onCancel={() => setIgnoringExpense(null)}
        onConfirm={handleIgnoreConfirm}
      />

      <IgnoredMerchantsModal
        open={ignoredPanel.open}
        onClose={ignoredPanel.closePanel}
        items={ignoredPanel.items}
        loading={ignoredPanel.loading}
        error={ignoredPanel.error}
        restoringKey={ignoredPanel.restoringKey}
        onRestore={ignoredPanel.restore}
      />
    </div>
  );
};

export default MonthlyExpenses;
