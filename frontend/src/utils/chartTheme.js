import { createElement } from 'react';

export const CHART_COLORS = [
  '#00FFCC', '#3B82F6', '#A78BFA', '#F59E0B',
  '#EC4899', '#06B6D4', '#F97316', '#84CC16',
];

export const GRID_STYLE = {
  stroke: '#1E293B',
  strokeDasharray: '3 3',
};

export const AXIS_STYLE = {
  stroke: '#525D6E',
  fontSize: 11,
  tickLine: false,
  axisLine: { stroke: '#1E293B' },
};

export const TOOLTIP_STYLE = {
  bg: '#1C2230',
  border: '#2A3347',
  text: '#E8ECF1',
  label: '#8B95A5',
};

// Usage: <defs>{areaGradient('myId', '#00D4AA')}</defs>
export const areaGradient = (id, color, topOpacity = 0.25) =>
  createElement(
    'linearGradient',
    { id, x1: '0', y1: '0', x2: '0', y2: '1' },
    createElement('stop', { offset: '5%', stopColor: color, stopOpacity: topOpacity }),
    createElement('stop', { offset: '95%', stopColor: color, stopOpacity: 0 }),
  );
