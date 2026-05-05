import React from 'react';
import { LineChart, Line, ResponsiveContainer } from 'recharts';

const SparkLine = ({ data = [], color, width = 100, height = 32 }) => {
  if (!data || data.length < 2) {
    return <div style={{ width, height }} className="flex items-center justify-center opacity-20">—</div>;
  }

  const first = data[0]?.value ?? 0;
  const last = data[data.length - 1]?.value ?? 0;

  const stroke = color || (last >= first ? 'var(--gain)' : 'var(--loss)');

  return (
    <div style={{ width, height }} className="overflow-hidden">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <Line
            type="monotone"
            dataKey="value"
            stroke={stroke}
            strokeWidth={2}
            dot={false}
            isAnimationActive={true}
            animationDuration={1000}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default SparkLine;
