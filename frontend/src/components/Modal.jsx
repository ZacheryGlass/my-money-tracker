import React, { useEffect, useId, useRef } from 'react';
import { motion as Motion, AnimatePresence } from 'framer-motion';

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Open dialogs, innermost last: only the top one answers Escape and traps Tab,
// so a confirm opened from inside a form closes alone.
const stack = [];

const SIZES = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-3xl',
};

// The one dialog shell: role=dialog with a label, focus moved in on open and
// returned to whatever opened it on close, Tab kept inside, Escape and the
// backdrop both close. `sheet` docks it to the bottom edge on a phone, where a
// centered card leaves its buttons out of thumb reach.
export default function Modal({
  open,
  onClose,
  title,
  description,
  children,
  size = 'md',
  sheet = true,
  dismissible = true,
  className = '',
}) {
  const panelRef = useRef(null);
  const titleId = useId();
  const descriptionId = useId();
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  // Read through a ref: a busy confirm flips dismissible, and re-running the
  // focus effect for that sent focus out to the opener and back.
  const dismissibleRef = useRef(dismissible);
  useEffect(() => { dismissibleRef.current = dismissible; }, [dismissible]);

  useEffect(() => {
    if (!open) return undefined;
    const token = {};
    stack.push(token);
    const opener = document.activeElement;
    const panel = panelRef.current;
    // An autoFocus field inside wins; otherwise the first control.
    if (panel && !panel.contains(document.activeElement)) {
      (panel.querySelector('[autofocus]') || panel.querySelector(FOCUSABLE) || panel).focus();
    }
    const onKey = (event) => {
      if (stack[stack.length - 1] !== token) return;
      if (event.key === 'Escape' && dismissibleRef.current) {
        event.stopPropagation();
        closeRef.current?.();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const nodes = [...panelRef.current.querySelectorAll(FOCUSABLE)];
      if (nodes.length === 0) { event.preventDefault(); return; }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      stack.splice(stack.indexOf(token), 1);
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
    };
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <div className={`fixed inset-0 z-50 flex justify-center ${sheet ? 'items-end sm:items-center sm:p-4' : 'items-center p-4'}`}>
          <Motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/70"
            onClick={dismissible ? () => closeRef.current?.() : undefined}
          />
          <Motion.div
            ref={panelRef}
            initial={{ opacity: 0, scale: 0.97, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 12 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            aria-describedby={description ? descriptionId : undefined}
            tabIndex={-1}
            className={`relative w-full ${SIZES[size] || SIZES.md} max-h-[100dvh] overflow-y-auto border border-border bg-surface shadow-2xl outline-none ${
              sheet ? 'sm:max-h-[92vh] sm:rounded' : 'max-h-[90vh] rounded'
            } ${className}`}
          >
            {title && (
              <div className="px-5 pt-5 sm:px-6 sm:pt-6">
                <h2 id={titleId} className="text-title-md font-semibold text-primary">{title}</h2>
                {description && <p id={descriptionId} className="mt-1 text-body-sm text-secondary">{description}</p>}
              </div>
            )}
            {children}
          </Motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

// A yes/no question about one action. The confirm button names the action
// ("Remove label"), never a bare "OK", and stays busy until the request lands.
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'danger',
  busy = false,
  onConfirm,
  onCancel,
}) {
  return (
    <Modal open={open} onClose={busy ? undefined : onCancel} title={title} size="sm" dismissible={!busy}>
      <div className="space-y-3 px-5 pb-5 pt-3 text-body-sm text-secondary sm:px-6 sm:pb-6">
        {children}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded border border-border px-4 py-2 text-sm font-semibold text-secondary hover:text-primary disabled:opacity-40"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`rounded px-4 py-2 text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50 ${
              tone === 'danger' ? 'bg-loss' : 'bg-accent'
            }`}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
