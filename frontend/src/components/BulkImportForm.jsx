import React, { useState } from 'react';
import { holdings as holdingsAPI } from '../utils/api';

const BulkImportForm = ({ isOpen, onClose, onSuccess }) => {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState(null);
  const [skipDuplicates, setSkipDuplicates] = useState(false);

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      if (!selectedFile.name.endsWith('.csv')) {
        setError('Please select a CSV file');
        return;
      }
      const maxSize = 5 * 1024 * 1024;
      if (selectedFile.size > maxSize) {
        setError('File size exceeds 5MB. Please use a smaller file.');
        return;
      }
      setFile(selectedFile);
      setError(null);
      setPreview(null);
    }
  };

  const handlePreview = async () => {
    if (!file) {
      setError('Please select a file first');
      return;
    }

    setImporting(true);
    setError(null);

    try {
      const fileContent = await file.text();
      const result = await holdingsAPI.bulkImport(fileContent);
      setPreview(result);
    } catch (err) {
      console.error('Preview error:', err);
      setError(err.response?.data?.error || 'Failed to preview import');
    } finally {
      setImporting(false);
    }
  };

  const handleConfirmImport = async () => {
    if (!preview || !preview.validRows || preview.validRows.length === 0) {
      setError('No valid rows to import');
      return;
    }

    setImporting(true);
    setError(null);

    try {
      const result = await holdingsAPI.bulkImportConfirm(preview.validRows, skipDuplicates);
      onSuccess(result);
      handleClose();
    } catch (err) {
      console.error('Import error:', err);
      setError(err.response?.data?.error || 'Failed to import holdings');
    } finally {
      setImporting(false);
    }
  };

  const handleClose = () => {
    setFile(null);
    setPreview(null);
    setError(null);
    setSkipDuplicates(false);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-surface rounded-none border border-border shadow-xl w-full max-w-4xl mx-4 max-h-[90vh] overflow-y-auto">
        <div className="p-5 border-b border-border">
          <h2 className="text-lg font-bold text-primary">Bulk Import Holdings</h2>
        </div>

        <div className="p-5">
          <div className="mb-6">
            <label className="block text-sm font-medium text-secondary mb-2">
              CSV File
            </label>
            <div className="border-2 border-dashed border-border rounded p-6 text-center hover:border-border-hover">
              <div className="flex flex-col items-center gap-3">
                <p className="text-secondary text-sm">Select a CSV file to import</p>
                <div className="flex items-center gap-2 w-full justify-center">
                  <input
                    type="file"
                    accept=".csv"
                    onChange={handleFileChange}
                    disabled={importing}
                    className="flex-1 text-sm text-secondary file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-accent-muted file:text-accent hover:file:bg-accent-subtle disabled:opacity-50"
                  />
                  <button
                    onClick={handlePreview}
                    disabled={!file || importing}
                    className="px-4 py-2 bg-accent text-white hover:bg-accent-hover rounded-md disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px] touch-manipulation"
                  >
                    {importing && !preview ? 'Loading...' : 'Preview'}
                  </button>
                </div>
              </div>
            </div>
            <p className="text-xs text-tertiary mt-2">
              Expected format: account,ticker,name,quantity,category
            </p>
            <p className="text-xs text-tertiary">
              Example: Crypto,BTC,Bitcoin,0.5,Crypto
            </p>
          </div>

          {error && (
            <div className="mb-4 bg-loss-bg text-loss border border-loss/20 rounded p-3">
              {error}
            </div>
          )}

          {preview && (
            <div className="mb-6">
              <h3 className="text-lg font-semibold mb-3 text-primary">Import Preview</h3>

              <div className="grid grid-cols-4 gap-4 mb-4">
                <div className="bg-surface-3 rounded p-3">
                  <div className="text-xl font-mono font-bold text-primary">{preview.preview.total}</div>
                  <div className="text-xs text-secondary">Total Rows</div>
                </div>
                <div className="bg-gain-bg rounded p-3">
                  <div className="text-xl font-mono font-bold text-gain">{preview.preview.valid}</div>
                  <div className="text-xs text-secondary">Valid</div>
                </div>
                <div className="bg-amber-500/10 rounded p-3">
                  <div className="text-xl font-mono font-bold text-amber-400">{preview.preview.duplicates}</div>
                  <div className="text-xs text-secondary">Duplicates</div>
                </div>
                <div className="bg-loss-bg rounded p-3">
                  <div className="text-xl font-mono font-bold text-loss">{preview.preview.errors}</div>
                  <div className="text-xs text-secondary">Errors</div>
                </div>
              </div>

              {preview.validRows && preview.validRows.length > 0 && (
                <div className="mb-4">
                  <h4 className="font-medium text-gain mb-2">Valid Holdings ({preview.validRows.length})</h4>
                  <div className="max-h-40 overflow-y-auto bg-surface rounded-none border border-border">
                    <table className="min-w-full text-xs">
                      <thead className="bg-surface-2 sticky top-0">
                        <tr>
                          <th className="px-2 py-1 text-left text-secondary">Account</th>
                          <th className="px-2 py-1 text-left text-secondary">Ticker</th>
                          <th className="px-2 py-1 text-left text-secondary">Name</th>
                          <th className="px-2 py-1 text-left text-secondary">Quantity</th>
                          <th className="px-2 py-1 text-left text-secondary">Category</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {preview.validRows.map((row, idx) => (
                          <tr key={idx} className="hover:bg-surface-3">
                            <td className="px-2 py-1 text-primary">{row.account_name}</td>
                            <td className="px-2 py-1 text-primary">{row.ticker || '-'}</td>
                            <td className="px-2 py-1 text-primary">{row.name}</td>
                            <td className="px-2 py-1 text-primary">{row.quantity || '-'}</td>
                            <td className="px-2 py-1 text-primary">{row.category || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {preview.duplicates && preview.duplicates.length > 0 && (
                <div className="mb-4">
                  <h4 className="font-medium text-amber-400 mb-2">Duplicate Holdings ({preview.duplicates.length})</h4>
                  <div className="max-h-40 overflow-y-auto bg-surface rounded-none border border-border">
                    <table className="min-w-full text-xs">
                      <thead className="bg-surface-2 sticky top-0">
                        <tr>
                          <th className="px-2 py-1 text-left text-secondary">Row</th>
                          <th className="px-2 py-1 text-left text-secondary">Account</th>
                          <th className="px-2 py-1 text-left text-secondary">Ticker</th>
                          <th className="px-2 py-1 text-left text-secondary">Name</th>
                          <th className="px-2 py-1 text-left text-secondary">Existing ID</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {preview.duplicates.map((dup, idx) => (
                          <tr key={idx} className="hover:bg-surface-3">
                            <td className="px-2 py-1 text-primary">{dup.row}</td>
                            <td className="px-2 py-1 text-primary">{dup.data.account_name}</td>
                            <td className="px-2 py-1 text-primary">{dup.data.ticker || '-'}</td>
                            <td className="px-2 py-1 text-primary">{dup.data.name}</td>
                            <td className="px-2 py-1 text-primary">#{dup.existing_id}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <label className="flex items-center gap-2 mt-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={skipDuplicates}
                      onChange={(e) => setSkipDuplicates(e.target.checked)}
                      className="rounded accent-accent"
                    />
                    <span className="text-sm text-secondary">Skip duplicates during import</span>
                  </label>
                </div>
              )}

              {preview.errors && preview.errors.length > 0 && (
                <div className="mb-4">
                  <h4 className="font-medium text-loss mb-2">Errors ({preview.errors.length})</h4>
                  <div className="max-h-40 overflow-y-auto bg-surface rounded-none border border-border">
                    <table className="min-w-full text-xs">
                      <thead className="bg-surface-2 sticky top-0">
                        <tr>
                          <th className="px-2 py-1 text-left text-secondary">Row</th>
                          <th className="px-2 py-1 text-left text-secondary">Error</th>
                          <th className="px-2 py-1 text-left text-secondary">Data</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {preview.errors.map((err, idx) => (
                          <tr key={idx} className="hover:bg-surface-3">
                            <td className="px-2 py-1 text-primary">{err.row}</td>
                            <td className="px-2 py-1 text-loss">{err.error}</td>
                            <td className="px-2 py-1 text-secondary text-xs">{JSON.stringify(err.data)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="p-5 border-t border-border -mx-5 flex justify-end gap-3">
            <button
              type="button"
              onClick={handleClose}
              disabled={importing}
              className="px-4 py-2 bg-surface-3 text-secondary hover:bg-surface-3/80 rounded-md disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px] touch-manipulation"
            >
              Cancel
            </button>
            {preview && preview.validRows && preview.validRows.length > 0 && (
              <button
                onClick={handleConfirmImport}
                disabled={importing}
                className="px-4 py-2 bg-accent text-white hover:bg-accent-hover rounded-md disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px] touch-manipulation"
              >
                {importing ? 'Importing...' : `Import ${preview.validRows.length} Holdings`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default BulkImportForm;
