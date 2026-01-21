import React, { useState, useEffect, useMemo } from 'react';
import { holdings as holdingsAPI, history as historyAPI } from '../utils/api';
import TickerHistoryChart from '../components/TickerHistoryChart';

const DEFAULT_HISTORY_LIMIT = 100;

const TickerHistory = () => {
  const [historyData, setHistoryData] = useState([]);
  const [holdings, setHoldings] = useState([]);
  const [selectedTicker, setSelectedTicker] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [initialLoading, setInitialLoading] = useState(true);

  // Get unique tickers from holdings
  const availableTickers = useMemo(() => {
    const tickers = holdings
      .map((h) => h.ticker)
      .filter((ticker) => ticker && ticker.trim() !== '');
    return [...new Set(tickers)].sort();
  }, [holdings]);

  // Load holdings on mount
  useEffect(() => {
    const loadHoldings = async () => {
      try {
        const data = await holdingsAPI.getAll();
        setHoldings(data.holdings || []);
      } catch (err) {
        console.error('Error loading holdings:', err);
        setError('Failed to load holdings');
      } finally {
        setInitialLoading(false);
      }
    };
    loadHoldings();
  }, []);

  // Set default date range (last 30 days)
  useEffect(() => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 30);

    setEndDate(end.toISOString().split('T')[0]);
    setStartDate(start.toISOString().split('T')[0]);
  }, []);

  // Fetch history data when filters change
  useEffect(() => {
    if (!startDate || !endDate) return;

    const fetchHistory = async () => {
      setLoading(true);
      setError(null);

      try {
        const params = {
          startDate,
          endDate,
          limit: DEFAULT_HISTORY_LIMIT,
        };

        if (selectedTicker) {
          params.ticker = selectedTicker;
        }

        const data = await historyAPI.getTickers(params);
        setHistoryData(data.data || []);
      } catch (err) {
        console.error('Error fetching history:', err);
        setError(err.response?.data?.error || 'Failed to load history data');
        setHistoryData([]);
      } finally {
        setLoading(false);
      }
    };

    fetchHistory();
  }, [selectedTicker, startDate, endDate]);

  // Get tickers to display on chart
  const displayTickers = useMemo(() => {
    if (selectedTicker) return [selectedTicker];
    return [...new Set(historyData.map((item) => item.ticker))];
  }, [selectedTicker, historyData]);

  if (initialLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-xl text-gray-600">Loading...</div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900 mb-4">Ticker History</h1>

        {/* Filters */}
        <div className="flex flex-wrap gap-4 items-end mb-6 p-4 bg-gray-50 rounded-lg">
          {/* Ticker Selector */}
          <div className="flex flex-col">
            <label className="text-sm font-medium text-gray-700 mb-1">
              Ticker
            </label>
            <select
              value={selectedTicker}
              onChange={(e) => setSelectedTicker(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[150px]"
            >
              <option value="">All Tickers</option>
              {availableTickers.map((ticker) => (
                <option key={ticker} value={ticker}>
                  {ticker}
                </option>
              ))}
            </select>
          </div>

          {/* Start Date */}
          <div className="flex flex-col">
            <label className="text-sm font-medium text-gray-700 mb-1">
              Start Date
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* End Date */}
          <div className="flex flex-col">
            <label className="text-sm font-medium text-gray-700 mb-1">
              End Date
            </label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div className="mb-4 p-4 bg-red-100 border border-red-400 text-red-700 rounded">
            {error}
          </div>
        )}

        {/* Loading State */}
        {loading && (
          <div className="flex items-center justify-center h-96 bg-gray-50 rounded-lg">
            <div className="text-xl text-gray-600">Loading chart data...</div>
          </div>
        )}

        {/* Chart */}
        {!loading && (
          <div className="bg-white shadow-md rounded-lg p-4 min-h-96">
            <TickerHistoryChart data={historyData} tickers={displayTickers} />
          </div>
        )}

        {/* Data Summary */}
        {!loading && historyData.length > 0 && (
          <div className="mt-4 text-sm text-gray-600">
            Showing {historyData.length} data points
            {displayTickers.length > 0 &&
              ` for ${displayTickers.length} ticker${displayTickers.length > 1 ? 's' : ''}`}
          </div>
        )}
      </div>
    </div>
  );
};

export default TickerHistory;
