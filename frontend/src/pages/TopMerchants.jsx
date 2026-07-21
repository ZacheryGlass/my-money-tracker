import React, { useState, useEffect, useMemo } from 'react';
import { motion as Motion, AnimatePresence } from 'framer-motion';
import { EyeOff, X, Check, Store, Calendar, ChevronRight } from 'lucide-react';
import { expenses as expensesAPI } from '../utils/api';
import { formatCurrency, formatDateDisplay } from '../utils/format';
import { formatTransactionCategory } from '../utils/dataLabels';
import LoadingState from '../components/LoadingState';
import FilterTabs from '../components/FilterTabs';
import buildTransactionRows from '../components/expenses/TransactionHistoryRows';
import IgnoreConfirmModal from '../components/expenses/IgnoreConfirmModal';
import IgnoredMerchantsModal from '../components/expenses/IgnoredMerchantsModal';
import useIgnoredMerchants from '../hooks/useIgnoredMerchants';
import useTransientMessage from '../hooks/useTransientMessage';
import { useMediaQuery } from '../hooks/useMediaQuery';

const PERIOD_OPTIONS = [
  { value: 30, label: '30 Days' },
  { value: 60, label: '60 Days' },
  { value: 90, label: '90 Days' },
];

// Table columns, following the Monthly Expenses table conventions: fixed
// widths on constant-content columns, no width on Name/Account so table-fixed
// splits leftover space, optional columns revealing progressively. COL holds
// each optional column's visibility classes so the header, main rows and
// expanded transaction rows hide/show together.
const COL = {
  charges: 'hidden sm:table-cell',
  lastCharge: 'hidden md:table-cell',
  account: 'hidden xl:table-cell',
};
const COLUMNS = [
  { label: 'Name', className: 'text-left' },
  { label: 'Total Spent', className: 'w-24 text-left sm:w-28' },
  { label: 'Charges', className: `w-24 text-left ${COL.charges}` },
  { label: 'Last Charge', className: `w-32 text-left ${COL.lastCharge}` },
  { label: 'Account', className: `text-left ${COL.account}` },
  { label: 'Actions', className: 'w-16 text-right sm:w-20' },
];

