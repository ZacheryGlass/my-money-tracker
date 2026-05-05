import React, { useState, useEffect, useMemo } from 'react';
import { holdings as holdingsAPI, history as historyAPI } from '../utils/api';
import TickerHistoryChart from '../components/TickerHistoryChart';

const DEFAULT_HISTORY_LIMIT = 1000;

const TickerHistory = () => {
  const [historyData, setHistoryData] = useState([]);
  const [holdings, setHoldings] = useState([]);
  const [selectedTicker, setSelectedTicker] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [initialLoading, setInitialLoading] = useState(true);

  const availableTickers = useMemo(() => {
    const tickers = holdings.map(h => h.ticker).filter(t => t && t.trim() !== '');
    return [...new Set(tickers)].sort();
  }, [holdings]);

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

  useEffect(() => {
    const end = new Date();
    const start = new Date();
    start.setFullYear(start.getFullYear() - 1);
    setEndDate(end.toISOString().split('T')[0]);
    setStartDate(start.toISOString().split('T')[0]);
  }, []);

  useEffect(() => {
    if (!startDate || !endDate) return;

    const fetchHistory = async () => {
      setLoading(true);
      setError(null);

      try {
        const params = { startDate, endDate, limit: DEFAULT_HISTORY_LIMIT };
        if (selectedTicker) params.ticker = selectedTicker;
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

  const displayTickers = useMemo(() => {
    if (selectedTicker) return [selectedTicker];
    const maxByTicker = new Map();
    for (const item of historyData) {
      const abs = Math.abs(Number(item.value) || 0);
      const prev = maxByTicker.get(item.ticker) || 0;
      if (abs > prev) maxByTicker.set(item.ticker, abs);
    }
    return [...maxByTicker.entries()]
      .filter(([, max]) => max > 10)
      .map(([ticker]) => ticker);
  }, [selectedTicker, historyData]);

  if (initialLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-xl text-secondary">Loading...</div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-4 md:py-8 animate-fade-in">
      <div className="mb-4 md:mb-6">
        <h1 className="text-xl font-bold text-primary mb-4">Ticker History</h1>

        <div className="card p-3 md:p-4 flex flex-col gap-3 md:gap-4 mb-4">
          <div className="flex flex-col">
            <label className="text-xs font-medium text-secondary uppercase tracking-wider mb-1">
              Ticker
            </label>
            <select
              value={selectedTicker}
              onChange={(e) => setSelectedTicker(e.target.value)}
              className="px-3 py-2 border border-input-border rounded-md focus:outline-none min-h-[44px] touch-manipulation"
            >
              <option value="">All Tickers</option>
              {availableTickers.map((ticker) => (
                <option key={ticker} value={ticker}>{ticker}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="flex flex-col">
              <label className="text-xs font-medium text-secondary uppercase tracking-wider mb-1">
                Start Date
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="px-3 py-2 border border-input-border rounded-md focus:outline-none min-h-[44px] touch-manipulation"
              />
            </div>
            <div className="flex flex-col">
              <label className="text-xs font-medium text-secondary uppercase tracking-wider mb-1">
                End Date
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="px-3 py-2 border border-input-border rounded-md focus:outline-none min-h-[44px] touch-manipulation"
              />
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-4 bg-loss-bg border border-loss text-loss rounded text-sm">
            {error}
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center h-64 md:h-96 card">
            <div className="text-lg text-secondary">Loading chart data...</div>
          </div>
        )}

        {!loading && (
          <div className="card p-3 md:p-4 min-h-64 md:min-h-96">
            <TickerHistoryChart data={historyData} tickers={displayTickers} />
          </div>
        )}

        {!loading && historyData.length > 0 && (
          <div className="mt-3 text-sm text-secondary">
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
