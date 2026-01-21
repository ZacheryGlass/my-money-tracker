import React, { useState, useEffect, useMemo } from 'react';
import { dashboard as dashboardAPI } from '../utils/api';
import DashboardTable from './DashboardTable';

const formatCurrency = (value) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value);
};

const Dashboard = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = async () => {
    try {
      const result = await dashboardAPI.getPortfolio();
      setData(result);
      setError(null);
    } catch (err) {
      console.error('Error fetching dashboard:', err);
      setError(err.response?.data?.error || 'Failed to load dashboard');
    }
  };

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      await fetchData();
      setLoading(false);
    };
    loadData();
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  };

  // Calculate totals from items
  const { totalAssets, totalLiabilities, netWorth } = useMemo(() => {
    if (!data?.items) {
      return { totalAssets: 0, totalLiabilities: 0, netWorth: 0 };
    }

    let assets = 0;
    let liabilities = 0;

    data.items.forEach((item) => {
      if (item.type === 'liability') {
        liabilities += Math.abs(item.value);
      } else {
        assets += item.value;
      }
    });

    return {
      totalAssets: assets,
      totalLiabilities: liabilities,
      netWorth: assets - liabilities,
    };
  }, [data]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-xl text-gray-600">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="p-4 bg-red-100 border border-red-400 text-red-700 rounded">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-4 md:py-8">
      <div className="mb-4 md:mb-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4">
          <h1 className="text-2xl md:text-3xl font-bold text-gray-900">Portfolio Dashboard</h1>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="w-full sm:w-auto px-4 py-2 text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:bg-blue-400 touch-manipulation"
          >
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        {/* Last Updated */}
        {data?.lastUpdated && (
          <p className="text-sm text-gray-500 mb-6">
            Last updated: {new Date(data.lastUpdated).toLocaleString()}
          </p>
        )}

        {/* Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4 mb-4 md:mb-6">
          <div className="bg-white shadow-md rounded-lg p-4 md:p-6">
            <h3 className="text-xs md:text-sm font-medium text-gray-500 uppercase tracking-wider">Total Assets</h3>
            <p className="mt-1 md:mt-2 text-xl md:text-2xl font-bold text-green-600">
              {formatCurrency(totalAssets)}
            </p>
          </div>
          <div className="bg-white shadow-md rounded-lg p-4 md:p-6">
            <h3 className="text-xs md:text-sm font-medium text-gray-500 uppercase tracking-wider">Total Liabilities</h3>
            <p className="mt-1 md:mt-2 text-xl md:text-2xl font-bold text-red-600">
              {formatCurrency(totalLiabilities)}
            </p>
          </div>
          <div className="bg-white shadow-md rounded-lg p-4 md:p-6 sm:col-span-2 lg:col-span-1">
            <h3 className="text-xs md:text-sm font-medium text-gray-500 uppercase tracking-wider">Net Worth</h3>
            <p className={`mt-1 md:mt-2 text-xl md:text-2xl font-bold ${netWorth >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {formatCurrency(netWorth)}
            </p>
          </div>
        </div>
      </div>

      {/* Dashboard Table */}
      {data?.items && <DashboardTable items={data.items} />}
    </div>
  );
};

export default Dashboard;
