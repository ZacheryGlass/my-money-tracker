import React from 'react';
import { motion } from 'framer-motion';
import { TrendingUp, TrendingDown, Minus, ArrowUpRight, ArrowDownRight } from 'lucide-react';

const ACCENT_MAP = {
  gain: { border: '#10B981', glow: 'rgba(16, 185, 129, 0.08)' },
  loss: { border: '#F43F5E', glow: 'rgba(244, 63, 94, 0.08)' },
  primary: { border: '#1E293B', glow: 'transparent' },
  accent: { border: '#00FFCC', glow: 'rgba(0, 255, 204, 0.08)' },
};

const MetricCard = ({ label, value, change, trend = 'neutral', icon: Icon, valueColor = 'primary', onClick }) => {
  const valueClass =
    valueColor === 'gain' ? 'text-gain' : valueColor === 'loss' ? 'text-loss' : valueColor === 'accent' ? 'text-accent' : 'text-primary';

  const changeClass = trend === 'up' ? 'text-gain' : trend === 'down' ? 'text-loss' : 'text-secondary';
  const accent = ACCENT_MAP[valueColor] || ACCENT_MAP.primary;

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -5, transition: { duration: 0.2 } }}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className={`card p-6 flex flex-col gap-4 relative overflow-hidden group${onClick ? ' cursor-pointer' : ''}`}
      style={{
        borderLeft: `4px solid ${accent.border}`,
        background: `linear-gradient(135deg, ${accent.glow} 0%, rgba(15, 18, 22, 0) 60%, var(--bg-surface) 100%)`,
      }}
    >
      <div className="flex items-start justify-between relative z-10">
        <div className="space-y-1">
          <span className="text-xs font-bold tracking-[0.1em] uppercase text-tertiary">
            {label}
          </span>
          {change && (
            <div className={`flex items-center gap-1 ${changeClass}`}>
              <span className="text-xs font-bold uppercase tracking-wide">{change}</span>
              {trend === 'up' ? <ArrowUpRight size={14} /> : trend === 'down' ? <ArrowDownRight size={14} /> : null}
            </div>
          )}
        </div>
        {Icon && (
          <div className="p-3 rounded-2xl bg-surface-2 border border-border/50 text-secondary group-hover:text-accent group-hover:border-accent/30 group-hover:shadow-glow-sm transition-all duration-300">
            <Icon size={24} strokeWidth={2.5} />
          </div>
        )}
      </div>

      <div className="relative z-10">
        <span
          className={`font-money font-bold ${valueClass} tracking-tighter leading-none`}
          style={{ fontSize: 'clamp(1.75rem, 4vw, 2.5rem)' }}
        >
          {value}
        </span>
      </div>

      {/* Decorative background element */}
      <div className="absolute -right-6 -bottom-6 opacity-[0.04] group-hover:opacity-[0.08] transition-all duration-500 group-hover:scale-110 group-hover:-rotate-12 pointer-events-none">
        {Icon && <Icon size={120} strokeWidth={1} />}
      </div>
      
      {/* Gloss overlay */}
      <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
    </motion.div>
  );
};

export default MetricCard;
