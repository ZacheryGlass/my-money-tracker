import React from 'react';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';

const MetricCard = ({ label, value, change, trend = 'neutral', icon: Icon, valueColor = 'primary', caption, onClick }) => {
  const valueClass =
    valueColor === 'gain' ? 'text-gain' : valueColor === 'loss' ? 'text-loss' : valueColor === 'accent' ? 'text-accent' : 'text-primary';

  const changeClass = trend === 'up' ? 'text-gain' : trend === 'down' ? 'text-loss' : 'text-secondary';

  return (
    <div
      onClick={onClick}
      className={`card p-4 flex flex-col gap-2${onClick ? ' cursor-pointer hover:border-border-hover' : ''}`}
    >
      <div className="flex items-start justify-between">
        <div>
          <span className="text-caption text-tertiary uppercase tracking-wide">
            {label}
          </span>
          {change && (
            <div className={`flex items-center gap-1 mt-0.5 ${changeClass}`}>
              <span className="text-caption font-semibold">{change}</span>
              {trend === 'up' ? <ArrowUpRight size={12} /> : trend === 'down' ? <ArrowDownRight size={12} /> : null}
            </div>
          )}
        </div>
        {Icon && (
          <div className="p-1.5 bg-surface-2 border border-border text-tertiary">
            <Icon size={16} strokeWidth={1.5} />
          </div>
        )}
      </div>

      <div>
        <span className={`font-money font-semibold text-display-lg ${valueClass}`}>
          {value}
        </span>
        {caption && (
          <p className="mt-1 text-caption text-tertiary">
            {caption}
          </p>
        )}
      </div>
    </div>
  );
};

export default MetricCard;
