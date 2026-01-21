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
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <h2 className="text-2xl font-bold mb-4 text-gray-900">Bulk Import Holdings</h2>

          {/* File Upload */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              CSV File
            </label>
            <div className="flex items-center gap-2">
              <input
                type="file"
                accept=".csv"
                onChange={handleFileChange}
                disabled={importing}
                className="flex-1 text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 disabled:opacity-50"
              />
              <button
                onClick={handlePreview}
                disabled={!file || importing}
                className="px-4 py-2 text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {importing && !preview ? 'Loading...' : 'Preview'}
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Expected format: account,ticker,name,quantity,category
            </p>
            <p className="text-xs text-gray-500">
              Example: Crypto,BTC,Bitcoin,0.5,Crypto
            </p>
          </div>

          {/* Error Message */}
          {error && (
            <div className="mb-4 p-3 bg-red-100 border border-red-400 text-red-700 rounded">
              {error}
            </div>
          )}

          {/* Preview Results */}
          {preview && (
            <div className="mb-6">
              <h3 className="text-lg font-semibold mb-3 text-gray-900">Import Preview</h3>
              
              {/* Summary */}
              <div className="grid grid-cols-4 gap-4 mb-4">
                <div className="p-3 bg-blue-50 rounded">
                  <div className="text-2xl font-bold text-blue-700">{preview.preview.total}</div>
                  <div className="text-xs text-gray-600">Total Rows</div>
                </div>
                <div className="p-3 bg-green-50 rounded">
                  <div className="text-2xl font-bold text-green-700">{preview.preview.valid}</div>
                  <div className="text-xs text-gray-600">Valid</div>
                </div>
                <div className="p-3 bg-yellow-50 rounded">
                  <div className="text-2xl font-bold text-yellow-700">{preview.preview.duplicates}</div>
                  <div className="text-xs text-gray-600">Duplicates</div>
                </div>
                <div className="p-3 bg-red-50 rounded">
                  <div className="text-2xl font-bold text-red-700">{preview.preview.errors}</div>
                  <div className="text-xs text-gray-600">Errors</div>
                </div>
              </div>

              {/* Valid Rows */}
              {preview.validRows && preview.validRows.length > 0 && (
                <div className="mb-4">
                  <h4 className="font-medium text-green-700 mb-2">Valid Holdings ({preview.validRows.length})</h4>
                  <div className="max-h-40 overflow-y-auto border rounded">
                    <table className="min-w-full text-xs">
                      <thead className="bg-gray-50 sticky top-0">
                        <tr>
                          <th className="px-2 py-1 text-left">Account</th>
                          <th className="px-2 py-1 text-left">Ticker</th>
                          <th className="px-2 py-1 text-left">Name</th>
                          <th className="px-2 py-1 text-left">Quantity</th>
                          <th className="px-2 py-1 text-left">Category</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.validRows.map((row, idx) => (
                          <tr key={idx} className="border-t">
                            <td className="px-2 py-1">{row.account_name}</td>
                            <td className="px-2 py-1">{row.ticker || '-'}</td>
                            <td className="px-2 py-1">{row.name}</td>
                            <td className="px-2 py-1">{row.quantity || '-'}</td>
                            <td className="px-2 py-1">{row.category || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Duplicates */}
              {preview.duplicates && preview.duplicates.length > 0 && (
                <div className="mb-4">
                  <h4 className="font-medium text-yellow-700 mb-2">Duplicate Holdings ({preview.duplicates.length})</h4>
                  <div className="max-h-40 overflow-y-auto border rounded">
                    <table className="min-w-full text-xs">
                      <thead className="bg-gray-50 sticky top-0">
                        <tr>
                          <th className="px-2 py-1 text-left">Row</th>
                          <th className="px-2 py-1 text-left">Account</th>
                          <th className="px-2 py-1 text-left">Ticker</th>
                          <th className="px-2 py-1 text-left">Name</th>
                          <th className="px-2 py-1 text-left">Existing ID</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.duplicates.map((dup, idx) => (
                          <tr key={idx} className="border-t">
                            <td className="px-2 py-1">{dup.row}</td>
                            <td className="px-2 py-1">{dup.data.account_name}</td>
                            <td className="px-2 py-1">{dup.data.ticker || '-'}</td>
                            <td className="px-2 py-1">{dup.data.name}</td>
                            <td className="px-2 py-1">#{dup.existing_id}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <label className="flex items-center gap-2 mt-2">
                    <input
                      type="checkbox"
                      checked={skipDuplicates}
                      onChange={(e) => setSkipDuplicates(e.target.checked)}
                      className="rounded"
                    />
                    <span className="text-sm text-gray-700">Skip duplicates during import</span>
                  </label>
                </div>
              )}

              {/* Errors */}
              {preview.errors && preview.errors.length > 0 && (
                <div className="mb-4">
                  <h4 className="font-medium text-red-700 mb-2">Errors ({preview.errors.length})</h4>
                  <div className="max-h-40 overflow-y-auto border rounded">
                    <table className="min-w-full text-xs">
                      <thead className="bg-gray-50 sticky top-0">
                        <tr>
                          <th className="px-2 py-1 text-left">Row</th>
                          <th className="px-2 py-1 text-left">Error</th>
                          <th className="px-2 py-1 text-left">Data</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.errors.map((err, idx) => (
                          <tr key={idx} className="border-t">
                            <td className="px-2 py-1">{err.row}</td>
                            <td className="px-2 py-1">{err.error}</td>
                            <td className="px-2 py-1 text-xs">{JSON.stringify(err.data)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Buttons */}
          <div className="flex justify-end gap-2 mt-6">
            <button
              type="button"
              onClick={handleClose}
              disabled={importing}
              className="px-4 py-2 text-gray-700 bg-gray-200 rounded-md hover:bg-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            {preview && preview.validRows && preview.validRows.length > 0 && (
              <button
                onClick={handleConfirmImport}
                disabled={importing}
                className="px-4 py-2 text-white bg-green-600 rounded-md hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
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
