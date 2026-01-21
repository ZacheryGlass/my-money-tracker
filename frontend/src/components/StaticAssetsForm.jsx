import React, { useState, useEffect } from 'react';

const StaticAssetsForm = ({ isOpen, onClose, onSave, asset, accounts }) => {
  const [formData, setFormData] = useState({
    account_id: '',
    name: '',
    manual_value: '',
    category: '',
    notes: '',
  });
  const [errors, setErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (asset) {
      setFormData({
        account_id: asset.account_id || '',
        name: asset.name || '',
        manual_value: asset.manual_value || '',
        category: asset.category || '',
        notes: asset.notes || '',
      });
    } else {
      setFormData({
        account_id: '',
        name: '',
        manual_value: '',
        category: '',
        notes: '',
      });
    }
    setErrors({});
  }, [asset, isOpen]);

  const validate = () => {
    const newErrors = {};

    if (!formData.account_id) {
      newErrors.account_id = 'Account is required';
    }

    if (!formData.name || formData.name.trim() === '') {
      newErrors.name = 'Name is required';
    }

    if (!formData.manual_value || isNaN(formData.manual_value)) {
      newErrors.manual_value = 'Valid value is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!validate()) {
      return;
    }

    setIsSubmitting(true);
    try {
      const dataToSubmit = {
        account_id: parseInt(formData.account_id),
        name: formData.name.trim(),
        ticker: null, // Static assets don't have tickers
        quantity: null, // Static assets don't have quantity
        manual_value: parseFloat(formData.manual_value),
        category: formData.category ? formData.category.trim() : null,
        notes: formData.notes ? formData.notes.trim() : null,
      };

      await onSave(dataToSubmit);
      onClose();
    } catch (error) {
      console.error('Error saving asset:', error);
      const errorMessage = error.response?.data?.error || 'Failed to save asset';
      setErrors({ submit: errorMessage });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    // Clear error for this field
    if (errors[name]) {
      setErrors((prev) => ({ ...prev, [name]: '' }));
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <h2 className="text-2xl font-bold mb-4 text-gray-900">
            {asset ? 'Edit Static Asset' : 'Add New Static Asset'}
          </h2>

          <form onSubmit={handleSubmit}>
            {/* Account Dropdown */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Account <span className="text-red-500">*</span>
              </label>
              <select
                name="account_id"
                value={formData.account_id}
                onChange={handleChange}
                className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  errors.account_id ? 'border-red-500' : 'border-gray-300'
                }`}
                disabled={isSubmitting}
              >
                <option value="">Select an account</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
              {errors.account_id && (
                <p className="text-red-500 text-sm mt-1">{errors.account_id}</p>
              )}
            </div>

            {/* Name */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Asset Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                name="name"
                value={formData.name}
                onChange={handleChange}
                className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  errors.name ? 'border-red-500' : 'border-gray-300'
                }`}
                disabled={isSubmitting}
                placeholder="e.g., 702 Antelop St. Scott City, KS"
              />
              {errors.name && (
                <p className="text-red-500 text-sm mt-1">{errors.name}</p>
              )}
            </div>

            {/* Manual Value */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Value <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <span className="absolute left-3 top-2 text-gray-500">$</span>
                <input
                  type="number"
                  step="0.01"
                  name="manual_value"
                  value={formData.manual_value}
                  onChange={handleChange}
                  className={`w-full pl-8 pr-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    errors.manual_value ? 'border-red-500' : 'border-gray-300'
                  }`}
                  disabled={isSubmitting}
                  placeholder="25000.00"
                />
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Use negative values for liabilities (e.g., -12500 for loans)
              </p>
              {errors.manual_value && (
                <p className="text-red-500 text-sm mt-1">{errors.manual_value}</p>
              )}
            </div>

            {/* Category */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Category
              </label>
              <select
                name="category"
                value={formData.category}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={isSubmitting}
              >
                <option value="">Select category</option>
                <option value="Real Estate">Real Estate</option>
                <option value="Debt">Debt</option>
                <option value="Student Loan">Student Loan</option>
                <option value="Car Loan">Car Loan</option>
                <option value="Line of Credit">Line of Credit</option>
                <option value="Other">Other</option>
              </select>
            </div>

            {/* Notes */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Notes/Description
              </label>
              <textarea
                name="notes"
                value={formData.notes}
                onChange={handleChange}
                rows="3"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={isSubmitting}
                placeholder="Additional details about this asset or liability"
              />
            </div>

            {errors.submit && (
              <div className="mb-4 p-3 bg-red-100 border border-red-400 text-red-700 rounded">
                {errors.submit}
              </div>
            )}

            {/* Buttons */}
            <div className="flex justify-end gap-2 mt-6">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="px-4 py-2 text-gray-700 bg-gray-200 rounded-md hover:bg-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-4 py-2 text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? 'Saving...' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default StaticAssetsForm;
