'use strict';

// The single definition of "a transaction that counts as spend at a merchant".
// Top Merchants (MerchantSpend), the charge list under a tracked expense
// (RecurringExpense.chargesForMerchant) and the expense sync
// (ExpenseSyncService.fetchEligibleCharges) all apply it. They must agree: a
// merchant's total has to equal the charges shown underneath it, and a merchant
// the sync never sees must not appear on Top Merchants either.
//
// Expects `transactions` aliased `t` and `accounts` aliased `a`.
//
// Credit-card payments are excluded because the card's own purchases are
// already counted -- the payment is the same money a second time. Plaid's
// detailed category is the signal that isolates them; the primary category
// (LOAN_PAYMENTS) also covers mortgage and auto-loan payments, which are real
// obligations and must stay. Rows Plaid never enriched have a NULL detailed
// category and fall through; ExpenseSyncService.isCreditCardPayment is the
// name-matching backstop for those.
const SPEND_ELIGIBILITY_SQL = `
  t.amount > 0 AND t.pending = false AND a.is_hidden = FALSE
  AND a.type IN ('depository', 'credit')
  AND UPPER(COALESCE(t.category, '')) NOT LIKE '%TRANSFER%'
  AND COALESCE(t.detailed_category, '') <> 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'
`;

module.exports = { SPEND_ELIGIBILITY_SQL };
