import React, { useState, useEffect, useCallback } from 'react';
import { format, subDays, subMonths, subYears, differenceInDays, parseISO } from 'date-fns';
import AccountHistoryChart from '../components/AccountHistoryChart';
import { accounts as accountsApi, history as historyApi } from '../utils/api';

const DATE_RANGE_OPTIONS = [
  { label: '7 Days', value: '7d', days: 7, getDates: () => ({ start: subDays(new Date(), 7), end: new Date() }) },
  { label: '30 Days', value: '30d', days: 30, getDates: () => ({ start: subDays(new Date(), 30), end: new Date() }) },
  { label: '3 Months', value: '3m', days: 90, getDates: () => ({ start: subMonths(new Date(), 3), end: new Date() }) },
  { label: '6 Months', value: '6m', days: 180, getDates: () => ({ start: subMonths(new Date(), 6), end: new Date() }) },
  { label: '1 Year', value: '1y', days: 365, getDates: () => ({ start: subYears(new Date(), 1), end: new Date() }) },
  { label: 'All Time', value: 'all', days: null, getDates: () => ({ start: null, end: null }) },
  { label: 'Custom', value: 'custom', days: null, getDates: () => null },
];

// Calculate appropriate limit based on expected number of data points
// Each day produces one snapshot, so limit should accommodate the date range
const calculateLimit = (dateRangeOption, customStartDate, customEndDate) => {
  if (dateRangeOption === 'custom' && customStartDate && customEndDate) {
    const days = differenceInDays(parseISO(customEndDate), parseISO(customStartDate));
    return Math.min(Math.max(days + 1, 30), 100);
  }
  
  const option = DATE_RANGE_OPTIONS.find(opt => opt.value === dateRangeOption);
  if (option?.days) {
    return Math.min(option.days + 1, 100);
  }
  
  // For 'all' or undefined, use maximum limit
  return 100;
};

const AccountHistory = () => {
  const [accounts, setAccounts] = useState([]);
  const [selectedAccounts, setSelectedAccounts] = useState([]);
  const [showPortfolio, setShowPortfolio] = useState(true);
  const [dateRangeOption, setDateRangeOption] = useState('30d');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [accountData, setAccountData] = useState([]);
  const [portfolioData, setPortfolioData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Load accounts on mount
  useEffect(() => {
    const fetchAccounts = async () => {
      try {
        const data = await accountsApi.getAll();
        setAccounts(data);
        // Select all accounts by default
        setSelectedAccounts(data.map(acc => acc.id));
      } catch (err) {
        console.error('Error fetching accounts:', err);
        setError('Failed to load accounts');
      }
    };
    fetchAccounts();
  }, []);

  // Get effective date range
  const getDateRange = useCallback(() => {
    if (dateRangeOption === 'custom') {
      return {
        startDate: customStartDate || undefined,
        endDate: customEndDate || undefined,
      };
    }
    
    const option = DATE_RANGE_OPTIONS.find(opt => opt.value === dateRangeOption);
    if (option && option.getDates) {
      const dates = option.getDates();
      if (dates) {
        return {
          startDate: dates.start ? format(dates.start, 'yyyy-MM-dd') : undefined,
          endDate: dates.end ? format(dates.end, 'yyyy-MM-dd') : undefined,
        };
      }
    }
    return {};
  }, [dateRangeOption, customStartDate, customEndDate]);

  // Fetch history data when filters change
  useEffect(() => {
    const fetchHistoryData = async () => {
      setLoading(true);
      setError(null);
      
      try {
        const dateRange = getDateRange();
        const limit = calculateLimit(dateRangeOption, customStartDate, customEndDate);
        const params = {
          ...dateRange,
          limit,
        };

        const fetchPromises = [];

        // Fetch account history for selected accounts
        if (selectedAccounts.length > 0) {
          // Fetch data for each account separately to handle multiple accounts
          const accountPromises = selectedAccounts.map(accountId =>
            historyApi.getAccounts({ ...params, account_id: accountId })
          );
          fetchPromises.push(
            Promise.all(accountPromises).then(results => {
              const combinedData = results.flatMap(result => result.data || []);
              setAccountData(combinedData);
            })
          );
        } else {
          setAccountData([]);
        }

        // Fetch portfolio history if enabled
        if (showPortfolio) {
          fetchPromises.push(
            historyApi.getPortfolio(params).then(result => {
              setPortfolioData(result.data || []);
            })
          );
        } else {
          setPortfolioData([]);
        }

        await Promise.all(fetchPromises);
      } catch (err) {
        console.error('Error fetching history data:', err);
        setError('Failed to load history data');
      } finally {
        setLoading(false);
      }
    };

    if (accounts.length > 0) {
      fetchHistoryData();
    }
  }, [accounts, selectedAccounts, showPortfolio, getDateRange, dateRangeOption, customStartDate, customEndDate]);

  const handleAccountToggle = (accountId) => {
    setSelectedAccounts(prev => {
      if (prev.includes(accountId)) {
        return prev.filter(id => id !== accountId);
      }
      return [...prev, accountId];
    });
  };

  const handleSelectAll = () => {
    if (selectedAccounts.length === accounts.length) {
      setSelectedAccounts([]);
    } else {
      setSelectedAccounts(accounts.map(acc => acc.id));
    }
  };

  return (
    <div className="container mx-auto px-4 py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Account History</h1>
        <p className="text-gray-600">View your account value history over time</p>
      </div>

      {/* Filters Section */}
      <div className="bg-white rounded-lg shadow p-4 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {/* Account Selector */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Accounts
            </label>
            <div className="border border-gray-300 rounded-md p-3 max-h-48 overflow-y-auto">
              <div className="mb-2 pb-2 border-b border-gray-200">
                <label className="flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedAccounts.length === accounts.length && accounts.length > 0}
                    onChange={handleSelectAll}
                    className="h-4 w-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                  />
                  <span className="ml-2 text-sm font-medium text-gray-700">
                    Select All
                  </span>
                </label>
              </div>
              {accounts.map((account) => (
                <label key={account.id} className="flex items-center cursor-pointer py-1">
                  <input
                    type="checkbox"
                    checked={selectedAccounts.includes(account.id)}
                    onChange={() => handleAccountToggle(account.id)}
                    className="h-4 w-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                  />
                  <span className="ml-2 text-sm text-gray-700">{account.name}</span>
                </label>
              ))}
              {accounts.length === 0 && (
                <p className="text-sm text-gray-500">No accounts found</p>
              )}
            </div>
          </div>

          {/* Date Range Picker */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Date Range
            </label>
            <select
              value={dateRangeOption}
              onChange={(e) => setDateRangeOption(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {DATE_RANGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            
            {dateRangeOption === 'custom' && (
              <div className="mt-3 space-y-2">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Start Date</label>
                  <input
                    type="date"
                    value={customStartDate}
                    onChange={(e) => setCustomStartDate(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">End Date</label>
                  <input
                    type="date"
                    value={customEndDate}
                    onChange={(e) => setCustomEndDate(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Display Options */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Display Options
            </label>
            <div className="space-y-2">
              <label className="flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={showPortfolio}
                  onChange={(e) => setShowPortfolio(e.target.checked)}
                  className="h-4 w-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                />
                <span className="ml-2 text-sm text-gray-700">
                  Show Total Portfolio
                </span>
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* Chart Section */}
      <AccountHistoryChart
        accountData={accountData}
        portfolioData={portfolioData}
        accounts={accounts}
        selectedAccounts={selectedAccounts}
        showPortfolio={showPortfolio}
        loading={loading}
        error={error}
      />
    </div>
  );
};

export default AccountHistory;
