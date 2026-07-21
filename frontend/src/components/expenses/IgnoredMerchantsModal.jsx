import React from 'react';
import { motion as Motion, AnimatePresence } from 'framer-motion';
import { EyeOff, Eye, RotateCcw, X } from 'lucide-react';
import { formatCurrency, formatDateDisplay } from '../../utils/format';
import LoadingState from '../LoadingState';

// The Ignored panel, shared by the Monthly Expenses and Top Merchants pages.
// Each page passes its own scope's items (see useIgnoredMerchants) plus
// page-appropriate title/footnote copy.
const IgnoredMerchantsModal = ({ open, onClose, items, loading, error, restoringKey, onRestore, title = 'Ignored Charges', footnote = 'Restoring re-runs detection so the charge reappears immediately.' }) => (
  <AnimatePresence>
    {open && (
      <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
        <Motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/60 " onClick={onClose} />
        <Motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} className="relative flex max-h-[100dvh] w-full max-w-lg flex-col overflow-hidden border border-border bg-surface shadow-2xl sm:max-h-[92vh] sm:rounded-3xl">
          <div className="flex shrink-0 items-center justify-between border-b border-border p-4 sm:p-6">
            <div className="flex items-center gap-2">
              <EyeOff size={18} className="text-secondary" />
              <h2 className="text-lg font-bold text-primary">{title}</h2>
            </div>
            <button onClick={onClose} className="text-tertiary hover:text-primary transition-colors"><X size={20} /></button>
          </div>
          <div className="overflow-y-auto p-4 sm:p-6">
            {loading ? (
              <LoadingState label={null} className="py-8" />
            ) : error ? (
              <div className="p-4 bg-loss-bg border border-loss/20 text-loss rounded text-xs flex items-center gap-3">
                <X size={16} />
                {error}
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-8 opacity-40">
                <Eye size={32} className="text-tertiary" />
                <p className="text-sm font-medium text-tertiary">Nothing ignored</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {items.map((item) => (
                  <div key={item.merchant_key} className="flex items-center justify-between gap-4 py-3">
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-primary truncate">{item.name || item.merchant_key}</div>
                      <div className="flex items-center gap-3 mt-0.5 text-[10px] text-tertiary">
                        {item.last_cost != null && <span className="font-mono">{formatCurrency(item.last_cost)}/mo</span>}
                        <span>Ignored {formatDateDisplay(item.created_at)}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => onRestore(item)}
                      disabled={restoringKey === item.merchant_key}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-accent/10 text-accent border border-accent/30 rounded text-[10px] font-bold uppercase tracking-wider hover:bg-accent hover:text-white transition-all disabled:opacity-50"
                    >
                      <RotateCcw size={12} />
                      {restoringKey === item.merchant_key ? 'Restoring' : 'Restore'}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-4 text-caption text-tertiary">{footnote}</p>
          </div>
        </Motion.div>
      </div>
    )}
  </AnimatePresence>
);

export default IgnoredMerchantsModal;
