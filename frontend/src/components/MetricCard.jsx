import React from 'react';

const ArrowUp = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ display: 'inline', verticalAlign: 'middle' }}>
    <path d="M6 2L10 8H2L6 2Z" fill="currentColor" />
  </svg>
);

const ArrowDown = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ display: 'inline', verticalAlign: 'middle' }}>
    <path d="M6 10L2 4H10L6 10Z" fill="currentColor" />
  </svg>
);

const MetricCard = ({ label, value, change, trend = 'neutral', icon, valueColor = 'primary' }) => {
  const valueClass =
    valueColor === 'gain' ? 'text-gain' : valueColor === 'loss' ? 'text-loss' : 'text-primary';

  const changeClass = trend === 'up' ? 'text-gain' : trend === 'down' ? 'text-loss' : 'text-secondary';

  return (
    <div className="card p-4 md:p-5 flex flex-col gap-2 animate-slide-up">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold tracking-widest uppercase text-secondary">
          {label}
        </span>
        {icon && <span className="text-tertiary">{icon}</span>}
      </div>
      <span
        className={`font-mono font-bold ${valueClass}`}
        style={{ fontSize: 'clamp(1.1rem, 2vw, 1.5rem)', lineHeight: 1.2 }}
      >
        {value}
      </span>
      {change && (
        <span className={`font-mono text-sm flex items-center gap-1 ${changeClass}`}>
          {trend === 'up' && <ArrowUp />}
          {trend === 'down' && <ArrowDown />}
          {change}
        </span>
      )}
    </div>
  );
};

export default MetricCard;
