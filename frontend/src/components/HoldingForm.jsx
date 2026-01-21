import React, { useState, useEffect } from 'react';

const HoldingForm = ({ isOpen, onClose, onSave, holding, accounts }) => {
  const [formData, setFormData] = useState({
    account_id: '',
    ticker: '',
    name: '',
    quantity: '',
    manual_value: '',
    category: '',
  });
  const [errors, setErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (holding) {
      setFormData({
        account_id: holding.account_id || '',
        ticker: holding.ticker || '',
        name: holding.name || '',
        quantity: holding.quantity || '',
        manual_value: holding.manual_value || '',
        category: holding.category || '',
      });
    } else {
      setFormData({
        account_id: '',
        ticker: '',
        name: '',
        quantity: '',
        manual_value: '',
        category: '',
      });
    }
    setErrors({});
  }, [holding, isOpen]);

  const validate = () => {
    const newErrors = {};

    if (!formData.account_id) {
      newErrors.account_id = 'Account is required';
    }

    if (!formData.name || formData.name.trim() === '') {
      newErrors.name = 'Name is required';
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
        ticker: formData.ticker ? formData.ticker.trim() : null,
        quantity: formData.quantity ? parseFloat(formData.quantity) : null,
        manual_value: formData.manual_value ? parseFloat(formData.manual_value) : null,
        category: formData.category ? formData.category.trim() : null,
      };

      await onSave(dataToSubmit);
      onClose();
    } catch (error) {
      console.error('Error saving holding:', error);
      const errorMessage = error.response?.data?.error || 'Failed to save holding';
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
            {holding ? 'Edit Holding' : 'Add New Holding'}
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
                Name <span className="text-red-500">*</span>
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
                placeholder="e.g., Bitcoin, Real Estate Property"
              />
              {errors.name && (
                <p className="text-red-500 text-sm mt-1">{errors.name}</p>
              )}
            </div>

            {/* Ticker */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Ticker <span className="text-gray-400 text-xs">(optional)</span>
              </label>
              <input
                type="text"
                name="ticker"
                value={formData.ticker}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={isSubmitting}
                placeholder="e.g., BTC, AAPL"
              />
            </div>

            {/* Quantity */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Quantity <span className="text-gray-400 text-xs">(optional)</span>
              </label>
              <input
                type="number"
                step="any"
                name="quantity"
                value={formData.quantity}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={isSubmitting}
                placeholder="e.g., 1.5"
              />
            </div>

            {/* Manual Value */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Manual Value <span className="text-gray-400 text-xs">(optional)</span>
              </label>
              <input
                type="number"
                step="0.01"
                name="manual_value"
                value={formData.manual_value}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={isSubmitting}
                placeholder="e.g., 50000.00"
              />
            </div>

            {/* Category */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Category <span className="text-gray-400 text-xs">(optional)</span>
              </label>
              <input
                type="text"
                name="category"
                value={formData.category}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={isSubmitting}
                placeholder="e.g., Crypto, Stocks, Property"
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

export default HoldingForm;
