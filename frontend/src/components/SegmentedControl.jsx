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
// `label` is VISIBLE text; a caller whose row already names the control (a
// Settings heading) passes `ariaLabel` instead, which names the group for
// assistive tech without printing the name on screen twice.
const SegmentedControl = ({ label, ariaLabel, options, value, onChange, mobile = 'segments', className = '' }) => {
  const groupLabel = ariaLabel || label;
  // The select hands back a STRING; the segments hand back the value the caller
  // authored. Resolving through the option list keeps both renderings emitting
  // one identity, so a numeric-valued control does not start reporting strings
  // the day it grows past four options and gains mobile='select'.
  const handleSelect = (raw) => {
    const picked = options.find((option) => String(option.value) === raw);
    onChange(picked ? picked.value : raw);
  };

  const segments = (visibility) => (
    <div className={`${visibility} w-full items-center gap-2 sm:w-auto`}>
      {/* The label is a courtesy on desktop; on a phone its 50px can be the
          difference between the last segment fitting and clipping. */}
      {label && (
        <span className="hidden shrink-0 text-[9px] font-bold uppercase tracking-wide text-tertiary sm:inline">
          {label}
        </span>
      )}
      {/* Desktop scrolls instead of clipping when the option set is dynamic
          (Spending's account filter); mobile keeps equal-part stretch, and
          option counts that cannot fit a phone use mobile='select'. The
          scrollbar is hidden because index.css styles ::-webkit-scrollbar,
          which opts Chrome out of overlay bars -- a real 8px gutter inside a
          32px control would sit under the segments and misalign the row. */}
      <div
        className="flex min-w-0 flex-1 overflow-hidden rounded border border-input-border [scrollbar-width:none] sm:max-w-full sm:flex-initial sm:overflow-x-auto [&::-webkit-scrollbar]:hidden"
        role="group"
        aria-label={groupLabel}
      >
        {options.map((option, index) => (
          <button
            key={`opt-${String(option.value)}`}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={`inline-flex min-h-8 flex-1 items-center justify-center gap-1.5 px-2 text-center text-[10px] font-bold uppercase tracking-wide transition-colors sm:flex-initial sm:whitespace-nowrap sm:px-3 ${
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
  const dropdown = (
    <select
      value={value}
      onChange={(event) => handleSelect(event.target.value)}
      aria-label={label ? undefined : groupLabel}
      className="h-9 w-full min-w-0 rounded border border-input-border bg-surface-2 px-2 text-body-sm text-primary"
    >
      {options.map((option) => (
        <option key={`opt-${String(option.value)}`} value={option.value}>
          {option.selectLabel || option.label}
        </option>
      ))}
    </select>
  );

  return (
    <div className={className}>
      {label ? (
        <label className="flex w-full items-center gap-2 sm:hidden">
          <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-tertiary">{label}</span>
          {dropdown}
        </label>
      ) : (
        <div className="flex w-full sm:hidden">{dropdown}</div>
      )}
      {segments('hidden sm:flex')}
    </div>
  );
};

export default SegmentedControl;
