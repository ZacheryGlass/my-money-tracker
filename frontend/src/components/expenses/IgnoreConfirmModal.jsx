import React from 'react';
import { motion as Motion, AnimatePresence } from 'framer-motion';
import { EyeOff } from 'lucide-react';

// Confirm popup for the ignore action, shared by the Monthly Expenses and Top
// Merchants pages. `item` controls visibility (null = closed); `description`
// is the page-specific consequence copy, rendered as-is.
const IgnoreConfirmModal = ({ item, title, description, submitting, onCancel, onConfirm }) => (
  <AnimatePresence>
    {item && (
      <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4">
        <Motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/60 " onClick={onCancel} />
        <Motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} className="relative w-full max-w-sm border border-border bg-surface p-5 text-center shadow-2xl sm:rounded-3xl sm:p-6">
          <div className="w-16 h-16 bg-loss/10 text-loss rounded-full flex items-center justify-center mx-auto mb-4">
            <EyeOff size={24} />
          </div>
          <h2 className="text-xl font-bold text-primary mb-2">{title}</h2>
          <p className="text-sm text-secondary mb-8">{description}</p>
          <div className="flex gap-3">
            <button onClick={onCancel} className="flex-1 py-3 bg-surface-3 text-secondary rounded text-xs font-bold uppercase tracking-wider hover:bg-surface-2 transition-all">Cancel</button>
            <button onClick={onConfirm} disabled={submitting} className="flex-1 py-3 bg-loss text-white rounded text-xs font-bold uppercase tracking-wider hover:opacity-90 transition-all disabled:opacity-50">Ignore</button>
          </div>
        </Motion.div>
      </div>
    )}
  </AnimatePresence>
);

export default IgnoreConfirmModal;
