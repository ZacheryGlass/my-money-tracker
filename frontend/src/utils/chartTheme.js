import { createElement } from 'react';

// Theme-aware series palette: resolves to the --chart-N tokens defined per
// theme in index.css (the dark values equal the previous hardcoded hexes).
export const CHART_COLORS = [
  'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)',
  'var(--chart-5)', 'var(--chart-6)', 'var(--chart-7)', 'var(--chart-8)',
];

export const GRID_STYLE = {
  stroke: 'var(--border-hover)',
  strokeDasharray: '3 3',
};

export const AXIS_STYLE = {
  stroke: 'var(--text-secondary)',
  fontSize: 13,
  tickLine: false,
  axisLine: { stroke: 'var(--border)' },
};

export const TOOLTIP_STYLE = {
  bg: 'var(--bg-surface-2)',
  border: 'var(--border-hover)',
  text: 'var(--text-primary)',
  label: 'var(--text-secondary)',
};

export const areaGradient = (id, color, topOpacity = 0.25) =>
  createElement(
    'linearGradient',
    { id, x1: '0', y1: '0', x2: '0', y2: '1' },
    createElement('stop', { offset: '5%', stopColor: color, stopOpacity: topOpacity }),
    createElement('stop', { offset: '95%', stopColor: color, stopOpacity: 0 }),
  );
