import React, { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';

const MENU_HEIGHT_ESTIMATE = 240;

// Fixed to the viewport rather than absolute inside the row: DataTable clips
// its overflow, which would cut the menu off on the last rows of a table.
const menuPosition = (button) => {
  const rect = button.getBoundingClientRect();
  const right = Math.max(8, window.innerWidth - rect.right);
  return rect.bottom + MENU_HEIGHT_ESTIMATE > window.innerHeight && rect.top > MENU_HEIGHT_ESTIMATE
    ? { position: 'fixed', right, bottom: window.innerHeight - rect.top + 4 }
    : { position: 'fixed', right, top: rect.bottom + 4 };
};

// The secondary actions of one table row behind a single button, so a row
// keeps room for its data on a phone and a desktop column alike. Each item is
// { key, label, ariaLabel?, title?, icon?, onSelect?, href?, disabled?, danger? }.
export default function RowMenu({ label, items }) {
  const [position, setPosition] = useState(null);
  const open = position !== null;
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const close = () => setPosition(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => {
      if (!rootRef.current?.contains(event.target)) setPosition(null);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        setPosition(null);
        buttonRef.current?.focus();
      }
    };
    // A fixed menu would float away from its row on scroll; closing is honest.
    const onMove = () => setPosition(null);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    rootRef.current?.querySelector('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  const itemClass = (item) => `flex w-full items-center gap-2 px-3 py-2 text-left text-body-sm transition-colors ${
    item.disabled
      ? 'cursor-not-allowed text-tertiary opacity-50'
      : item.danger
        ? 'text-loss hover:bg-loss/10'
        : 'text-secondary hover:bg-surface-3 hover:text-primary'
  }`;

  return (
    <div ref={rootRef} className="relative inline-block" onClick={(event) => event.stopPropagation()}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setPosition((value) => (value ? null : menuPosition(buttonRef.current)))}
        className="inline-flex h-7 w-7 items-center justify-center rounded border border-border bg-surface-3 text-tertiary transition-all hover:border-accent hover:text-accent"
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          style={position}
          className="z-50 min-w-[12rem] overflow-hidden rounded border border-border bg-surface-2 py-1 shadow-2xl"
        >
          {items.map((item) => {
            const Icon = item.icon;
            const content = (
              <>
                {Icon && <Icon size={13} className="shrink-0" />}
                <span>{item.label}</span>
              </>
            );
            if (item.href) {
              return (
                <a
                  key={item.key}
                  role="menuitem"
                  href={item.href}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={item.ariaLabel}
                  title={item.title}
                  className={itemClass(item)}
                  onClick={close}
                >
                  {content}
                </a>
              );
            }
            return (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                aria-label={item.ariaLabel}
                aria-disabled={item.disabled || undefined}
                title={item.title}
                className={itemClass(item)}
                onClick={() => {
                  if (item.disabled) return;
                  close();
                  item.onSelect?.();
                }}
              >
                {content}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
