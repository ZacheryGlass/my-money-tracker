import React, { useMemo, useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { useIsMobile } from '../hooks/useMediaQuery';
import { formatCurrency, formatDateAxis } from '../utils/format';
import { CHART_COLORS, GRID_STYLE, AXIS_STYLE } from '../utils/chartTheme';
import ChartTooltip from './ChartTooltip';
import { getAccountDisplayName } from '../utils/accountDisplay';

const PORTFOLIO_COLOR = '#00FFCC'; // Using accent color for portfolio

const CustomLegend = ({ payload, hiddenSeries, onToggle }) => {
  return (
    <div className="flex flex-wrap justify-center gap-x-4 gap-y-2 mt-4 px-4">
      {payload.map((entry, index) => {
        const isHidden = hiddenSeries.includes(entry.value);
        return (
          <button
            key={`item-${index}`}
            onClick={() => onToggle(entry.value)}
            className={`flex items-center gap-2 px-2 py-1 rounded-md transition-all border ${
              isHidden 
                ? 'opacity-40 grayscale border-transparent hover:opacity-60' 
                : 'opacity-100 border-border hover:border-accent/30 bg-surface-2/50'
            }`}
          >
            <div 
              className="w-2.5 h-2.5 rounded-full" 
              style={{ backgroundColor: entry.color }}
            />
            <span className={`text-[10px] md:text-xs font-medium ${isHidden ? 'text-tertiary' : 'text-secondary'}`}>
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
    <div className="flex items-center justify-center h-64 md:h-96 bg-surface rounded-card border border-border">
      <div className="text-sm md:text-base text-secondary text-center px-4">{children}</div>
    </div>
  );

  if (loading) return emptyContainer('Loading chart data...');
  if (error) return (
    <div className="flex items-center justify-center h-64 md:h-96 bg-surface rounded-card border border-border">
      <div className="text-sm md:text-base text-center px-4 text-loss">{error}</div>
    </div>
  );
  if (selectedAccounts.length === 0 && !showPortfolio) {
    return emptyContainer('Select at least one account or enable portfolio view');
  }
  if (chartData.length === 0) {
    return emptyContainer('No data available for the selected options');
  }

  return (
    <div className="bg-surface rounded-card border border-border p-4 md:p-6 mb-6">
      <div className="h-64 md:h-[450px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={chartData}
            margin={{ top: 10, right: isMobile ? 10 : 30, left: isMobile ? 0 : 20, bottom: 10 }}
          >
            <defs>
              <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="2" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
            </defs>
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
                strokeWidth={isMobile ? 1.5 : 2.5}
                dot={false}
                activeDot={{ r: isMobile ? 4 : 6, strokeWidth: 0 }}
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
                strokeWidth={isMobile ? 2 : 3.5}
                dot={false}
                activeDot={{ r: isMobile ? 5 : 7, strokeWidth: 0, fill: PORTFOLIO_COLOR }}
                connectNulls
                hide={hiddenSeries.includes('Total Portfolio')}
                animationDuration={1000}
                filter="url(#glow)"
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
