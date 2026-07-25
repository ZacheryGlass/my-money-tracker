import React from 'react';

// Page-level section switcher. Deliberately NOT FilterTabs: that treatment is
// for in-section filters, and a page carrying both (Crypto has page tabs up top
// and a transfer-type filter strip inside the activity feed) must not render
// them alike. This differs on several axes at once -- accent on the TOP edge,
// filled active tab, sentence-case body-sm, hairline cell separators, taller
// cells -- so the hierarchy survives any single axis being ambiguous. That
// redundancy is load-bearing in the light theme, where --accent and
// --accent-focus are the same value (index.css) and the accent-colour axis
// carries no signal at all.
//
// Unlike FilterTabs this does NOT collapse to a <select> on mobile: a dropdown
// under the page headline reads as another filter and hides the fact that other
// sections exist. Page level = scrolling strip, filter level = dropdown.
//
// No -mb-px anywhere: inside an overflow-x-auto container it creates a vertical
// scrollbar (see the note in FilterTabs).
const PageTabs = ({ label, options, value, onChange, className = '' }) => (
  <div className={`border-b border-border bg-surface ${className}`}>
    <div className="flex gap-px overflow-x-auto bg-border" role="tablist" aria-label={label}>
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange?.(option.value)}
            className={`flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap border-t-2 px-4 py-2.5 text-body-sm transition-colors lg:min-h-0 ${
              active
                ? 'border-accent-focus bg-base font-semibold text-primary'
                : 'border-transparent bg-surface text-tertiary hover:bg-surface-2 hover:text-primary'
            }`}
          >
            {option.label}
            {option.badge}
          </button>
        );
      })}
    </div>
  </div>
);

export default PageTabs;
