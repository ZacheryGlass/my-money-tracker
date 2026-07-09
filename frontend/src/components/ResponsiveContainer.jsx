import React from 'react';
import { ResponsiveContainer as RechartsResponsiveContainer } from 'recharts';

const INITIAL_DIMENSION = { width: 1, height: 1 };

const ResponsiveContainer = ({ children, initialDimension = INITIAL_DIMENSION, minWidth = 1, minHeight = 1, ...props }) => (
  <RechartsResponsiveContainer
    initialDimension={initialDimension}
    minWidth={minWidth}
    minHeight={minHeight}
    {...props}
  >
    {children}
  </RechartsResponsiveContainer>
);

export default ResponsiveContainer;
