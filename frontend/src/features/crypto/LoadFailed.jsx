import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

// A failed read must never look like an empty one: "No wallets tracked" after
// a failed request invites re-adding what already exists and hides its history.
export default function LoadFailed({ message, onRetry }) {
  return (
    <div role="alert" className="card flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-secondary">
      <span className="flex items-center gap-2 text-loss">
        <AlertTriangle size={14} />
        {message}
      </span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-surface-3 px-3 text-[9px] font-bold uppercase tracking-wide text-tertiary transition-all hover:border-accent hover:text-accent"
        >
          <RefreshCw size={10} /> Retry
        </button>
      )}
    </div>
  );
}
