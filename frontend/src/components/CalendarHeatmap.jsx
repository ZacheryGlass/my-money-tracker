import React, { useMemo, useState } from 'react';
import { formatCurrency, formatDateDisplay } from '../utils/format';

const CELL_SIZE = 14;
const CELL_GAP = 3;
const DAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function interpolateColor(ratio) {
  if (ratio === 0) return 'var(--bg-surface-3)';
  const r = Math.round(30 + ratio * (244 - 30));
  const g = Math.round(40 + ratio * (63 - 40));
  const b = Math.round(50 + ratio * (94 - 50));
  return `rgb(${r}, ${g}, ${b})`;
}

export default function CalendarHeatmap({ data = [], startDate, endDate }) {
  const [tooltip, setTooltip] = useState(null);

  const { cells, weeks, maxValue, monthMarkers } = useMemo(() => {
    const map = {};
    let max = 0;
    for (const d of data) {
      const key = String(d.date).slice(0, 10);
      const val = parseFloat(d.total) || 0;
      map[key] = val;
      if (val > max) max = val;
    }

    const start = startDate ? new Date(startDate + 'T00:00:00') : new Date(new Date().getFullYear(), 0, 1);
    const end = endDate ? new Date(endDate + 'T00:00:00') : new Date();

    const cells = [];
    const monthMarkers = [];
    let lastMonth = -1;
    const cursor = new Date(start);
    let weekIndex = 0;

    while (cursor <= end) {
      const dateStr = cursor.toISOString().slice(0, 10);
      const dayOfWeek = cursor.getDay();

      if (dayOfWeek === 0 && cells.length > 0) weekIndex++;

      const month = cursor.getMonth();
      if (month !== lastMonth) {
        monthMarkers.push({ label: MONTH_LABELS[month], weekIndex });
        lastMonth = month;
      }

      cells.push({
        date: dateStr,
        dayOfWeek,
        weekIndex,
        value: map[dateStr] || 0,
      });

      cursor.setDate(cursor.getDate() + 1);
    }

    return { cells, weeks: weekIndex + 1, maxValue: max, monthMarkers };
  }, [data, startDate, endDate]);

  const leftPad = 32;
  const topPad = 20;
  const svgWidth = leftPad + weeks * (CELL_SIZE + CELL_GAP) + CELL_GAP;
  const svgHeight = topPad + 7 * (CELL_SIZE + CELL_GAP) + CELL_GAP;

  return (
    <div className="relative">
      <svg
        width="100%"
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        className="overflow-visible"
      >
        {DAY_LABELS.map((label, i) =>
          label ? (
            <text
              key={i}
              x={leftPad - 6}
              y={topPad + i * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2 + 4}
              textAnchor="end"
              className="fill-tertiary"
              style={{ fontSize: 9, fontFamily: 'var(--font-sans)' }}
            >
              {label}
            </text>
          ) : null
        )}

        {monthMarkers.map((m, i) => (
          <text
            key={i}
            x={leftPad + m.weekIndex * (CELL_SIZE + CELL_GAP)}
            y={topPad - 6}
            textAnchor="start"
            className="fill-tertiary"
            style={{ fontSize: 9, fontFamily: 'var(--font-sans)' }}
          >
            {m.label}
          </text>
        ))}

        {cells.map((cell, i) => {
          const x = leftPad + cell.weekIndex * (CELL_SIZE + CELL_GAP);
          const y = topPad + cell.dayOfWeek * (CELL_SIZE + CELL_GAP);
          const ratio = maxValue > 0 ? cell.value / maxValue : 0;

          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={CELL_SIZE}
              height={CELL_SIZE}
              rx={3}
              fill={interpolateColor(ratio)}
              className="cursor-pointer transition-opacity hover:opacity-80"
              onMouseEnter={(e) => {
                const rect = e.target.getBoundingClientRect();
                setTooltip({
                  x: rect.left + rect.width / 2,
                  y: rect.top,
                  date: cell.date,
                  value: cell.value,
                });
              }}
              onMouseLeave={() => setTooltip(null)}
            />
          );
        })}
      </svg>

      {tooltip && (
        <div
          className="fixed z-50 px-3 py-2 rounded border pointer-events-none"
          style={{
            left: tooltip.x,
            top: tooltip.y - 48,
            transform: 'translateX(-50%)',
            backgroundColor: 'var(--bg-surface-2)',
            borderColor: 'var(--border)',
          }}
        >
          <div className="text-xs text-secondary">{formatDateDisplay(tooltip.date)}</div>
          <div className="text-sm font-money text-primary font-semibold">
            {tooltip.value > 0 ? formatCurrency(tooltip.value) : 'No spending'}
          </div>
        </div>
      )}
    </div>
  );
}
