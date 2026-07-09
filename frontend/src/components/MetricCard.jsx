import React from 'react';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';

const MetricCard = ({ label, value, change, trend = 'neutral', icon: Icon, valueColor = 'primary', caption, onClick }) => {
  const valueClass =
    valueColor === 'gain' ? 'text-gain' : valueColor === 'loss' ? 'text-loss' : valueColor === 'accent' ? 'text-accent' : 'text-primary';

  const changeClass = trend === 'up' ? 'text-gain' : trend === 'down' ? 'text-loss' : 'text-secondary';

  return (
    <div
      onClick={onClick}
      className={`card p-3.5 flex flex-col gap-1.5${onClick ? ' cursor-pointer hover:border-border-hover' : ''}`}
    >
      <div className="flex items-start justify-between">
        <div>
          <span className="text-caption-upper text-secondary uppercase">
            {label}
          </span>
          {change && (
            <div className={`flex items-center gap-1 mt-0.5 ${changeClass}`}>
              <span className="text-caption font-semibold">{change}</span>
              {trend === 'up' ? <ArrowUpRight size={14} /> : trend === 'down' ? <ArrowDownRight size={14} /> : null}
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
        <span className={`font-money font-semibold text-display-mega ${valueClass}`}>
          {value}
        </span>
        {caption && (
          <p className="mt-1 text-body-sm text-secondary">
            {caption}
          </p>
        )}
      </div>
    </div>
  );
};

export default MetricCard;
