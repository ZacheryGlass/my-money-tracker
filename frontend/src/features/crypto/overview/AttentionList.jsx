import React from 'react';
import { AlertTriangle, Check, ChevronRight } from 'lucide-react';

// What needs the user, in one place, each line a way to the page that fixes
// it. Items are { key, count, text, tone?: 'loss'|'review', page }.
export default function AttentionList({ items, onNavigate }) {
  const open = items.filter((item) => item.count > 0);
  return (
    <section aria-labelledby="crypto-attention-heading" className="card overflow-hidden">
      <h2 id="crypto-attention-heading" className="border-b border-border px-4 py-2 text-caption-upper uppercase text-secondary">
        Needs attention
      </h2>
      {open.length === 0 ? (
        <p className="flex items-center gap-2 px-4 py-3 text-body-sm text-gain">
          <Check size={14} /> Nothing needs your attention.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {open.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                onClick={() => onNavigate?.(item.page)}
                className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-body-sm transition-colors hover:bg-surface-2"
              >
                <span className={`flex items-center gap-2 ${item.tone === 'loss' ? 'text-loss' : 'text-orange-400'}`}>
                  <AlertTriangle size={13} className="shrink-0" />
                  <span><span className="font-semibold">{item.count.toLocaleString()}</span> {item.text}</span>
                </span>
                <ChevronRight size={14} className="shrink-0 text-tertiary" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
