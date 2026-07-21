import React from 'react';
import { Calendar, X } from 'lucide-react';
import { formatCurrency, formatDateDisplay } from '../../utils/format';
import { formatTransactionCategory } from '../../utils/dataLabels';
import LoadingState from '../LoadingState';

// The individual transactions behind an expanded table row, shared by the
// Monthly Expenses and Top Merchants pages. `detail` is { loading, error,
// transactions } as built by the host page's fetch helper.
const TransactionHistoryList = ({ detail, label = 'Charge history', noun = 'charge' }) => {
  if (!detail || detail.loading) {
    return <LoadingState label={null} className="py-6" />;
  }
  if (detail.error) {
    return (
      <div className="my-3 flex items-center gap-2 rounded border border-loss/20 bg-loss-bg px-3 py-2 text-xs text-loss">
        <X size={14} />
        {detail.error}
      </div>
    );
  }
  const { transactions } = detail;
  if (!transactions.length) {
    return <div className="py-6 text-center text-xs text-tertiary">No matching transactions found.</div>;
  }
  return (
    <div className="py-3">
      <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-tertiary">
        <Calendar size={11} />
        {label} · {transactions.length} {transactions.length === 1 ? noun : `${noun}s`}
      </div>
      <ul className="divide-y divide-border/60">
        {transactions.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-4 py-2">
            <div className="min-w-0">
              <div className="text-xs font-medium text-secondary">{formatDateDisplay(t.date)}</div>
              {/* Secondary detail; on small screens only date and amount show. */}
              <div className="mt-0.5 hidden flex-wrap items-center gap-x-2 text-[10px] text-tertiary sm:flex">
                {t.account && <span>{t.account}</span>}
                {t.account && t.category && <span className="opacity-40">·</span>}
                {t.category && <span>{formatTransactionCategory(t.category)}</span>}
              </div>
            </div>
            <span className="shrink-0 font-mono text-xs font-bold text-primary">{formatCurrency(t.amount)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default TransactionHistoryList;
