import { createElement } from 'react';

export const CHART_COLORS = [
  '#3994BC', '#72C892', '#e5ba7d', '#79c0ff',
  '#f48771', '#73c991', '#c9a0ff', '#7ee0c0',
];

export const GRID_STYLE = {
  stroke: '#2A2B2C',
  strokeDasharray: '3 3',
};

export const AXIS_STYLE = {
  stroke: '#8C8C8C',
  fontSize: 11,
  tickLine: false,
  axisLine: { stroke: '#2A2B2C' },
};

export const TOOLTIP_STYLE = {
  bg: '#202122',
  border: '#333536',
  text: '#ededed',
  label: '#8C8C8C',
};

export const areaGradient = (id, color, topOpacity = 0.25) =>
  createElement(
    'linearGradient',
    { id, x1: '0', y1: '0', x2: '0', y2: '1' },
    createElement('stop', { offset: '5%', stopColor: color, stopOpacity: topOpacity }),
    createElement('stop', { offset: '95%', stopColor: color, stopOpacity: 0 }),
  );
