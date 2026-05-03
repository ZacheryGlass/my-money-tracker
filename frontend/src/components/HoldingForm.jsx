import React, { useState, useEffect } from 'react';

const HoldingForm = ({ isOpen, onClose, onSave, holding, accounts }) => {
  const [formData, setFormData] = useState({
    account_id: '',
    ticker: '',
    name: '',
    quantity: '',
    manual_value: '',
    category: '',
    notes: '',
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
        notes: holding.notes || '',
      });
    } else {
      setFormData({
        account_id: '',
        ticker: '',
        name: '',
        quantity: '',
        manual_value: '',
        category: '',
        notes: '',
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
        notes: formData.notes ? formData.notes.trim() : null,
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
            {holding ? 'Edit Holding' : 'Add New Holding'}
          </h2>
        </div>

        <div className="p-5">
          <form onSubmit={handleSubmit}>
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
                  Name <span className="text-loss">*</span>
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
                  placeholder="e.g., Bitcoin, Real Estate Property"
                />
                {errors.name && (
                  <p className="text-sm text-loss mt-1">{errors.name}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-secondary mb-1">
                  Ticker <span className="text-tertiary text-xs">(optional)</span>
                </label>
                <input
                  type="text"
                  name="ticker"
                  value={formData.ticker}
                  onChange={handleChange}
                  className="w-full px-3 py-2 rounded-md border border-input-border min-h-[44px] touch-manipulation"
                  disabled={isSubmitting}
                  placeholder="e.g., BTC, AAPL"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-secondary mb-1">
                  Quantity <span className="text-tertiary text-xs">(optional)</span>
                </label>
                <input
                  type="number"
                  step="0.00000001"
                  name="quantity"
                  value={formData.quantity}
                  onChange={handleChange}
                  className="w-full px-3 py-2 rounded-md border border-input-border min-h-[44px] touch-manipulation"
                  disabled={isSubmitting}
                  placeholder="e.g., 1.5"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-secondary mb-1">
                  Manual Value <span className="text-tertiary text-xs">(optional)</span>
                </label>
                <input
                  type="number"
                  step="0.01"
                  name="manual_value"
                  value={formData.manual_value}
                  onChange={handleChange}
                  className="w-full px-3 py-2 rounded-md border border-input-border min-h-[44px] touch-manipulation"
                  disabled={isSubmitting}
                  placeholder="e.g., 50000.00"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-secondary mb-1">
                  Category <span className="text-tertiary text-xs">(optional)</span>
                </label>
                <input
                  type="text"
                  name="category"
                  value={formData.category}
                  onChange={handleChange}
                  className="w-full px-3 py-2 rounded-md border border-input-border min-h-[44px] touch-manipulation"
                  disabled={isSubmitting}
                  placeholder="e.g., Crypto, Stocks, Property"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-secondary mb-1">
                  Notes <span className="text-tertiary text-xs">(optional)</span>
                </label>
                <textarea
                  name="notes"
                  value={formData.notes}
                  onChange={handleChange}
                  rows="3"
                  className="w-full px-3 py-2 rounded-md border border-input-border"
                  disabled={isSubmitting}
                  placeholder="Additional notes or description"
                />
              </div>

              {errors.submit && (
                <div className="bg-loss-bg text-loss border border-loss/20 rounded-lg p-3">
                  {errors.submit}
                </div>
              )}
            </div>

            <div className="p-5 border-t border-border -mx-5 mt-5 flex flex-col sm:flex-row justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="w-full sm:w-auto px-4 py-2 bg-surface-3 text-secondary hover:bg-surface-3/80 rounded-md disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px] touch-manipulation"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full sm:w-auto px-4 py-2 bg-accent text-inverse hover:bg-accent-hover rounded-md disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px] touch-manipulation"
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
