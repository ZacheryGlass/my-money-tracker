import React from 'react';

// PAGE NAVIGATION control: an underline tab strip on desktop, a labeled
// dropdown on mobile. Filters use SegmentedControl instead -- two strips
// stacked over one table read as one broken control. `options` is
// [{ value, label, badge?, selectLabel? }] — `badge` is an element shown on
// the desktop tab and `selectLabel` is its text fallback for the dropdown
// (options are text-only).
// An entry of { divider: true, hint } draws a separator in the strip (with the
// hint as a tiny caption) and opens an <optgroup> in the dropdown, so one strip
// can hold two families of tabs without reading as one flat list.
// In the strip, the -mb-px overlap lives on the scroll wrapper, not the
// buttons: putting it on the buttons inside an overflow-x-auto container
// creates a vertical scrollbar.
const FilterTabs = ({ id, label, options, value, onChange, className = '' }) => {
  // Partitioned once for the dropdown: options before the first divider are
  // plain <option>s, each divider starts an <optgroup> named by its hint. A
  // hint-less divider yields bare options (no <optgroup label="">), and empty
  // groups are dropped below rather than rendered as headings over nothing.
  const groups = [];
  let current = { hint: null, options: [] };
  for (const option of options) {
    if (option.divider) {
      groups.push(current);
      current = { hint: option.hint || null, options: [] };
    } else {
      current.options.push(option);
    }
  }
  groups.push(current);

  return (
    <div className={className}>
      <div className="sm:hidden">
        <label htmlFor={id} className="mb-2 block text-[10px] font-bold uppercase tracking-wide text-tertiary">
          {label}
        </label>
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-11 w-full rounded border border-border bg-surface-2 px-3 text-sm text-primary"
        >
          {groups.filter((group) => group.options.length > 0).map((group, groupIndex) => {
            const items = group.options.map((option) => (
              <option key={String(option.value)} value={option.value}>{option.selectLabel || option.label}</option>
            ));
            return group.hint != null
              ? <optgroup key={`group-${groupIndex}`} label={group.hint}>{items}</optgroup>
              : <React.Fragment key={`group-${groupIndex}`}>{items}</React.Fragment>;
          })}
        </select>
      </div>

      <div className="hidden border-b border-border sm:block">
        <div className="-mb-px flex min-w-0 overflow-x-auto" role="tablist" aria-label={label}>
          {options.map((option, index) => (
            option.divider ? (
              <div key={`divider-${index}`} aria-hidden className="flex shrink-0 items-center gap-1.5 px-2">
                <span className="h-4 w-px bg-border" />
                {option.hint && (
                  <span className="text-[8px] font-bold uppercase tracking-[0.14em] text-tertiary opacity-60">
                    {option.hint}
                  </span>
                )}
              </div>
            ) : (
              <button
                key={String(option.value)}
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
            )
          ))}
        </div>
      </div>
    </div>
  );
};

export default FilterTabs;
