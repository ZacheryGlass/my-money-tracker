import React, { useMemo, useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { useIsMobile } from '../hooks/useMediaQuery';
import { formatCurrency, formatDateAxis } from '../utils/format';
import { CHART_COLORS, GRID_STYLE, AXIS_STYLE } from '../utils/chartTheme';
import ChartTooltip from './ChartTooltip';
import { getAccountDisplayName } from '../utils/accountDisplay';
import ResponsiveContainer from './ResponsiveContainer';

const PORTFOLIO_COLOR = '#3994BC';

const CustomLegend = ({ payload, hiddenSeries, onToggle }) => {
  return (
    <div className="flex flex-wrap justify-center gap-x-2 gap-y-1 mt-3 px-3">
      {payload.map((entry, index) => {
        const isHidden = hiddenSeries.includes(entry.value);
        return (
          <button
            key={`item-${index}`}
            onClick={() => onToggle(entry.value)}
            className={`flex items-center gap-1.5 px-2 py-1 transition-colors border ${
              isHidden
                ? 'opacity-40 border-transparent hover:opacity-60'
                : 'border-border hover:border-border-hover bg-surface-2'
            }`}
          >
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
            <span className={`text-caption ${isHidden ? 'text-tertiary' : 'text-secondary'}`}>
              {entry.value}
            </span>
          </button>
        );
      })}
    </div>
  );
};

const AccountHistoryChart = ({
  accountData,
  portfolioData,
  accounts,
  selectedAccounts,
  showPortfolio,
  loading,
  error,
}) => {
  const isMobile = useIsMobile();
  const [hiddenSeries, setHiddenSeries] = useState([]);

  const toggleSeries = (name) => {
    setHiddenSeries(prev => 
      prev.includes(name) 
        ? prev.filter(n => n !== name) 
        : [...prev, name]
    );
  };

  const { chartData, accountNameMap } = useMemo(() => {
    if (!accountData && !portfolioData) return { chartData: [], accountNameMap: {} };

    const nameMap = {};
    accounts.forEach((acc) => {
      nameMap[acc.id] = getAccountDisplayName(acc);
    });

    const dateMap = {};

    if (accountData) {
      accountData.forEach((item) => {
        const date = item.snapshot_date.split('T')[0];
        if (!dateMap[date]) dateMap[date] = { date };
        const name = nameMap[item.account_id] || `Account ${item.account_id}`;
        dateMap[date][name] = parseFloat(item.total_value);
      });
    }

    if (showPortfolio && portfolioData) {
      portfolioData.forEach((item) => {
        const date = item.snapshot_date.split('T')[0];
        if (!dateMap[date]) dateMap[date] = { date };
        dateMap[date]['Total Portfolio'] = parseFloat(item.total_value);
      });
    }

    const sorted = Object.values(dateMap).sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0
    );

    return { chartData: sorted, accountNameMap: nameMap };
  }, [accountData, portfolioData, accounts, showPortfolio]);

  const selectedAccountNames = useMemo(() => {
    return selectedAccounts.map((id) => accountNameMap[id] || `Account ${id}`);
  }, [selectedAccounts, accountNameMap]);

  const legendPayload = useMemo(() => {
    const payload = selectedAccountNames.map((name, index) => ({
      value: name,
      type: 'line',
      id: name,
      color: CHART_COLORS[index % CHART_COLORS.length]
    }));
    
    if (showPortfolio) {
      payload.unshift({
        value: 'Total Portfolio',
        type: 'line',
        id: 'Total Portfolio',
        color: PORTFOLIO_COLOR
      });
    }
    
    return payload;
  }, [selectedAccountNames, showPortfolio]);

  const emptyContainer = (children) => (
    <div className="flex items-center justify-center h-64 md:h-80 card">
      <div className="text-body-sm text-tertiary text-center px-4">{children}</div>
    </div>
  );

  if (loading) return emptyContainer('Loading chart data...');
  if (error) return (
    <div className="flex items-center justify-center h-64 md:h-80 card">
      <div className="text-body-sm text-center px-4 text-loss">{error}</div>
    </div>
  );
  if (selectedAccounts.length === 0 && !showPortfolio) {
    return emptyContainer('Select at least one account or enable portfolio view');
  }
  if (chartData.length === 0) {
    return emptyContainer('No data available for the selected options');
  }

  return (
    <div className="card p-4 mb-4">
      <div className="h-64 md:h-[400px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={chartData}
            margin={{ top: 10, right: isMobile ? 10 : 30, left: isMobile ? 0 : 20, bottom: 10 }}
          >
            <CartesianGrid {...GRID_STYLE} vertical={false} strokeOpacity={0.5} />
            <XAxis
              dataKey="date"
              tickFormatter={formatDateAxis}
              {...AXIS_STYLE}
              padding={{ left: 10, right: 10 }}
              minTickGap={30}
            />
            <YAxis
              tickFormatter={formatCurrency}
              {...AXIS_STYLE}
              width={isMobile ? 60 : 80}
              axisLine={false}
            />
            <Tooltip
              content={<ChartTooltip formatValue={formatCurrency} formatLabel={formatDateAxis} />}
              cursor={{ stroke: 'var(--border)', strokeWidth: 1 }}
            />
            {selectedAccountNames.map((name, index) => (
              <Line
                key={name}
                type="monotone"
                dataKey={name}
                name={name}
                stroke={CHART_COLORS[index % CHART_COLORS.length]}
                strokeWidth={isMobile ? 1 : 1.5}
                dot={false}
                activeDot={{ r: isMobile ? 3 : 4, strokeWidth: 0 }}
                connectNulls
                hide={hiddenSeries.includes(name)}
                animationDuration={1000}
              />
            ))}
            {showPortfolio && (
              <Line
                type="monotone"
                dataKey="Total Portfolio"
                name="Total Portfolio"
                stroke={PORTFOLIO_COLOR}
                strokeWidth={isMobile ? 1.5 : 2}
                dot={false}
                activeDot={{ r: isMobile ? 3 : 5, strokeWidth: 0, fill: PORTFOLIO_COLOR }}
                connectNulls
                hide={hiddenSeries.includes('Total Portfolio')}
                animationDuration={800}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
      
      <CustomLegend 
        payload={legendPayload} 
        hiddenSeries={hiddenSeries} 
        onToggle={toggleSeries} 
      />
    </div>
  );
};

export default AccountHistoryChart;
