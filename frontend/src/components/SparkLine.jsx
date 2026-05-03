import React from 'react';
import { LineChart, Line, ResponsiveContainer } from 'recharts';

const SparkLine = ({ data = [], color, width = 80, height = 30 }) => {
  if (!data || data.length < 2) {
    return <div style={{ width, height }} />;
  }

  const first = data[0]?.value ?? 0;
  const last = data[data.length - 1]?.value ?? 0;

  const stroke = color || (last >= first ? 'var(--gain)' : 'var(--loss)');

  return (
    <ResponsiveContainer width={width} height={height}>
      <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
        <Line
          type="monotone"
          dataKey="value"
          stroke={stroke}
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
};

export default SparkLine;
