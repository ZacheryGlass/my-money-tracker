import React, { useState, useEffect, useMemo } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceDot,
} from 'recharts';
import { motion as Motion, AnimatePresence } from 'framer-motion';
import { Briefcase, TrendingUp, Plus, Edit2, Trash2, Check, X, Award, Target, Calendar } from 'lucide-react';
import { salary as salaryAPI } from '../utils/api';
import { formatCurrency, formatDateDisplay } from '../utils/format';
import { CHART_COLORS, GRID_STYLE, AXIS_STYLE, areaGradient } from '../utils/chartTheme';
import ChartTooltip from '../components/ChartTooltip';
import ResponsiveContainer from '../components/ResponsiveContainer';

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

  useEffect(() => { fetchData(); }, []);

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
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        <span className="text-xs font-bold tracking-wide uppercase text-tertiary ">Analyzing Earnings</span>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 md:py-8">
      {/* Hero Section */}
      <div className="flex flex-col md:flex-row md:items-end justify-between mb-10 gap-6">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Briefcase className="text-accent w-5 h-5" />
            <span className="text-[10px] font-bold uppercase tracking-wide text-secondary">Career Compensation</span>
          </div>
          <h1 className="text-3xl md:text-5xl font-bold text-primary tracking-tighter leading-none mb-2">
            {current ? formatCurrency(current.total_comp) : '—'}
          </h1>
          <p className="text-sm text-secondary">Current Total Compensation — <span className="font-bold text-primary">{current?.title || 'Unknown Role'}</span></p>
        </div>

        <div className="flex items-center gap-4">
          <div className="p-4 bg-surface-2 border border-border rounded shadow-sm min-w-[140px]">
            <p className="text-[10px] font-bold text-tertiary uppercase tracking-wide mb-1">Career Growth</p>
            <p className="text-lg font-mono font-bold text-gain">+{careerGrowth.toFixed(1)}%</p>
          </div>
          <button
            onClick={handleAddNew}
            className="flex items-center gap-2 px-6 py-4 bg-accent text-white hover:bg-accent-hover rounded text-sm font-bold transition-all"
          >
            <Plus size={18} />
            <span>Add Record</span>
          </button>
        </div>
      </div>

      <div className="space-y-8">
        {/* Summary Controls */}
        <div className="mb-5 rounded border border-border bg-surface p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <div className="space-y-1 rounded border border-border bg-surface-3 p-3">
              <p className="text-[10px] font-bold text-tertiary uppercase tracking-wide">Base Salary</p>
              <p className="text-xl font-mono font-bold text-primary">{current ? formatCurrency(current.salary_amount) : '—'}</p>
            </div>
            
            <div className="space-y-1 rounded border border-border bg-surface-3 p-3">
              <p className="text-[10px] font-bold text-tertiary uppercase tracking-wide">Last Increase</p>
              {lastRaise ? (
                <div className="flex items-end gap-2">
                  <p className="text-xl font-mono font-bold text-gain">+{formatCurrency(lastRaise.amount)}</p>
                  <p className="text-xs font-mono font-bold text-gain mb-1">({lastRaise.percent.toFixed(1)}%)</p>
                </div>
              ) : (
                <p className="text-xl font-mono font-bold text-tertiary">—</p>
              )}
            </div>

            <div className="space-y-1 rounded border border-border bg-surface-3 p-3">
              <p className="text-[10px] font-bold text-tertiary uppercase tracking-wide">Comp Mix</p>
              <div className="space-y-2 mt-2">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-secondary font-medium">Base</span>
                  <span className="text-primary font-bold">{current ? ((current.salary_amount / current.total_comp) * 100).toFixed(0) : 0}%</span>
                </div>
                <div className="w-full h-1.5 bg-surface-3 rounded-full overflow-hidden flex">
                  <div className="h-full bg-accent" style={{ width: `${current ? (current.salary_amount / current.total_comp) * 100 : 0}%` }} />
                  <div className="h-full bg-blue-500" style={{ width: `${current ? ((current.total_comp - current.salary_amount) / current.total_comp) * 100 : 0}%` }} />
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-secondary font-medium">Variable/Equity</span>
                  <span className="text-blue-400 font-bold">{current ? (((current.total_comp - current.salary_amount) / current.total_comp) * 100).toFixed(0) : 0}%</span>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-3 rounded border border-accent/10 bg-accent-muted/10 p-4">
            <h4 className="text-[10px] font-bold text-accent mb-3 uppercase tracking-wide flex items-center gap-2">
              <Award size={12} />
              Peak Compensation
            </h4>
            <div className="space-y-1">
              <p className="text-lg font-mono font-bold text-primary">{peakComp ? formatCurrency(peakComp.totalComp) : '—'}</p>
              <p className="text-[10px] text-tertiary font-bold uppercase tracking-tight">{peakComp ? formatDateDisplay(peakComp.date) : 'No data'}</p>
            </div>
          </div>
        </div>

        {/* Main Content Area */}
        <div className="space-y-8">
          {error && (
            <div className="p-4 bg-loss-bg border border-loss/20 text-loss rounded text-xs flex items-center gap-3">
              <X size={16} />
              {error}
            </div>
          )}

          {successMessage && (
            <div className="p-4 bg-gain-bg border border-gain/20 text-gain rounded text-xs flex items-center gap-3">
              <Check size={16} />
              {successMessage}
            </div>
          )}

          {/* Chart Section */}
          {chartData.length > 1 && (
            <div className="card p-6">
              <div className="flex items-center gap-2 mb-6">
                <TrendingUp className="text-accent w-4 h-4" />
                <h2 className="text-xs font-bold uppercase tracking-wide text-secondary">Compensation Trajectory</h2>
              </div>
              <div className="h-64 md:h-[400px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <filter id="area-glow" x="-20%" y="-20%" width="140%" height="140%">
                        <feGaussianBlur stdDeviation="3" result="blur" />
                        <feComposite in="SourceGraphic" in2="blur" operator="over" />
                      </filter>
                      {areaGradient('salaryGrad', CHART_COLORS[1])}
                      {areaGradient('compGrad', CHART_COLORS[0])}
                    </defs>
                    <CartesianGrid {...GRID_STYLE} vertical={false} strokeOpacity={0.5} />
                    <XAxis dataKey="label" {...AXIS_STYLE} minTickGap={30} padding={{ left: 10, right: 10 }} />
                    <YAxis {...AXIS_STYLE} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}K`} axisLine={false} width={60} />
                    <Tooltip content={<ChartTooltip formatValue={(v) => formatCurrency(v, { maximumFractionDigits: 0 })} />} cursor={{ stroke: 'var(--border)', strokeWidth: 1 }} />
                    <Area type="monotone" dataKey="totalComp" name="Total Comp" stroke={CHART_COLORS[0]} fill="url(#compGrad)" strokeWidth={3} filter="url(#area-glow)" animationDuration={1500} />
                    <Area type="monotone" dataKey="salary" name="Base Salary" stroke={CHART_COLORS[1]} fill="url(#salaryGrad)" strokeWidth={2} animationDuration={1500} />
                    {peakComp && (
                      <ReferenceDot
                        x={peakComp.label}
                        y={peakComp.totalComp}
                        r={6}
                        fill="var(--accent)"
                        stroke="var(--bg-surface)"
                        strokeWidth={3}
                      />
                    )}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* History Table */}
          <div className="space-y-4">
            <div className="flex items-center justify-between px-2">
              <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-tertiary">Career History</h2>
            </div>
            
            <div className="card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-border">
                  <thead className="bg-surface-2">
                    <tr>
                      {['Date', 'Title', 'Base Salary', 'Equity/Bonus', 'Total Comp', 'Change', ''].map((h) => (
                        <th key={h} className="px-5 py-4 text-left text-[10px] font-bold uppercase tracking-wide text-tertiary">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border bg-surface">
                    {records.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-5 py-12 text-center text-tertiary text-sm font-medium">No records found. Add your first salary record to start tracking.</td>
                      </tr>
                    ) : (
                      [...records].sort((a, b) => new Date(b.effective_date) - new Date(a.effective_date)).map((r) => (
                        <tr key={r.id} className="hover:bg-surface-2 transition-colors group">
                          <td className="px-5 py-4 whitespace-nowrap text-xs font-mono text-secondary">{formatDateDisplay(r.effective_date)}</td>
                          <td className="px-5 py-4">
                            <div className="text-sm font-bold text-primary">{r.title}</div>
                          </td>
                          <td className="px-5 py-4 text-sm font-mono text-primary">{formatCurrency(r.salary_amount)}</td>
                          <td className="px-5 py-4 text-xs font-mono text-secondary">
                            {r.psu > 0 || r.rsu > 0 ? formatCurrency((parseFloat(r.psu) || 0) + (parseFloat(r.rsu) || 0)) : <span className="opacity-30">—</span>}
                          </td>
                          <td className="px-5 py-4 text-sm font-mono font-bold text-accent">{formatCurrency(r.total_comp)}</td>
                          <td className="px-5 py-4">
                            {r.change_amount ? (
                              <div className="flex flex-col">
                                <span className="text-xs font-bold text-gain">+{formatCurrency(r.change_amount)}</span>
                                <span className="text-[10px] font-bold text-gain opacity-70">({(parseFloat(r.change_percent) * 100).toFixed(1)}%)</span>
                              </div>
                            ) : <span className="text-tertiary opacity-30">—</span>}
                          </td>
                          <td className="px-5 py-4 text-right">
                            <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button onClick={() => handleEdit(r)} className="p-2 text-accent hover:bg-accent/10 rounded transition-colors"><Edit2 size={14} /></button>
                              <button onClick={() => setDeletingRecord(r)} className="p-2 text-loss hover:bg-loss/10 rounded transition-colors"><Trash2 size={14} /></button>
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
          
          <div className="flex items-center justify-center gap-8 text-[10px] text-tertiary uppercase tracking-wide font-bold opacity-60">
            <span className="flex items-center gap-2"><div className="w-1.5 h-1.5 rounded-full bg-accent" /> Total Comp</span>
            <span className="flex items-center gap-2"><div className="w-1.5 h-1.5 rounded-full bg-surface-3 border border-border" /> Base Salary</span>
            <span className="flex items-center gap-2"><div className="w-1.5 h-1.5 rounded-full bg-surface-3 border border-border" /> Career progression</span>
          </div>
        </div>
      </div>

      {/* Form Modal */}
      <AnimatePresence>
        {isFormOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <Motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/60 " onClick={() => setIsFormOpen(false)} />
            <Motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} className="relative bg-surface rounded-3xl border border-border shadow-2xl max-w-lg w-full overflow-hidden">
              <div className="p-6 border-b border-border  flex items-center justify-between">
                <h2 className="text-lg font-bold text-primary">{editingRecord ? 'Modify' : 'New'} Salary Record</h2>
                <button onClick={() => setIsFormOpen(false)} className="text-tertiary hover:text-primary transition-colors"><X size={20} /></button>
              </div>
              <form onSubmit={handleSave} className="p-6 space-y-5">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wide text-tertiary mb-2 px-1">Effective Date</label>
                    <div className="relative">
                      <input type="date" value={formData.effective_date} onChange={(e) => setFormData({ ...formData, effective_date: e.target.value })} className="w-full bg-surface-3 border-border rounded px-3 py-2.5 text-sm focus:ring-1 focus:ring-accent outline-none" required />
                      <Calendar size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-tertiary pointer-events-none" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wide text-tertiary mb-2 px-1">Job Title</label>
                    <input type="text" value={formData.title} onChange={(e) => setFormData({ ...formData, title: e.target.value })} className="w-full bg-surface-3 border-border rounded px-3 py-2.5 text-sm focus:ring-1 focus:ring-accent outline-none" placeholder="e.g. Senior Engineer" required />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wide text-tertiary mb-2 px-1">Base Salary</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-tertiary font-mono">$</span>
                      <input type="number" step="0.01" value={formData.salary_amount} onChange={(e) => setFormData({ ...formData, salary_amount: e.target.value })} className="w-full bg-surface-3 border-border rounded pl-7 pr-3 py-2.5 text-sm font-mono focus:ring-1 focus:ring-accent outline-none" required />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wide text-tertiary mb-2 px-1">Total Comp</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-tertiary font-mono">$</span>
                      <input type="number" step="0.01" value={formData.total_comp} onChange={(e) => setFormData({ ...formData, total_comp: e.target.value })} className="w-full bg-surface-3 border-border rounded pl-7 pr-3 py-2.5 text-sm font-mono focus:ring-1 focus:ring-accent outline-none" required />
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4 pt-2">
                  <div className="space-y-4">
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wide text-tertiary mb-2 px-1">PSU Value</label>
                      <input type="number" step="0.01" value={formData.psu} onChange={(e) => setFormData({ ...formData, psu: e.target.value })} className="w-full bg-surface-3 border-border rounded px-3 py-2.5 text-sm font-mono focus:ring-1 focus:ring-accent outline-none" />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wide text-tertiary mb-2 px-1">RSU Value</label>
                      <input type="number" step="0.01" value={formData.rsu} onChange={(e) => setFormData({ ...formData, rsu: e.target.value })} className="w-full bg-surface-3 border-border rounded px-3 py-2.5 text-sm font-mono focus:ring-1 focus:ring-accent outline-none" />
                    </div>
                  </div>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wide text-tertiary mb-2 px-1">Change Amount</label>
                      <input type="number" step="0.01" value={formData.change_amount} onChange={(e) => setFormData({ ...formData, change_amount: e.target.value })} className="w-full bg-surface-3 border-border rounded px-3 py-2.5 text-sm font-mono focus:ring-1 focus:ring-accent outline-none" placeholder="+15000" />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wide text-tertiary mb-2 px-1">Change %</label>
                      <input type="number" step="0.01" value={formData.change_percent} onChange={(e) => setFormData({ ...formData, change_percent: e.target.value })} className="w-full bg-surface-3 border-border rounded px-3 py-2.5 text-sm font-mono focus:ring-1 focus:ring-accent outline-none" placeholder="8.5" />
                    </div>
                  </div>
                </div>
                <div className="flex justify-end gap-3 pt-4">
                  <button type="button" onClick={() => setIsFormOpen(false)} className="px-6 py-3 bg-surface-2 text-secondary hover:text-primary rounded text-xs font-bold uppercase tracking-wider transition-all">Cancel</button>
                  <button type="submit" className="px-8 py-3 bg-accent text-white hover:bg-accent-hover rounded text-xs font-bold uppercase tracking-wider transition-all">Save Record</button>
                </div>
              </form>
            </Motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Delete Confirm Modal */}
      <AnimatePresence>
        {deletingRecord && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <Motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/60 " onClick={() => setDeletingRecord(null)} />
            <Motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} className="relative bg-surface rounded-3xl border border-border shadow-2xl max-w-sm w-full p-6 text-center">
              <div className="w-16 h-16 bg-loss/10 text-loss rounded-full flex items-center justify-center mx-auto mb-4">
                <Trash2 size={24} />
              </div>
              <h2 className="text-xl font-bold text-primary mb-2">Confirm Delete</h2>
              <p className="text-sm text-secondary mb-8">Delete the salary record for <span className="text-primary font-bold">{formatDateDisplay(deletingRecord.effective_date)}</span>?</p>
              <div className="flex gap-3">
                <button onClick={() => setDeletingRecord(null)} className="flex-1 py-3 bg-surface-3 text-secondary rounded text-xs font-bold uppercase tracking-wider hover:bg-surface-2 transition-all">Cancel</button>
                <button onClick={handleDeleteConfirm} className="flex-1 py-3 bg-loss text-white rounded text-xs font-bold uppercase tracking-wider hover:opacity-90 transition-all">Delete</button>
              </div>
            </Motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default SalaryHistory;
