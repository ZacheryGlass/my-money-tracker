import React from 'react';

// Labeled single-choice segmented control -- the filter grammar for anything
// sitting below a page's tab strip. Underline tabs mean navigation (that is
// FilterTabs); a filter says its name and looks like a control. `options` is
// [{ value, label, badge?, selectLabel?, activeClassName? }]: `badge` renders
// after the label in the segments (counts, tones), `selectLabel` is its
// text-only fallback in the mobile dropdown, and `activeClassName` overrides
// the selected tone for that one option (the ledger's Needs review runs
// orange). `mobile` picks the small-screen rendering: 'segments' stretches the
// group to full-width equal parts -- fine for three options -- while 'select'
// swaps in a labeled dropdown, because six segments cannot fit a phone.
const SegmentedControl = ({ id, label, options, value, onChange, mobile = 'segments', className = '' }) => {
  const segments = (visibility) => (
    <div className={`${visibility} w-full items-center gap-2 sm:w-auto`}>
      {/* The label is a courtesy on desktop; on a phone its 50px can be the
          difference between the last segment fitting and clipping. */}
      {label && (
        <span className="hidden shrink-0 text-[9px] font-bold uppercase tracking-wide text-tertiary sm:inline">
          {label}
        </span>
      )}
      <div
        className="flex min-w-0 flex-1 overflow-hidden rounded border border-input-border sm:flex-initial"
        role="group"
        aria-label={label}
      >
        {options.map((option, index) => (
          <button
            key={String(option.value) || 'all'}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={`inline-flex min-h-8 flex-1 items-center justify-center gap-1.5 px-2 text-center text-[10px] font-bold uppercase tracking-wide transition-colors sm:flex-initial sm:px-3 ${
              index > 0 ? 'border-l border-input-border' : ''
            } ${
              value === option.value
                ? option.activeClassName || 'bg-accent/15 text-accent'
                : 'bg-surface-2 text-tertiary hover:text-primary'
            }`}
          >
            {option.label}
            {option.badge}
          </button>
        ))}
      </div>
    </div>
  );

  if (mobile !== 'select') return <div className={className}>{segments('flex')}</div>;

  // Like FilterTabs, both renderings mount and CSS picks one -- so anything
  // asserting on the segments must expect the dropdown beside them.
  return (
    <div className={className}>
      <label className="flex w-full items-center gap-2 sm:hidden">
        <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-tertiary">{label}</span>
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 w-full min-w-0 rounded border border-input-border bg-surface-2 px-2 text-body-sm text-primary"
        >
          {options.map((option) => (
            <option key={String(option.value) || 'all'} value={option.value}>
              {option.selectLabel || option.label}
            </option>
          ))}
        </select>
      </label>
      {segments('hidden sm:flex')}
    </div>
  );
};

export default SegmentedControl;
