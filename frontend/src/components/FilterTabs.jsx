import React from 'react';

// Single-choice control that renders as an underline tab strip on desktop and
// as a labeled dropdown on mobile. `options` is [{ value, label, badge?,
// selectLabel? }] — `badge` is an element shown on the desktop tab, and
// `selectLabel` is its text fallback for the dropdown (options are text-only).
// `actions` is an optional element pinned to the right on both layouts.
// In the strip, the -mb-px overlap lives on the scroll wrapper, not the
// buttons: putting it on the buttons inside an overflow-x-auto container
// creates a vertical scrollbar.
const FilterTabs = ({ id, label, options, value, onChange, actions, className = '' }) => (
  <div className={className}>
    <div className="flex items-end gap-3 sm:hidden">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="mb-2 block text-[10px] font-bold uppercase tracking-wide text-tertiary">
          {label}
        </label>
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-11 w-full rounded border border-border bg-surface-2 px-3 text-sm text-primary"
        >
          {options.map((option) => (
            <option key={option.value || 'all'} value={option.value}>{option.selectLabel || option.label}</option>
          ))}
        </select>
      </div>
      {actions}
    </div>

    <div className="hidden items-center justify-between gap-3 border-b border-border sm:flex">
      <div className="-mb-px flex min-w-0 overflow-x-auto" role="tablist" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value || 'all'}
            type="button"
            role="tab"
            aria-selected={value === option.value}
            onClick={() => onChange(option.value)}
            className={`whitespace-nowrap border-b-2 px-4 py-2 text-caption font-semibold uppercase tracking-wide transition-colors ${
              value === option.value
                ? 'border-accent text-primary'
                : 'border-transparent text-tertiary hover:text-primary'
            }`}
          >
            {option.label}
            {option.badge}
          </button>
        ))}
      </div>
      {actions}
    </div>
  </div>
);

export default FilterTabs;
