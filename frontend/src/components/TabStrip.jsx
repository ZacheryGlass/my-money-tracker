import React from 'react';

// Underline tab strip on the standard hairline border. The -mb-px overlap
// lives on the scroll wrapper, not the buttons: putting it on the buttons
// inside an overflow-x-auto container creates a vertical scrollbar.
// `tabs` is [{ id, label, badge? }]; `actions` is an optional element pinned
// to the right of the strip.
const TabStrip = ({ tabs, active, onSelect, ariaLabel, actions, className = '' }) => (
  <div className={`flex items-center justify-between gap-3 border-b border-border ${className}`}>
    <div className="-mb-px flex min-w-0 overflow-x-auto" role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <button
          key={tab.id || 'all'}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onSelect(tab.id)}
          className={`whitespace-nowrap border-b-2 px-4 py-2 text-caption font-semibold uppercase tracking-wide transition-colors ${
            active === tab.id
              ? 'border-accent text-primary'
              : 'border-transparent text-tertiary hover:text-primary'
          }`}
        >
          {tab.label}
          {tab.badge}
        </button>
      ))}
    </div>
    {actions}
  </div>
);

export default TabStrip;
