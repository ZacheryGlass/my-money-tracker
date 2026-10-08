import React from 'react';
import { ChevronRight } from 'lucide-react';

// The one-sentence summary stays on the page; the mechanics a curious user
// wants (and most do not) fold away under it.
export default function HowThisWorks({ children, label = 'How this works', className = '' }) {
  return (
    <details className={`group mt-1 text-xs text-secondary ${className}`}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-tertiary transition-colors hover:text-accent [&::-webkit-details-marker]:hidden">
        <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
        {label}
      </summary>
      <div className="mt-1 max-w-3xl space-y-1 leading-relaxed">{children}</div>
    </details>
  );
}
