import React, { useState, useEffect, useMemo } from 'react';
import { motion as Motion } from 'framer-motion';
import { subDays, subMonths, subYears, format } from 'date-fns';
import { TrendingUp, Filter, Check, X, Calendar, Search } from 'lucide-react';
import { holdings as holdingsAPI, history as historyAPI } from '../utils/api';
import TickerHistoryChart from '../components/TickerHistoryChart';

const DEFAULT_HISTORY_LIMIT = 2000;

const DATE_RANGE_OPTIONS = [
  { label: '30D', fullLabel: '30 Days', value: '30d', getDates: () => ({ start: subDays(new Date(), 30), end: new Date() }) },
  { label: '3M', fullLabel: '3 Months', value: '3m', getDates: () => ({ start: subMonths(new Date(), 3), end: new Date() }) },
  { label: '6M', fullLabel: '6 Months', value: '6m', getDates: () => ({ start: subMonths(new Date(), 6), end: new Date() }) },
  { label: '1Y', fullLabel: '1 Year', value: '1y', getDates: () => ({ start: subYears(new Date(), 1), end: new Date() }) },
  { label: 'ALL', fullLabel: 'All Time', value: 'all', getDates: () => ({ start: subYears(new Date(), 10), end: new Date() }) },
  { label: 'CUSTOM', fullLabel: 'Custom', value: 'custom', getDates: () => null },
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
        
        // Default to top 5 tickers by value if none selected
        const topTickers = list
          .filter(h => h.ticker)
          .sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0))
          .slice(0, 5)
          .map(h => h.ticker);
        setSelectedTickers(topTickers);
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
    if (dateRangeOption !== 'custom') {
      const option = DATE_RANGE_OPTIONS.find(o => o.value === dateRangeOption);
      if (option) {
        const dates = option.getDates();
        if (dates) {
          setStartDate(format(dates.start, 'yyyy-MM-dd'));
          setEndDate(format(dates.end, 'yyyy-MM-dd'));
        }
      }
    }
  }, [dateRangeOption]);

  useEffect(() => {
    if (!startDate || !endDate || selectedTickers.length === 0) {
      if (selectedTickers.length === 0) setHistoryData([]);
      return;
    }

    const fetchHistory = async () => {
      setLoading(true);
      setError(null);

      try {
        const params = { startDate, endDate, limit: DEFAULT_HISTORY_LIMIT };
        
        // If many tickers selected, we might need multiple calls or a more robust backend
        // For now, we'll try to fetch all selected tickers
        const promises = selectedTickers.map(ticker => 
          historyAPI.getTickers({ ...params, ticker })
        );
        
        const results = await Promise.all(promises);
        const combinedData = results.flatMap(r => r.data || []);
        setHistoryData(combinedData);
      } catch (err) {
        console.error('Error fetching history:', err);
        setError('Failed to load history data');
        setHistoryData([]);
      } finally {
        setLoading(false);
      }
    };

    fetchHistory();
  }, [selectedTickers, startDate, endDate]);

  const handleTickerToggle = (ticker) => {
    setSelectedTickers(prev =>
      prev.includes(ticker) ? prev.filter(t => t !== ticker) : [...prev, ticker]
    );
  };

  const handleSelectAll = () => {
    if (selectedTickers.length === availableTickers.length) {
      setSelectedTickers([]);
    } else {
      setSelectedTickers(availableTickers);
    }
  };

  if (initialLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <div className="w-10 h-10 border-4 border-accent border-t-transparent rounded-full animate-spin shadow-glow" />
        <span className="text-xs font-bold tracking-widest uppercase text-tertiary animate-pulse">Initializing Tickers</span>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 md:py-8">
      {/* Header Section */}
      <div className="flex flex-col md:flex-row md:items-end justify-between mb-8 gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp className="text-accent w-5 h-5" />
            <h1 className="text-2xl md:text-3xl font-bold text-primary tracking-tight">Ticker History</h1>
          </div>
          <p className="text-sm text-secondary">Track performance and price trends of your individual holdings</p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex bg-surface-2 p-1 rounded-xl border border-border shadow-inner">
            {DATE_RANGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                onClick={() => setDateRangeOption(option.value)}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-bold tracking-wider transition-all duration-200 ${
                  dateRangeOption === option.value
                    ? 'bg-accent text-inverse shadow-glow scale-105'
                    : 'text-tertiary hover:text-secondary'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mb-5 rounded-2xl border border-border bg-surface overflow-hidden">
        <div className="space-y-4 p-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-2 shrink-0">
              <Filter size={16} className="text-accent" />
              <span className="text-sm font-bold uppercase tracking-widest text-primary">Tickers</span>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative min-w-[220px]">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-tertiary" />
                <input
                  type="text"
                  placeholder="Search tickers..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-surface-3 border-border rounded-lg pl-9 pr-3 py-2 text-xs focus:ring-1 focus:ring-accent outline-none"
                />
              </div>
              <button
                onClick={handleSelectAll}
                className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-2 transition-all text-[10px] font-bold uppercase tracking-wider ${
                  selectedTickers.length === availableTickers.length && availableTickers.length > 0
                    ? 'bg-accent/10 border-accent/50 text-accent'
                    : 'bg-surface-2 border-transparent text-secondary hover:border-border-hover hover:text-primary'
                }`}
              >
                {selectedTickers.length === availableTickers.length && <Check size={12} />}
                {selectedTickers.length === availableTickers.length ? 'Deselect All' : 'Select All'}
              </button>
            </div>
          </div>

          <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto pr-2 custom-scrollbar">
            {filteredTickers.map((ticker) => {
              const isSelected = selectedTickers.includes(ticker);
              return (
                <button
                  key={ticker}
                  onClick={() => handleTickerToggle(ticker)}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-2 transition-all text-left ${
                    isSelected
                      ? 'bg-surface-3 border-accent/30 text-primary ring-1 ring-accent/10'
                      : 'bg-surface-2 border-transparent text-tertiary hover:border-border hover:text-secondary'
                  }`}
                >
                  <span className="text-xs font-bold">{ticker}</span>
                  {isSelected && <Check size={12} className="text-accent" />}
                </button>
              );
            })}
            {filteredTickers.length === 0 && (
              <p className="text-[10px] text-tertiary py-2">No tickers found</p>
            )}
          </div>

          {dateRangeOption === 'custom' && (
            <Motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="grid grid-cols-1 gap-3 border-t border-border pt-4 sm:grid-cols-2"
            >
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold text-tertiary uppercase tracking-widest">Start Date</label>
                <div className="relative">
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full bg-surface-3 border-border rounded-lg px-3 py-2 text-xs focus:ring-1 focus:ring-accent outline-none"
                  />
                  <Calendar size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-tertiary pointer-events-none" />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold text-tertiary uppercase tracking-widest">End Date</label>
                <div className="relative">
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="w-full bg-surface-3 border-border rounded-lg px-3 py-2 text-xs focus:ring-1 focus:ring-accent outline-none"
                  />
                  <Calendar size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-tertiary pointer-events-none" />
                </div>
              </div>
            </Motion.div>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-loss-bg border border-loss/20 text-loss rounded-xl text-xs flex items-center gap-3">
          <X size={16} />
          {error}
        </div>
      )}

      <TickerHistoryChart
        data={historyData}
        tickers={selectedTickers}
        loading={loading}
      />

      <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 mt-2 text-[10px] text-tertiary uppercase tracking-widest">
        <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-accent shadow-glow" /> Interactive Toggles</span>
        <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-surface-3 border border-border" /> Multi-series Support</span>
        <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-surface-3 border border-border" /> Time-series Analysis</span>
      </div>
    </div>
  );
};

export default TickerHistory;
