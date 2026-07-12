import { ChevronDown, FilterX, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';

const FilterDisclosure = ({
  children,
  summary,
  activeCount = 0,
  onClear,
  label = 'Filters',
  defaultOpen = false,
}) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <section className="mb-3 border border-border bg-surface">
      <div className="flex min-h-12 items-center gap-2 px-3">
        <button
          type="button"
          onClick={() => setIsOpen((open) => !open)}
          aria-expanded={isOpen}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <SlidersHorizontal size={15} className="shrink-0 text-accent" />
          <span className="shrink-0 text-caption font-semibold uppercase tracking-wide text-primary">{label}</span>
          <span className="min-w-0 truncate text-caption text-tertiary">{summary}</span>
          {activeCount > 0 && (
            <span className="shrink-0 bg-accent-muted px-1.5 py-0.5 font-money text-caption text-accent">
              {activeCount} active
            </span>
          )}
          <ChevronDown size={15} className={`ml-auto shrink-0 text-tertiary transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>

        {activeCount > 0 && onClear && (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex shrink-0 items-center gap-1 border border-border bg-surface-2 px-2 py-1 text-caption text-secondary transition-colors hover:border-accent/40 hover:text-primary"
          >
            <FilterX size={12} /> Clear
          </button>
        )}
      </div>

      {isOpen && (
        <div className="border-t border-border bg-surface-2 p-3">
          {children}
        </div>
      )}
    </section>
  );
};

export default FilterDisclosure;
