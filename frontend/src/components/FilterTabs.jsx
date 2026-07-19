import React from 'react';
import TabStrip from './TabStrip';

// Single-choice control that renders as an underline tab strip on desktop and
// as a labeled dropdown on mobile. `options` is [{ value, label, badge?,
// selectLabel? }] — `badge` is an element shown on the desktop tab, and
// `selectLabel` is its text fallback for the dropdown (options are text-only).
// `actions` is an optional element pinned to the right on both layouts.
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

    <div className="hidden sm:block">
      <TabStrip
        tabs={options.map((option) => ({ id: option.value, label: option.label, badge: option.badge }))}
        active={value}
        onSelect={onChange}
        ariaLabel={label}
        actions={actions}
      />
    </div>
  </div>
);

export default FilterTabs;
