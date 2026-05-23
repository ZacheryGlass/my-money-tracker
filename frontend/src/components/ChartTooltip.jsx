import React from 'react';
import { TOOLTIP_STYLE } from '../utils/chartTheme';
import { formatCurrency } from '../utils/format';

const ChartTooltip = ({ active, payload, label, formatValue = formatCurrency, formatLabel }) => {
  if (!active || !payload || !payload.length) return null;

  const displayLabel = formatLabel ? formatLabel(label) : label;

  return (
    <div
      className="rounded-lg p-3 shadow-xl"
      style={{
        backgroundColor: TOOLTIP_STYLE.bg,
        border: `1px solid ${TOOLTIP_STYLE.border}`,
        minWidth: '160px',
      }}
    >
      <p className="text-xs mb-2" style={{ color: TOOLTIP_STYLE.label }}>
        {displayLabel}
      </p>
      {payload.map((entry, index) => (
        <div key={index} className="flex items-center justify-between gap-3 py-0.5">
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block rounded-full flex-shrink-0"
              style={{
                width: 8,
                height: 8,
                backgroundColor: entry.color,
              }}
            />
            <span className="text-xs" style={{ color: TOOLTIP_STYLE.label }}>
              {entry.name}
            </span>
          </div>
          <span
            className="text-xs font-money ml-2"
            style={{ color: TOOLTIP_STYLE.text }}
          >
            {entry.value != null ? formatValue(entry.value) : '-'}
          </span>
        </div>
      ))}
    </div>
  );
};

export default ChartTooltip;
