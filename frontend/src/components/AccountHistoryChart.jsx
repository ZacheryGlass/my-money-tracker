import React, { useMemo } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import { format, parseISO } from 'date-fns';

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
);

// Color palette for accounts
const COLORS = [
  'rgb(59, 130, 246)',   // blue
  'rgb(16, 185, 129)',   // green
  'rgb(245, 158, 11)',   // amber
  'rgb(239, 68, 68)',    // red
  'rgb(139, 92, 246)',   // violet
  'rgb(236, 72, 153)',   // pink
  'rgb(6, 182, 212)',    // cyan
  'rgb(249, 115, 22)',   // orange
];

const formatCurrency = (value) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
};

const AccountHistoryChart = ({ 
  accountData, 
  portfolioData, 
  accounts, 
  selectedAccounts, 
  showPortfolio,
  loading,
  error 
}) => {
  const chartData = useMemo(() => {
    if (loading || error) return null;
    
    // Get all unique dates from both account and portfolio data
    const allDates = new Set();
    
    if (showPortfolio && portfolioData) {
      portfolioData.forEach(item => allDates.add(item.snapshot_date));
    }
    
    if (accountData) {
      accountData.forEach(item => allDates.add(item.snapshot_date));
    }
    
    const sortedDates = Array.from(allDates).sort();
    
    if (sortedDates.length === 0) return null;

    // Create a map of account_id -> account name
    const accountNameMap = {};
    accounts.forEach(acc => {
      accountNameMap[acc.id] = acc.name;
    });

    // Group account data by account_id and date
    const accountDataByIdAndDate = {};
    if (accountData) {
      accountData.forEach(item => {
        if (!accountDataByIdAndDate[item.account_id]) {
          accountDataByIdAndDate[item.account_id] = {};
        }
        accountDataByIdAndDate[item.account_id][item.snapshot_date] = parseFloat(item.total_value);
      });
    }

    // Group portfolio data by date
    const portfolioByDate = {};
    if (portfolioData) {
      portfolioData.forEach(item => {
        portfolioByDate[item.snapshot_date] = parseFloat(item.total_value);
      });
    }

    const datasets = [];

    // Add account datasets
    selectedAccounts.forEach((accountId, index) => {
      const accountName = accountNameMap[accountId] || `Account ${accountId}`;
      const color = COLORS[index % COLORS.length];
      
      datasets.push({
        label: accountName,
        data: sortedDates.map(date => accountDataByIdAndDate[accountId]?.[date] ?? null),
        borderColor: color,
        backgroundColor: color,
        tension: 0.1,
        spanGaps: true,
        pointRadius: sortedDates.length > 30 ? 0 : 3,
        pointHoverRadius: 5,
      });
    });

    // Add portfolio dataset if enabled
    if (showPortfolio) {
      datasets.push({
        label: 'Total Portfolio',
        data: sortedDates.map(date => portfolioByDate[date] ?? null),
        borderColor: 'rgb(75, 85, 99)',
        backgroundColor: 'rgb(75, 85, 99)',
        borderWidth: 3,
        tension: 0.1,
        spanGaps: true,
        pointRadius: sortedDates.length > 30 ? 0 : 3,
        pointHoverRadius: 5,
        borderDash: [5, 5],
      });
    }

    return {
      labels: sortedDates.map(date => format(parseISO(date), 'MMM d, yyyy')),
      datasets,
    };
  }, [accountData, portfolioData, accounts, selectedAccounts, showPortfolio, loading, error]);

  const options = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    plugins: {
      legend: {
        position: 'top',
        labels: {
          usePointStyle: true,
          padding: 15,
        },
      },
      title: {
        display: true,
        text: 'Account Value History',
        font: {
          size: 16,
          weight: 'bold',
        },
        padding: {
          bottom: 20,
        },
      },
      tooltip: {
        callbacks: {
          label: function(context) {
            const label = context.dataset.label || '';
            const value = context.parsed.y;
            if (value !== null) {
              return `${label}: ${formatCurrency(value)}`;
            }
            return label;
          },
        },
      },
    },
    scales: {
      x: {
        display: true,
        title: {
          display: true,
          text: 'Date',
        },
        ticks: {
          maxRotation: 45,
          minRotation: 45,
        },
      },
      y: {
        display: true,
        title: {
          display: true,
          text: 'Value (USD)',
        },
        ticks: {
          callback: function(value) {
            return formatCurrency(value);
          },
        },
      },
    },
  }), []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96 bg-white rounded-lg shadow">
        <div className="text-gray-500">Loading chart data...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-96 bg-white rounded-lg shadow">
        <div className="text-red-500">{error}</div>
      </div>
    );
  }

  if (!chartData || chartData.datasets.length === 0) {
    return (
      <div className="flex items-center justify-center h-96 bg-white rounded-lg shadow">
        <div className="text-gray-500">
          {selectedAccounts.length === 0 && !showPortfolio
            ? 'Select at least one account or enable portfolio view'
            : 'No data available for the selected options'}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow p-4 h-96">
      <Line data={chartData} options={options} />
    </div>
  );
};

export default AccountHistoryChart;
