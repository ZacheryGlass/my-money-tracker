import React, { useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { useIsMobile } from '../hooks/useMediaQuery';
import { formatCurrency, formatDateAxis } from '../utils/format';
import { CHART_COLORS, GRID_STYLE, AXIS_STYLE } from '../utils/chartTheme';
import ChartTooltip from './ChartTooltip';

const PORTFOLIO_COLOR = '#6B7280';

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

  const { chartData, accountNameMap } = useMemo(() => {
    if (!accountData && !portfolioData) return { chartData: [], accountNameMap: {} };

    const nameMap = {};
    accounts.forEach((acc) => {
      nameMap[acc.id] = acc.name;
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

  const emptyContainer = (children) => (
    <div className="flex items-center justify-center h-64 md:h-96 bg-surface rounded-card border border-border">
      <div className="text-sm md:text-base text-secondary text-center px-4">{children}</div>
    </div>
  );

  if (loading) return emptyContainer('Loading chart data...');
  if (error) return (
    <div className="flex items-center justify-center h-64 md:h-96 bg-surface rounded-card border border-border">
      <div className="text-sm md:text-base text-center px-4" style={{ color: 'var(--loss)' }}>{error}</div>
    </div>
  );
  if (selectedAccounts.length === 0 && !showPortfolio) {
    return emptyContainer('Select at least one account or enable portfolio view');
  }
  if (chartData.length === 0) {
    return emptyContainer('No data available for the selected options');
  }

  return (
    <div className="bg-surface rounded-card border border-border p-4 h-64 md:h-96">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={chartData}
          margin={{ top: 5, right: isMobile ? 5 : 20, left: isMobile ? 0 : 10, bottom: 5 }}
        >
          <CartesianGrid {...GRID_STYLE} />
          <XAxis
            dataKey="date"
            tickFormatter={formatDateAxis}
            {...AXIS_STYLE}
            interval="preserveStartEnd"
          />
          <YAxis
            tickFormatter={formatCurrency}
            {...AXIS_STYLE}
            width={isMobile ? 60 : 80}
          />
          <Tooltip
            content={<ChartTooltip formatValue={formatCurrency} formatLabel={formatDateAxis} />}
          />
          <Legend
            wrapperStyle={{
              fontSize: isMobile ? '11px' : '12px',
              color: 'var(--text-secondary)',
              fontFamily: 'var(--font-mono, monospace)',
            }}
          />
          {selectedAccountNames.map((name, index) => (
            <Line
              key={name}
              type="monotone"
              dataKey={name}
              name={name}
              stroke={CHART_COLORS[index % CHART_COLORS.length]}
              strokeWidth={isMobile ? 1.5 : 2}
              dot={chartData.length < 30 ? { r: isMobile ? 2 : 3, fill: CHART_COLORS[index % CHART_COLORS.length] } : false}
              activeDot={{ r: isMobile ? 4 : 5 }}
              connectNulls
            />
          ))}
          {showPortfolio && (
            <Line
              type="monotone"
              dataKey="Total Portfolio"
              name="Total Portfolio"
              stroke={PORTFOLIO_COLOR}
              strokeWidth={isMobile ? 1.5 : 2}
              strokeDasharray="5 5"
              dot={chartData.length < 30 ? { r: isMobile ? 2 : 3, fill: PORTFOLIO_COLOR } : false}
              activeDot={{ r: isMobile ? 4 : 5 }}
              connectNulls
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default AccountHistoryChart;
