import React, { useState, useEffect, useMemo } from 'react';
import { buildAccountDisplayNameMap, getAccountDisplayName } from '../utils/accountDisplay';

const HoldingForm = ({ isOpen, onClose, onSave, onDelete, holding, accounts, title }) => {
  const [formData, setFormData] = useState({
    account_id: '',
    ticker: '',
    name: '',
    quantity: '',
    manual_value: '',
    category: '',
    notes: '',
    location: '',
  });
  const [errors, setErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const accountDisplayNames = useMemo(() => buildAccountDisplayNameMap(accounts), [accounts]);

  useEffect(() => {
    if (holding) {
      setFormData({
        account_id: holding.account_id || '',
        ticker: holding.ticker || '',
        name: holding.name || '',
        quantity: holding.quantity ?? '',
        manual_value: holding.manual_value ?? '',
        category: holding.category || '',
        notes: holding.notes || '',
        location: holding.location || '',
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
        location: '',
      });
    }
    setErrors({});
  }, [holding, isOpen]);

  const validate = () => {
    const newErrors = {};
    if (!formData.account_id) newErrors.account_id = 'Account is required';
    if (!formData.name || formData.name.trim() === '') newErrors.name = 'Name is required';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (holding?.is_plaid_managed) return;
    if (!validate()) return;

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
        location: formData.location ? formData.location.trim() : null,
      };
      await onSave(dataToSubmit);
      onClose();
    } catch (error) {
      console.error('Error saving holding:', error);
      setErrors({ submit: error.response?.data?.error || 'Failed to save holding' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (errors[name]) setErrors((prev) => ({ ...prev, [name]: '' }));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-surface-2 border border-border shadow-float w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-display-sm text-primary">
            {holding ? 'Edit Holding' : (title || 'Add New Holding')}
          </h2>
          {holding?.is_plaid_managed && (
            <div className="mt-2 px-2 py-1.5 bg-accent-muted border border-accent/20 text-caption text-accent">
              This holding is managed by Plaid and cannot be edited manually.
            </div>
          )}
        </div>

        <div className="p-4">
          <form onSubmit={handleSubmit}>
            <fieldset disabled={holding?.is_plaid_managed}>
              <div className="space-y-3">
                <div>
                  <label className="block text-body-sm font-semibold text-secondary mb-1">
                    Account <span className="text-loss">*</span>
                  </label>
                  <select
                    name="account_id"
                    value={formData.account_id}
                    onChange={handleChange}
                    className={`w-full px-2 py-1.5 border ${errors.account_id ? 'border-loss' : 'border-input-border'}`}
                    disabled={isSubmitting}
                  >
                    <option value="">Select an account</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {accountDisplayNames.get(account.id) || getAccountDisplayName(account)}
                      </option>
                    ))}
                  </select>
                  {errors.account_id && <p className="text-caption text-loss mt-0.5">{errors.account_id}</p>}
                </div>

                <div>
                  <label className="block text-body-sm font-semibold text-secondary mb-1">
                    Name <span className="text-loss">*</span>
                  </label>
                  <input
                    type="text"
                    name="name"
                    value={formData.name}
                    onChange={handleChange}
                    className={`w-full px-2 py-1.5 border ${errors.name ? 'border-loss' : 'border-input-border'}`}
                    disabled={isSubmitting}
                    placeholder="e.g., Bitcoin, Real Estate Property"
                  />
                  {errors.name && <p className="text-caption text-loss mt-0.5">{errors.name}</p>}
                </div>

                <div>
                  <label className="block text-body-sm font-semibold text-secondary mb-1">
                    Ticker <span className="text-caption text-tertiary">(optional)</span>
                  </label>
                  <input
                    type="text"
                    name="ticker"
                    value={formData.ticker}
                    onChange={handleChange}
                    className="w-full px-2 py-1.5 border border-input-border"
                    disabled={isSubmitting}
                    placeholder="e.g., BTC, AAPL"
                  />
                </div>

                <div>
                  <label className="block text-body-sm font-semibold text-secondary mb-1">
                    Quantity <span className="text-caption text-tertiary">(optional)</span>
                  </label>
                  <input
                    type="number"
                    step="0.00000001"
                    name="quantity"
                    value={formData.quantity}
                    onChange={handleChange}
                    className="w-full px-2 py-1.5 border border-input-border"
                    disabled={isSubmitting}
                    placeholder="e.g., 1.5"
                  />
                </div>

                <div>
                  <label className="block text-body-sm font-semibold text-secondary mb-1">
                    Manual Value <span className="text-caption text-tertiary">(optional)</span>
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    name="manual_value"
                    value={formData.manual_value}
                    onChange={handleChange}
                    className="w-full px-2 py-1.5 border border-input-border"
                    disabled={isSubmitting}
                    placeholder="e.g., 50000.00"
                  />
                </div>

                <div>
                  <label className="block text-body-sm font-semibold text-secondary mb-1">
                    Category <span className="text-caption text-tertiary">(optional)</span>
                  </label>
                  <input
                    type="text"
                    name="category"
                    value={formData.category}
                    onChange={handleChange}
                    className="w-full px-2 py-1.5 border border-input-border"
                    disabled={isSubmitting}
                    placeholder="e.g., Crypto, Stocks, Property"
                  />
                </div>

                <div>
                  <label className="block text-body-sm font-semibold text-secondary mb-1">
                    Location <span className="text-caption text-tertiary">(optional)</span>
                  </label>
                  <input
                    type="text"
                    name="location"
                    value={formData.location}
                    onChange={handleChange}
                    className="w-full px-2 py-1.5 border border-input-border"
                    disabled={isSubmitting}
                    placeholder="e.g., Coinbase, Schwab, Binance US"
                  />
                </div>

                <div>
                  <label className="block text-body-sm font-semibold text-secondary mb-1">
                    Notes <span className="text-caption text-tertiary">(optional)</span>
                  </label>
                  <textarea
                    name="notes"
                    value={formData.notes}
                    onChange={handleChange}
                    rows="2"
                    className="w-full px-2 py-1.5 border border-input-border"
                    disabled={isSubmitting}
                    placeholder="Additional notes"
                  />
                </div>

                {errors.submit && (
                  <div className="bg-loss-bg text-loss border border-loss/20 p-2 text-body-sm">
                    {errors.submit}
                  </div>
                )}
              </div>
            </fieldset>

            <div className="pt-4 mt-4 border-t border-border flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              {holding && !holding.is_plaid_managed && onDelete && (
                <button
                  type="button"
                  onClick={() => onDelete(holding.id)}
                  disabled={isSubmitting}
                  className="px-3 py-1.5 text-loss hover:bg-loss-bg rounded text-button disabled:opacity-50 sm:mr-auto"
                >
                  Delete
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 bg-surface-3 text-secondary hover:text-primary rounded text-button sm:ml-auto"
              >
                {holding?.is_plaid_managed ? 'Close' : 'Cancel'}
              </button>
              {!holding?.is_plaid_managed && (
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-3 py-1.5 bg-accent text-white hover:bg-accent-hover rounded text-button font-semibold disabled:opacity-50"
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

export default HoldingForm;
