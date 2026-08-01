import { describeExchangeMatchEvidence, describeExchangeSuggestionReason } from './exchangeMatchEvidence';

describe('exchange match evidence', () => {
  it('calls a zero residual exact instead of displaying a tolerance comparison', () => {
    expect(describeExchangeMatchEvidence({
      match_method: 'address_amount',
      comparison_left_amount: '30',
      comparison_right_amount: '30',
      amount_delta: '0.000000000000000000',
      amount_tolerance: '0',
      fee_amount_applied: '0',
    })).toBe('Exact amount match');
  });

  it('names an exact full-fee adjustment without implying an allowance', () => {
    expect(describeExchangeMatchEvidence({
      match_method: 'address_amount',
      comparison_left_amount: '2',
      comparison_right_amount: '1.995',
      amount_delta: '0',
      amount_tolerance: '0.00000001',
      fee_amount_applied: '0.005',
    })).toBe('Fee-adjusted exact match · documented fee 0.005');
  });

  it('keeps a hash match while naming an amount discrepancy as a warning', () => {
    expect(describeExchangeMatchEvidence({
      match_method: 'tx_hash',
      comparison_left_amount: '2',
      comparison_right_amount: '1.9',
      amount_delta: '0.1',
      fee_amount_applied: '0',
    })).toMatch(/Same transaction hash .* amount difference 0.1 .* warning only/);
  });

  it('states that non-identity evidence requires confirmation', () => {
    expect(describeExchangeSuggestionReason({ match_method: 'address_amount' }))
      .toMatch(/confirmation required/);
    expect(describeExchangeSuggestionReason({ match_method: 'amount_window' }))
      .toMatch(/confirmation required/);
    expect(describeExchangeSuggestionReason({ suggestion_reason: 'ambiguous' }))
      .toMatch(/Ambiguous/);
  });
});
