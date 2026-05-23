import React, { useState, useEffect, useMemo } from 'react';
import { subDays, subMonths, subYears, format } from 'date-fns';
import { Check, X, Search } from 'lucide-react';
import { holdings as holdingsAPI, history as historyAPI } from '../utils/api';
import TickerHistoryChart from '../components/TickerHistoryChart';

const DEFAULT_HISTORY_LIMIT = 2000;

const DATE_RANGE_OPTIONS = [
  { label: '30D', value: '30d', getDates: () => ({ start: subDays(new Date(), 30), end: new Date() }) },
  { label: '3M', value: '3m', getDates: () => ({ start: subMonths(new Date(), 3), end: new Date() }) },
  { label: '6M', value: '6m', getDates: () => ({ start: subMonths(new Date(), 6), end: new Date() }) },
  { label: '1Y', value: '1y', getDates: () => ({ start: subYears(new Date(), 1), end: new Date() }) },
  { label: 'ALL', value: 'all', getDates: () => ({ start: subYears(new Date(), 10), end: new Date() }) },
  { label: 'CUSTOM', value: 'custom', getDates: () => null },
];

const TickerHistory = () => {
  const [historyData, setHistoryData] = useState([]);
  const [holdings, setHoldings] = useState([]);
  const [selectedTickers, setSelectedTickers] = useState([]);
  const [dateRangeOption, setDateRangeOption] = useState('1y');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  const availableTickers = useMemo(() => {
    const tickers = holdings.map(h => h.ticker).filter(t => t && t.trim() !== '');
    return [...new Set(tickers)].sort();
  }, [holdings]);

  const filteredTickers = useMemo(() => {
    if (!searchQuery) return availableTickers;
    return availableTickers.filter(t => t.toLowerCase().includes(searchQuery.toLowerCase()));
  }, [availableTickers, searchQuery]);

  useEffect(() => {
    const loadHoldings = async () => {
      try {
        const data = await holdingsAPI.getAll();
        const list = data.holdings || [];
        setHoldings(list);
        const topTickers = list.filter(h => h.ticker).sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0)).slice(0, 5).map(h => h.ticker);
        setSelectedTickers(topTickers);
      } catch (err) {
        setError('Failed to load holdings');
      } finally {
        setInitialLoading(false);
      }
    };
    loadHoldings();
  }, []);

  useEffect(() => {
    if (dateRangeOption !== 'custom') {
      const option = DATE_RANGE_OPTIONS.find(o => o.value === dateRangeOption);
      if (option) {
        const dates = option.getDates();
        if (dates) { setStartDate(format(dates.start, 'yyyy-MM-dd')); setEndDate(format(dates.end, 'yyyy-MM-dd')); }
      }
    }
  }, [dateRangeOption]);

  useEffect(() => {
    if (!startDate || !endDate || selectedTickers.length === 0) {
      if (selectedTickers.length === 0) setHistoryData([]);
      return;
    }
    const fetchHistory = async () => {
      setLoading(true); setError(null);
      try {
        const params = { startDate, endDate, limit: DEFAULT_HISTORY_LIMIT };
        const promises = selectedTickers.map(ticker => historyAPI.getTickers({ ...params, ticker }));
        const results = await Promise.all(promises);
        setHistoryData(results.flatMap(r => r.data || []));
      } catch (err) {
        setError('Failed to load history data');
        setHistoryData([]);
      } finally {
        setLoading(false);
      }
    };
    fetchHistory();
  }, [selectedTickers, startDate, endDate]);

  const handleTickerToggle = (ticker) => {
    setSelectedTickers(prev => prev.includes(ticker) ? prev.filter(t => t !== ticker) : [...prev, ticker]);
  };

  const handleSelectAll = () => {
    setSelectedTickers(selectedTickers.length === availableTickers.length ? [] : availableTickers);
  };

  if (initialLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-3">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        <span className="text-caption text-tertiary">Loading tickers...</span>
      </div>
    );
  }

  return (
    <div className="px-4 py-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-4 gap-3">
        <div>
          <h1 className="text-display-md text-primary">Ticker History</h1>
          <p className="text-body-sm text-tertiary">Price trends of individual holdings</p>
        </div>
        <div className="flex bg-surface border border-border">
          {DATE_RANGE_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => setDateRangeOption(option.value)}
              className={`px-2 py-1 text-caption transition-colors ${
                dateRangeOption === option.value ? 'bg-accent text-white' : 'text-tertiary hover:text-secondary'
              }`}
            >{option.label}</button>
          ))}
        </div>
      </div>

      <div className="card mb-4">
        <div className="p-3 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-title-sm text-secondary uppercase tracking-wide">Tickers</span>
            <div className="flex items-center gap-2">
              <div className="relative min-w-[180px]">
                <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-tertiary" />
                <input
                  type="text"
                  placeholder="Search..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-surface-3 border-border pl-7 pr-2 py-1 text-caption"
                />
              </div>
              <button
                onClick={handleSelectAll}
                className={`flex items-center gap-1.5 border px-2 py-1 text-caption transition-colors ${
                  selectedTickers.length === availableTickers.length && availableTickers.length > 0
                    ? 'bg-accent-muted border-accent/30 text-accent'
                    : 'bg-surface border-border text-tertiary hover:text-secondary'
                }`}
              >
                {selectedTickers.length === availableTickers.length && <Check size={12} />}
                {selectedTickers.length === availableTickers.length ? 'Deselect All' : 'Select All'}
              </button>
            </div>
          </div>

          <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto pr-1">
            {filteredTickers.map((ticker) => {
              const isSelected = selectedTickers.includes(ticker);
              return (
                <button
                  key={ticker}
                  onClick={() => handleTickerToggle(ticker)}
                  className={`flex items-center gap-1.5 border px-2 py-1 text-caption transition-colors ${
                    isSelected ? 'bg-surface-3 border-accent/30 text-primary' : 'bg-surface border-border text-tertiary hover:text-secondary'
                  }`}
                >
                  <span className="font-semibold">{ticker}</span>
                  {isSelected && <Check size={10} className="text-accent" />}
                </button>
              );
            })}
            {filteredTickers.length === 0 && <p className="text-caption text-tertiary py-1">No tickers found</p>}
          </div>

          {dateRangeOption === 'custom' && (
            <div className="grid grid-cols-1 gap-2 border-t border-border pt-3 sm:grid-cols-2">
              <div>
                <label className="text-caption text-tertiary uppercase block mb-1">Start Date</label>
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-full bg-surface-3 border-border px-2 py-1 text-caption" />
              </div>
              <div>
                <label className="text-caption text-tertiary uppercase block mb-1">End Date</label>
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-full bg-surface-3 border-border px-2 py-1 text-caption" />
              </div>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-4 p-2 bg-loss-bg border border-loss/20 text-loss text-body-sm flex items-center gap-2">
          <X size={14} /> {error}
        </div>
      )}

      <TickerHistoryChart data={historyData} tickers={selectedTickers} loading={loading} />
    </div>
  );
};

export default TickerHistory;