const TopMerchants = () => {
  const [merchants, setMerchants] = useState([]);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [successMessage, showSuccess] = useTransientMessage();
  const [ignoringMerchant, setIgnoringMerchant] = useState(null);
  const [ignoreSubmitting, setIgnoreSubmitting] = useState(false);
  const [expandedKey, setExpandedKey] = useState(null);
  const [txByKey, setTxByKey] = useState({});

  // Number of currently visible table columns; must mirror the reveal
  // breakpoints in COLUMNS (see MonthlyExpenses for why colSpan must be exact).
  const isSm = useMediaQuery('(min-width: 640px)');
  const isMd = useMediaQuery('(min-width: 768px)');
  const isXl = useMediaQuery('(min-width: 1280px)');
  const visibleColumns = 3 + isSm + isMd + isXl;

  const fetchData = async (windowDays = days) => {
    setLoading(true);
    try {
      const data = await expensesAPI.getMerchants(windowDays);
      setMerchants(data.merchants || []);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load merchants');
    } finally {
      setLoading(false);
    }
  };

  // Window change invalidates both the ranking and each row's transaction
  // list, so the expansion state and cache reset with it.
  useEffect(() => {
    setExpandedKey(null);
    setTxByKey({});
    fetchData(days);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const ignoredPanel = useIgnoredMerchants({
    scope: 'merchants',
    onRestored: async (res, item) => {
      showSuccess(`Restored "${item.name || item.merchant_key}"`);
      await fetchData();
    },
    onError: setError,
  });

  const fetchTransactions = async (merchant) => {
    const key = merchant.merchant_key;
    setTxByKey((prev) => ({ ...prev, [key]: { loading: true, error: null, transactions: [] } }));
    try {
      const data = await expensesAPI.getMerchantTransactions(key, days);
      setTxByKey((prev) => ({ ...prev, [key]: { loading: false, error: null, transactions: data.transactions || [] } }));
    } catch (err) {
      setTxByKey((prev) => ({ ...prev, [key]: { loading: false, error: err.response?.data?.error || 'Failed to load transactions', transactions: [] } }));
    }
  };

  const toggleExpand = (merchant) => {
    const next = expandedKey === merchant.merchant_key ? null : merchant.merchant_key;
    setExpandedKey(next);
    if (next !== null && !txByKey[merchant.merchant_key]) fetchTransactions(merchant);
  };

  const handleIgnoreConfirm = async () => {
    if (ignoreSubmitting) return;
    const merchant = ignoringMerchant;
    setIgnoreSubmitting(true);
    setIgnoringMerchant(null);
    try {
      await expensesAPI.ignoreMerchant(merchant.merchant_key);
      showSuccess(`Ignored "${merchant.merchant_key}"`);
      await fetchData();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to ignore');
    } finally {
      setIgnoreSubmitting(false);
    }
  };

  const { totalSpend, totalCharges } = useMemo(() => {
    let spend = 0, charges = 0;
    merchants.forEach((m) => {
      spend += parseFloat(m.total) || 0;
      charges += m.charge_count || 0;
    });
    return { totalSpend: spend, totalCharges: charges };
  }, [merchants]);

  if (loading && merchants.length === 0) {
    return <LoadingState label="Ranking Merchants" />;
  }

  return (
    <div className="container mx-auto px-4 py-6 md:py-8 max-w-[1600px]">
      {/* Hero Section */}
      <div className="flex flex-row items-start justify-between gap-3 mb-6 sm:items-end sm:gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <Store className="text-loss w-5 h-5" />
            <span className="text-[10px] font-bold uppercase tracking-wide text-secondary">Top Merchants</span>
          </div>
          <h1 className="text-3xl md:text-5xl font-bold text-primary tracking-tighter leading-none mb-2">
            {formatCurrency(totalSpend)}
          </h1>
          <p className="text-sm text-secondary">Spent across {merchants.length} merchants in the last {days} days</p>
        </div>

        <div className="shrink-0 rounded border border-border bg-surface-2 p-2.5 shadow-sm sm:min-w-[140px] sm:p-3">
          <p className="text-[10px] font-bold text-tertiary uppercase tracking-wide mb-1">Per Day</p>
          <p className="text-base font-mono font-bold text-loss sm:text-lg">{formatCurrency(days ? totalSpend / days : 0)}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
        <div className="border border-border bg-surface p-3">
          <p className="text-[10px] font-bold uppercase tracking-wide text-tertiary">Charges</p>
          <p className="font-mono text-lg font-bold text-primary">{totalCharges}</p>
          <p className="text-caption text-tertiary">In the last {days} days</p>
        </div>
        <div className="border border-border bg-surface p-3">
          <p className="text-[10px] font-bold uppercase tracking-wide text-tertiary">Avg per Charge</p>
          <p className="font-mono text-lg font-bold text-loss">{formatCurrency(totalCharges ? totalSpend / totalCharges : 0)}</p>
          <p className="text-caption text-tertiary">Across all merchants shown</p>
        </div>
        <div className="col-span-2 flex flex-row items-center justify-between gap-3 border border-border bg-surface p-3 sm:col-span-1 sm:flex-col sm:items-start sm:justify-start sm:gap-1.5 lg:flex-row lg:items-center lg:justify-between lg:gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-wide text-tertiary">Merchants</p>
            <p className="font-mono text-lg font-bold text-primary">{merchants.length}</p>
            <p className="text-caption text-tertiary">Ranked by total spend</p>
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

          <FilterTabs
            id="merchant-period"
            label="Period"
            options={PERIOD_OPTIONS}
            value={days}
            onChange={(value) => setDays(Number(value))}
          />

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
                    {merchants.length === 0 ? (
                      <tr key="empty">
                        <td colSpan={visibleColumns} className="px-5 py-12 text-center">
                          <div className="flex flex-col items-center gap-3 opacity-40">
                            <Store size={32} className="text-tertiary" />
                            <p className="text-sm font-medium text-tertiary">No merchant spending in this period</p>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      merchants.flatMap((m) => {
                        const isExpanded = expandedKey === m.merchant_key;
                        const rows = [
                        <Motion.tr
                          layout
                          key={m.merchant_key}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          onClick={() => toggleExpand(m)}
                          aria-expanded={isExpanded}
                          className={`cursor-pointer transition-colors group ${isExpanded ? 'bg-surface-3' : 'hover:bg-surface-3'}`}
                        >
                          <td className="px-2 py-4 sm:px-5">
                            <div className="flex flex-wrap items-center gap-2">
                              <ChevronRight
                                size={14}
                                className={`shrink-0 transition-transform ${isExpanded ? 'rotate-90 text-accent' : 'text-tertiary group-hover:text-secondary'}`}
                              />
                              <div className="text-sm font-bold text-primary">{m.merchant_key}</div>
                            </div>
                          </td>
                          <td className="px-2 py-4 sm:px-5">
                            <span className="text-sm font-mono font-bold text-loss">{formatCurrency(m.total)}</span>
                          </td>
                          <td className={`px-5 py-4 ${COL.charges}`}>
                            <span className="text-xs font-medium text-secondary">{m.charge_count}</span>
                          </td>
                          <td className={`px-5 py-4 ${COL.lastCharge}`}>
                            <span className="text-xs font-medium text-secondary">
                              {m.last_date ? formatDateDisplay(m.last_date) : <span className="text-tertiary">—</span>}
                            </span>
                          </td>
                          <td className={`px-5 py-4 ${COL.account}`}>
                            <span className="text-xs font-medium text-secondary">
                              {m.account_count > 1 ? `${m.account_count} accounts` : (m.account || <span className="text-tertiary">—</span>)}
                            </span>
                          </td>
                          <td className="px-2 py-4 text-right sm:px-5" onClick={(e) => e.stopPropagation()}>
                            <div className="flex justify-end gap-1">
                              <button onClick={() => setIgnoringMerchant(m)} className="shrink-0 p-2 border border-border bg-surface-2 text-loss hover:bg-loss/10 rounded transition-colors" title="Ignore" aria-label={`Ignore ${m.merchant_key}`}>
                                <EyeOff size={14} />
                              </button>
                            </div>
                          </td>
                        </Motion.tr>,
                        ];
                        if (isExpanded) {
                          // Plain <tr>s (not Motion) for the same popLayout
                          // reason as the Monthly Expenses table.
                          rows.push(...buildTransactionRows(txByKey[m.merchant_key], {
                            keyPrefix: `${m.merchant_key}-tx`,
                            colSpan: visibleColumns,
                            label: 'Transactions',
                            noun: 'transaction',
                            renderCells: (t) => [
                              // Below md the Last Charge column is hidden, so
                              // the date takes the Name slot; the swap
                              // breakpoint must match COL.lastCharge.
                              <td key="name" className="px-2 py-2.5 sm:px-5">
                                <div className="truncate pl-[22px] text-xs font-medium text-secondary">
                                  <span className="md:hidden">{formatDateDisplay(t.date)}</span>
                                  <span className="hidden md:inline">{t.name || t.merchant_name}</span>
                                </div>
                              </td>,
                              <td key="total" className="px-2 py-2.5 sm:px-5">
                                <span className="text-xs font-mono font-medium text-secondary">{formatCurrency(t.amount)}</span>
                              </td>,
                              <td key="charges" className={`px-5 py-2.5 ${COL.charges}`}>
                                {t.category && <div className="truncate text-xs font-medium text-tertiary">{formatTransactionCategory(t.category)}</div>}
                              </td>,
                              <td key="last" className={`px-5 py-2.5 ${COL.lastCharge}`}>
                                <span className="text-xs font-medium text-secondary">{formatDateDisplay(t.date)}</span>
                              </td>,
                              <td key="account" className={`px-5 py-2.5 ${COL.account}`}>
                                {t.account && <div className="truncate text-xs font-medium text-secondary">{t.account}</div>}
                              </td>,
                              <td key="actions" className="px-2 py-2.5 sm:px-5" />,
                            ],
                          }));
                        }
                        return rows;
                      })
                    )}
                  </AnimatePresence>
                </tbody>
              </table>
            </div>
          </div>
      </div>

      <IgnoreConfirmModal
        item={ignoringMerchant}
        title="Ignore Merchant"
        description={ignoringMerchant && (
          <>Ignore <span className="text-primary font-bold">"{ignoringMerchant.merchant_key}"</span>? It will be hidden from this ranking until you restore it from Ignored. Recurring charges on Monthly Expenses are unaffected.</>
        )}
        submitting={ignoreSubmitting}
        onCancel={() => setIgnoringMerchant(null)}
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
        title="Ignored Merchants"
        footnote="Restoring brings the merchant back into the ranking immediately."
      />
    </div>
  );
};

export default TopMerchants;
