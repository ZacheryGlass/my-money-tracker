import React from 'react';
import { formatCurrency } from '../../../utils/format';

const PARTS = [
  { key: 'wallet', label: 'Wallets', className: 'bg-crypto' },
  { key: 'exchange', label: 'Exchanges', className: 'bg-teal-500' },
  { key: 'manual', label: 'Manual accounts', className: 'bg-surface-3' },
];

// Where the value sits: self-custody wallets, exchanges, or accounts kept by
// hand. One bar, three parts, each with its dollars beside it.
export default function HeldWhere({ totals }) {
  const total = PARTS.reduce((sum, part) => sum + (totals[part.key] || 0), 0);
  if (!(total > 0)) return null;
  return (
    <section aria-labelledby="crypto-held-where-heading" className="card p-4">
      <h2 id="crypto-held-where-heading" className="text-caption-upper uppercase text-secondary">Where it is held</h2>
      <div className="mt-3 flex h-3 w-full overflow-hidden rounded bg-surface-2" aria-hidden>
        {PARTS.map((part) => (totals[part.key] > 0 ? (
          <div key={part.key} className={part.className} style={{ width: `${(totals[part.key] / total) * 100}%` }} />
        ) : null))}
      </div>
      <ul className="mt-3 grid gap-2 sm:grid-cols-3">
        {PARTS.map((part) => (
          <li key={part.key} className="flex items-center gap-2 text-body-sm">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${part.className}`} />
            <span className="text-secondary">{part.label}</span>
            <span className="ml-auto font-money text-primary">{formatCurrency(totals[part.key] || 0)}</span>
            <span className="w-10 text-right font-mono text-caption text-tertiary">
              {Math.round(((totals[part.key] || 0) / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
