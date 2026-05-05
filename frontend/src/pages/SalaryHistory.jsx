import React, { useState, useEffect, useMemo } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceDot,
} from 'recharts';
import { salary as salaryAPI } from '../utils/api';
import { formatCurrency, formatPercent, formatDateDisplay } from '../utils/format';
import { CHART_COLORS, GRID_STYLE, AXIS_STYLE, areaGradient } from '../utils/chartTheme';
import MetricCard from '../components/MetricCard';
import ChartTooltip from '../components/ChartTooltip';

const SalaryHistory = () => {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState('');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState(null);
  const [deletingRecord, setDeletingRecord] = useState(null);
  const [formData, setFormData] = useState({
    effective_date: '', title: '', salary_amount: '', psu: '', rsu: '',
    total_comp: '', change_amount: '', change_percent: '',
  });

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const data = await salaryAPI.getAll();
      setRecords(data.records || []);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load salary history');
    } finally {
      setLoading(false);
    }
  };

  const showSuccess = (msg) => {
    setSuccessMessage(msg);
    setTimeout(() => setSuccessMessage(''), 3000);
  };

  const handleAddNew = () => {
    setEditingRecord(null);
    setFormData({
      effective_date: '', title: '', salary_amount: '', psu: '', rsu: '',
      total_comp: '', change_amount: '', change_percent: '',
    });
    setIsFormOpen(true);
  };

  const handleEdit = (record) => {
    setEditingRecord(record);
    setFormData({
      effective_date: record.effective_date?.split('T')[0] || '',
      title: record.title || '',
      salary_amount: record.salary_amount ?? '',
      psu: record.psu ?? '',
      rsu: record.rsu ?? '',
      total_comp: record.total_comp ?? '',
      change_amount: record.change_amount ?? '',
      change_percent: record.change_percent ? (parseFloat(record.change_percent) * 100).toFixed(2) : '',
    });
    setIsFormOpen(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    const payload = {
      ...formData,
      salary_amount: parseFloat(formData.salary_amount) || 0,
      psu: parseFloat(formData.psu) || 0,
      rsu: parseFloat(formData.rsu) || 0,
      total_comp: parseFloat(formData.total_comp) || parseFloat(formData.salary_amount) || 0,
      change_amount: formData.change_amount ? parseFloat(formData.change_amount) : null,
      change_percent: formData.change_percent ? parseFloat(formData.change_percent) / 100 : null,
    };

    try {
      if (editingRecord) {
        await salaryAPI.update(editingRecord.id, payload);
        showSuccess('Salary record updated');
      } else {
        await salaryAPI.create(payload);
        showSuccess('Salary record created');
      }
      await fetchData();
      setIsFormOpen(false);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save');
    }
  };

  const handleDeleteConfirm = async () => {
    try {
      await salaryAPI.delete(deletingRecord.id);
      showSuccess('Record deleted');
      await fetchData();
      setDeletingRecord(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete');
      setDeletingRecord(null);
    }
  };

  const { current, careerGrowth, lastRaise, chartData, peakComp } = useMemo(() => {
    if (records.length === 0) return { current: null, careerGrowth: 0, lastRaise: null, chartData: [], peakComp: null };
    const sorted = [...records].sort((a, b) => new Date(a.effective_date) - new Date(b.effective_date));
    const latest = sorted[sorted.length - 1];
    const earliest = sorted[0];
    const growth = earliest.total_comp > 0
      ? ((latest.total_comp - earliest.total_comp) / earliest.total_comp) * 100
      : 0;
    const lr = latest.change_amount ? {
      amount: parseFloat(latest.change_amount),
      percent: latest.change_percent ? parseFloat(latest.change_percent) * 100 : 0,
    } : null;
    const cd = sorted.map((r) => ({
      date: r.effective_date,
      label: formatDateDisplay(r.effective_date),
      salary: parseFloat(r.salary_amount),
      totalComp: parseFloat(r.total_comp),
      title: r.title,
    }));
    const peak = cd.reduce((max, d) => d.totalComp > max.totalComp ? d : max, cd[0]);
    return { current: latest, careerGrowth: growth, lastRaise: lr, chartData: cd, peakComp: peak };
  }, [records]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="w-8 h-8 border-4 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1400px] mx-auto space-y-6">
      {/* Hero */}
      <div className="animate-fade-in">
        <p className="text-[10px] font-semibold tracking-widest uppercase text-secondary mb-1">
          Current Total Compensation
        </p>
        <h1 className="font-mono font-bold text-accent leading-none" style={{ fontSize: 'clamp(2rem, 5vw, 3rem)' }}>
          {current ? formatCurrency(current.total_comp) : '-'}
        </h1>
        {current && (
          <p className="text-sm text-secondary mt-1">{current.title}</p>
        )}
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
        <MetricCard
          label="Base Salary"
          value={current ? formatCurrency(current.salary_amount) : '-'}
          valueColor="primary"
        />
        <MetricCard
          label="Last Raise"
          value={lastRaise ? formatCurrency(lastRaise.amount) : '-'}
          change={lastRaise ? formatPercent(lastRaise.percent, 1) : undefined}
          trend={lastRaise && lastRaise.amount >= 0 ? 'up' : 'neutral'}
          valueColor="gain"
        />
        <MetricCard
          label="Career Growth"
          value={careerGrowth > 0 ? formatPercent(careerGrowth, 0) : '-'}
          change={current && records.length > 1 ? `${records.length} raises` : undefined}
          trend="up"
          valueColor="gain"
        />
      </div>

      {successMessage && (
        <div className="bg-gain-bg text-gain border border-gain/20 rounded-lg p-3 animate-fade-in">{successMessage}</div>
      )}
      {error && (
        <div className="bg-loss-bg text-loss border border-loss/20 rounded-lg p-3 animate-fade-in">{error}</div>
      )}

      {/* Chart */}
      {chartData.length > 1 && (
        <div className="card p-4 md:p-6 animate-slide-up">
          <span className="text-[10px] font-semibold tracking-widest uppercase text-secondary">
            Compensation Over Time
          </span>
          <div className="mt-4">
            <ResponsiveContainer width="100%" height={350}>
              <AreaChart data={chartData} margin={{ top: 10, right: 30, left: 10, bottom: 0 }}>
                <defs>
                  {areaGradient('salaryGrad', CHART_COLORS[1])}
                  {areaGradient('compGrad', CHART_COLORS[0])}
                </defs>
                <CartesianGrid {...GRID_STYLE} />
                <XAxis dataKey="label" {...AXIS_STYLE} />
                <YAxis {...AXIS_STYLE} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}K`} />
                <Tooltip content={<ChartTooltip formatValue={(v) => formatCurrency(v, { maximumFractionDigits: 0 })} />} />
                <Legend />
                <Area type="monotone" dataKey="totalComp" name="Total Comp" stroke={CHART_COLORS[0]} fill="url(#compGrad)" strokeWidth={2} />
                <Area type="monotone" dataKey="salary" name="Base Salary" stroke={CHART_COLORS[1]} fill="url(#salaryGrad)" strokeWidth={2} />
                {peakComp && (
                  <ReferenceDot
                    x={peakComp.label}
                    y={peakComp.totalComp}
                    r={4}
                    fill="var(--accent)"
                    stroke="var(--bg-surface)"
                    strokeWidth={2}
                  />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="animate-slide-up">
        <div className="flex items-center justify-between mb-4">
          <span className="text-[10px] font-semibold tracking-widest uppercase text-secondary">
            History
          </span>
          <button
            onClick={handleAddNew}
            className="px-4 py-2 bg-accent text-inverse hover:bg-accent-hover rounded-md text-sm transition-colors duration-200 min-h-[44px] touch-manipulation"
          >
            Add Record
          </button>
        </div>
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border">
              <thead className="bg-surface-2">
                <tr>
                  {['Date', 'Title', 'Salary', 'PSU', 'RSU', 'Total Comp', 'Change', '%', ''].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-[10px] font-semibold tracking-widest uppercase text-secondary">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {records.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-secondary">
                      No salary records found.
                    </td>
                  </tr>
                ) : (
                  records.map((r) => (
                    <tr key={r.id} className="hover:bg-surface-3 transition-colors duration-150">
                      <td className="px-4 py-3 text-sm text-primary whitespace-nowrap">{formatDateDisplay(r.effective_date)}</td>
                      <td className="px-4 py-3 text-sm text-primary">{r.title}</td>
                      <td className="px-4 py-3 text-sm font-mono text-primary">{formatCurrency(r.salary_amount)}</td>
                      <td className="px-4 py-3 text-sm font-mono text-secondary">{r.psu > 0 ? formatCurrency(r.psu) : <span className="text-tertiary">-</span>}</td>
                      <td className="px-4 py-3 text-sm font-mono text-secondary">{r.rsu > 0 ? formatCurrency(r.rsu) : <span className="text-tertiary">-</span>}</td>
                      <td className="px-4 py-3 text-sm font-mono font-bold text-accent">{formatCurrency(r.total_comp)}</td>
                      <td className="px-4 py-3 text-sm font-mono text-gain">{r.change_amount ? `+${formatCurrency(r.change_amount)}` : <span className="text-tertiary">-</span>}</td>
                      <td className="px-4 py-3 text-sm font-mono text-gain">
                        {r.change_percent ? formatPercent(parseFloat(r.change_percent) * 100, 1) : <span className="text-tertiary">-</span>}
                      </td>
                      <td className="px-4 py-3 text-sm whitespace-nowrap">
                        <div className="flex gap-1">
                          <button onClick={() => handleEdit(r)} className="text-xs text-accent hover:bg-accent-muted rounded px-2 py-1.5 transition-colors duration-150 min-h-[44px]">Edit</button>
                          <button onClick={() => setDeletingRecord(r)} className="text-xs text-loss hover:bg-loss-bg rounded px-2 py-1.5 transition-colors duration-150 min-h-[44px]">Delete</button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Form Modal */}
      {isFormOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in">
          <div className="bg-surface rounded-card border border-border shadow-xl max-w-lg w-full mx-4 p-6 max-h-[90vh] overflow-y-auto animate-slide-up">
            <h2 className="text-lg font-bold mb-4 text-primary">{editingRecord ? 'Edit Record' : 'Add Record'}</h2>
            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="block text-[10px] font-semibold tracking-widest uppercase text-secondary mb-1.5">Effective Date</label>
                <input type="date" value={formData.effective_date} onChange={(e) => setFormData({ ...formData, effective_date: e.target.value })} className="w-full px-3 py-2 rounded-md border border-input-border min-h-[44px]" required />
              </div>
              <div>
                <label className="block text-[10px] font-semibold tracking-widest uppercase text-secondary mb-1.5">Title</label>
                <input type="text" value={formData.title} onChange={(e) => setFormData({ ...formData, title: e.target.value })} className="w-full px-3 py-2 rounded-md border border-input-border min-h-[44px]" required />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-semibold tracking-widest uppercase text-secondary mb-1.5">Base Salary</label>
                  <input type="number" step="0.01" value={formData.salary_amount} onChange={(e) => setFormData({ ...formData, salary_amount: e.target.value })} className="w-full px-3 py-2 rounded-md border border-input-border min-h-[44px]" required />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold tracking-widest uppercase text-secondary mb-1.5">Total Comp</label>
                  <input type="number" step="0.01" value={formData.total_comp} onChange={(e) => setFormData({ ...formData, total_comp: e.target.value })} className="w-full px-3 py-2 rounded-md border border-input-border min-h-[44px]" required />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-semibold tracking-widest uppercase text-secondary mb-1.5">PSU</label>
                  <input type="number" step="0.01" value={formData.psu} onChange={(e) => setFormData({ ...formData, psu: e.target.value })} className="w-full px-3 py-2 rounded-md border border-input-border min-h-[44px]" />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold tracking-widest uppercase text-secondary mb-1.5">RSU</label>
                  <input type="number" step="0.01" value={formData.rsu} onChange={(e) => setFormData({ ...formData, rsu: e.target.value })} className="w-full px-3 py-2 rounded-md border border-input-border min-h-[44px]" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-semibold tracking-widest uppercase text-secondary mb-1.5">Change Amount</label>
                  <input type="number" step="0.01" value={formData.change_amount} onChange={(e) => setFormData({ ...formData, change_amount: e.target.value })} className="w-full px-3 py-2 rounded-md border border-input-border min-h-[44px]" />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold tracking-widest uppercase text-secondary mb-1.5">Change %</label>
                  <input type="number" step="0.01" value={formData.change_percent} onChange={(e) => setFormData({ ...formData, change_percent: e.target.value })} className="w-full px-3 py-2 rounded-md border border-input-border min-h-[44px]" placeholder="e.g. 8.3" />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setIsFormOpen(false)} className="px-4 py-2 bg-surface-3 text-secondary hover:bg-surface-3/80 rounded-md transition-colors duration-200 min-h-[44px]">Cancel</button>
                <button type="submit" className="px-4 py-2 bg-accent text-inverse hover:bg-accent-hover rounded-md transition-colors duration-200 min-h-[44px]">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirm Modal */}
      {deletingRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in">
          <div className="bg-surface rounded-card border border-border shadow-xl max-w-md w-full mx-4 p-6 animate-slide-up">
            <h2 className="text-lg font-bold mb-4 text-primary">Confirm Delete</h2>
            <p className="text-secondary mb-6">
              Delete the record for {formatDateDisplay(deletingRecord.effective_date)}?
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeletingRecord(null)} className="px-4 py-2 bg-surface-3 text-secondary hover:bg-surface-3/80 rounded-md transition-colors duration-200 min-h-[44px]">Cancel</button>
              <button onClick={handleDeleteConfirm} className="px-4 py-2 bg-loss text-inverse rounded-md hover:opacity-90 transition-opacity duration-200 min-h-[44px]">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SalaryHistory;
