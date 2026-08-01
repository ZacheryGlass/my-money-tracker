const isZeroDecimal = (value) => value != null && /^[-+]?0*(?:\.0*)?$/.test(String(value).trim());

// Explain the arithmetic without implying that an allowance was consumed.
// In particular, `0 <= 0.15` made an exact 30 ETH match look as though 0.15
// ETH had been forgiven. v3 names identity evidence and documented fees
// separately, and requires a zero residual for any non-hash suggestion.
export function describeExchangeMatchEvidence(match) {
  if (!match) return '';
  if (match.match_method === 'manual') return 'Previously confirmed by you';

  const hasAmounts = match.comparison_left_amount != null && match.comparison_right_amount != null;
  const fee = match.fee_amount_applied ?? '0';
  const hasFee = !isZeroDecimal(fee);
  const residual = match.amount_delta;
  const exact = isZeroDecimal(residual);

  if (match.match_method === 'tx_hash') {
    if (!hasAmounts || residual == null) return 'Same transaction hash';
    if (exact) {
      return hasFee
        ? `Same transaction hash · fee-adjusted amounts agree · documented fee ${fee}`
        : 'Same transaction hash · exact amount match';
    }
    return `Same transaction hash · amount difference ${residual}`
      + (hasFee ? ` after documented fee ${fee}` : '')
      + ' · warning only';
  }

  if (exact) {
    return hasFee
      ? `Fee-adjusted exact match · documented fee ${fee}`
      : 'Exact amount match';
  }

  return `Unexplained difference ${residual ?? '—'}`
    + (!isZeroDecimal(match.amount_tolerance) ? ` · prior rule tolerance ${match.amount_tolerance}` : '')
    + (hasFee ? ` · documented fee ${fee}` : '');
}

export function describeExchangeSuggestionReason(match) {
  if (match?.suggestion_reason === 'ambiguous') return 'Ambiguous — review every alternative';
  if (match?.match_method === 'address_amount') return 'Address and amount corroborated — confirmation required';
  return 'Amount and narrow settlement window only — confirmation required';
}

export { isZeroDecimal };
