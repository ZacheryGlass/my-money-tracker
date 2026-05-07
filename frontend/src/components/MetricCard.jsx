import React from 'react';
import { motion } from 'framer-motion';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

const ACCENT_MAP = {
  gain: { border: 'var(--gain)', glow: 'rgba(16, 185, 129, 0.05)' },
  loss: { border: 'var(--loss)', glow: 'rgba(244, 63, 94, 0.05)' },
  primary: { border: 'var(--border)', glow: 'transparent' },
  accent: { border: 'var(--accent)', glow: 'rgba(0, 255, 204, 0.05)' },
};

const MetricCard = ({ label, value, change, trend = 'neutral', icon: Icon, valueColor = 'primary', onClick }) => {
  const valueClass =
    valueColor === 'gain' ? 'text-gain' : valueColor === 'loss' ? 'text-loss' : valueColor === 'accent' ? 'text-accent' : 'text-primary';

  const changeClass = trend === 'up' ? 'text-gain' : trend === 'down' ? 'text-loss' : 'text-secondary';
  const accent = ACCENT_MAP[valueColor] || ACCENT_MAP.primary;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -4, transition: { duration: 0.2 } }}
      onClick={onClick}
      className={`card p-5 flex flex-col gap-3 relative overflow-hidden group${onClick ? ' cursor-pointer' : ''}`}
      style={{
        borderLeft: `4px solid ${accent.border}`,
        background: `linear-gradient(135deg, ${accent.glow} 0%, var(--bg-surface) 100%)`,
      }}
    >
      <div className="flex items-start justify-between">
        <span className="text-[11px] font-bold tracking-widest uppercase text-tertiary">
          {label}
        </span>
        {Icon && (
          <div className="p-2 rounded-lg bg-surface-2 text-secondary group-hover:text-accent transition-colors">
            <Icon size={18} strokeWidth={2} />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span
          className={`font-money font-bold ${valueClass} tracking-tight`}
          style={{ fontSize: 'clamp(1.25rem, 2.5vw, 1.75rem)', lineHeight: 1.1 }}
        >
          {value}
        </span>
        
        {change && (
          <div className={`flex items-center gap-1.5 ${changeClass}`}>
            <div className={`p-0.5 rounded-full ${trend === 'up' ? 'bg-gain/10' : trend === 'down' ? 'bg-loss/10' : 'bg-surface-3'}`}>
              {trend === 'up' && <TrendingUp size={12} />}
              {trend === 'down' && <TrendingDown size={12} />}
              {trend === 'neutral' && <Minus size={12} />}
            </div>
            <span className="font-money text-xs font-semibold">
              {change}
            </span>
          </div>
        )}
      </div>

      {/* Decorative background element */}
      <div className="absolute -right-4 -bottom-4 opacity-[0.03] group-hover:opacity-[0.06] transition-opacity pointer-events-none">
        {Icon && <Icon size={80} strokeWidth={1} />}
      </div>
    </motion.div>
  );
};

export default MetricCard;
