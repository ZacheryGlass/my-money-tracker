import React from 'react';
import { Calendar, X } from 'lucide-react';
import LoadingState from '../LoadingState';

// Builds the <tr> rows for an expanded row's transaction history, shared by
// the Monthly Expenses and Top Merchants pages. Each transaction renders
// through the host table's own <td> structure (via renderCells), so detail
// rows line up with — and reveal/hide columns the same way as — the main
// rows, rather than an unrelated flex layout. Returns a flat array of <tr>
// elements to splice into the tbody.
export default function buildTransactionRows(detail, { keyPrefix, colSpan, renderCells, label = 'Charge history', noun = 'charge' }) {
  if (!detail || detail.loading) {
    return [
      <tr key={`${keyPrefix}-loading`} className="bg-base">
        <td colSpan={colSpan} className="px-2 sm:px-5"><LoadingState label={null} className="py-6" /></td>
      </tr>,
    ];
  }
  if (detail.error) {
    return [
      <tr key={`${keyPrefix}-error`} className="bg-base">
        <td colSpan={colSpan} className="px-2 py-3 sm:px-5">
          <div className="flex items-center gap-2 rounded border border-loss/20 bg-loss-bg px-3 py-2 text-xs text-loss">
            <X size={14} />
            {detail.error}
          </div>
        </td>
      </tr>,
    ];
  }
  const { transactions } = detail;
  if (!transactions.length) {
    return [
      <tr key={`${keyPrefix}-empty`} className="bg-base">
        <td colSpan={colSpan} className="px-2 py-6 text-center text-xs text-tertiary sm:px-5">No matching transactions found.</td>
      </tr>,
    ];
  }
  return [
    <tr key={`${keyPrefix}-header`} className="bg-base">
      <td colSpan={colSpan} className="px-2 pt-3 pb-1 sm:px-5">
        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-tertiary">
          <Calendar size={11} />
          {label} · {transactions.length} {transactions.length === 1 ? noun : `${noun}s`}
        </div>
      </td>
    </tr>,
    ...transactions.map((t) => (
      <tr key={`${keyPrefix}-${t.id}`} className="bg-base">
        {renderCells(t)}
      </tr>
    )),
  ];
}
