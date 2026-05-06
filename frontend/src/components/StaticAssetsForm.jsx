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
        manual_value: asset.manual_value ?? '',
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
    if (asset?.is_plaid_managed) return;

    if (!validate()) {
      return;
    }

    setIsSubmitting(true);
    try {
      const dataToSubmit = {
        account_id: parseInt(formData.account_id),
        name: formData.name.trim(),
        ticker: null,
        quantity: null,
        manual_value: parseFloat(formData.manual_value),
        category: formData.category ? formData.category.trim() : null,
        notes: formData.notes ? formData.notes.trim() : null,
        location: asset?.location || null,
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
    if (errors[name]) {
      setErrors((prev) => ({ ...prev, [name]: '' }));
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-surface rounded-card border border-border shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="p-5 border-b border-border">
          <h2 className="text-lg font-bold text-primary">
            {asset ? 'Edit Static Asset' : 'Add New Static Asset'}
          </h2>
          {asset?.is_plaid_managed && (
            <div className="mt-2 px-3 py-2 rounded-md bg-accent/10 border border-accent/20 text-xs text-accent">
              This asset is managed by Plaid and cannot be edited manually.
            </div>
          )}
        </div>

        <div className="p-5">
          <form onSubmit={handleSubmit}>
            <fieldset disabled={asset?.is_plaid_managed}>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-secondary mb-1">
                  Account <span className="text-loss">*</span>
                </label>
                <select
                  name="account_id"
                  value={formData.account_id}
                  onChange={handleChange}
                  className={`w-full px-3 py-2 rounded-md border min-h-[44px] touch-manipulation ${
                    errors.account_id ? 'border-loss' : 'border-input-border'
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
                  <p className="text-sm text-loss mt-1">{errors.account_id}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-secondary mb-1">
                  Asset Name <span className="text-loss">*</span>
                </label>
                <input
                  type="text"
                  name="name"
                  value={formData.name}
                  onChange={handleChange}
                  className={`w-full px-3 py-2 rounded-md border min-h-[44px] touch-manipulation ${
                    errors.name ? 'border-loss' : 'border-input-border'
                  }`}
                  disabled={isSubmitting}
                  placeholder="e.g., 702 Antelop St. Scott City, KS"
                />
                {errors.name && (
                  <p className="text-sm text-loss mt-1">{errors.name}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-secondary mb-1">
                  Value <span className="text-loss">*</span>
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-2 text-secondary">$</span>
                  <input
                    type="number"
                    step="0.01"
                    name="manual_value"
                    value={formData.manual_value}
                    onChange={handleChange}
                    className={`w-full pl-8 pr-3 py-2 rounded-md border min-h-[44px] touch-manipulation ${
                      errors.manual_value ? 'border-loss' : 'border-input-border'
                    }`}
                    disabled={isSubmitting}
                    placeholder="25000.00"
                  />
                </div>
                <p className="text-xs text-tertiary mt-1">
                  Use negative values for liabilities (e.g., -12500 for loans)
                </p>
                {errors.manual_value && (
                  <p className="text-sm text-loss mt-1">{errors.manual_value}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-secondary mb-1">
                  Category
                </label>
                <select
                  name="category"
                  value={formData.category}
                  onChange={handleChange}
                  className="w-full px-3 py-2 rounded-md border border-input-border min-h-[44px] touch-manipulation"
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

              <div>
                <label className="block text-sm font-medium text-secondary mb-1">
                  Notes/Description
                </label>
                <textarea
                  name="notes"
                  value={formData.notes}
                  onChange={handleChange}
                  rows="3"
                  className="w-full px-3 py-2 rounded-md border border-input-border"
                  disabled={isSubmitting}
                  placeholder="Additional details about this asset or liability"
                />
              </div>

              {errors.submit && (
                <div className="bg-loss-bg text-loss border border-loss/20 rounded-lg p-3">
                  {errors.submit}
                </div>
              )}
            </div>

            </fieldset>
            <div className="p-5 border-t border-border -mx-5 mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 bg-surface-3 text-secondary hover:bg-surface-3/80 rounded-md disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px] touch-manipulation"
              >
                {asset?.is_plaid_managed ? 'Close' : 'Cancel'}
              </button>
              {!asset?.is_plaid_managed && (
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 bg-accent text-inverse hover:bg-accent-hover rounded-md disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px] touch-manipulation"
                >
                  {isSubmitting ? 'Saving...' : 'Save'}
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default StaticAssetsForm;
