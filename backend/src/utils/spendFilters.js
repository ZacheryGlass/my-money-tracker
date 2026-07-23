'use strict';

// Plaid's detailed category for paying off a credit card. Shared with
// TransactionClassificationService, which maps the same value to the
// 'internal_transfer' direction -- the two mechanisms below must name the same
// category or they will disagree about what counts as spend.
const CREDIT_CARD_PAYMENT_CATEGORY = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT';

// The single definition of "a transaction that counts as spend at a merchant".
// Top Merchants (MerchantSpend), the charge list under a tracked expense
// (RecurringExpense.chargesForMerchant) and the expense sync
// (ExpenseSyncService.fetchEligibleCharges) all apply it, so a merchant's total
// matches the charges shown underneath it.
//
// This governs the Spending pages only. The MCP/analysis layer reaches the same
// conclusion by a different route -- FinancialQueryService sums rows whose
// transaction_classifications.direction is 'spending', and card payments are
// classified 'internal_transfer'. A new spend surface must adopt one mechanism
// or the other.
//
// Expects `transactions` aliased `t` and `accounts` aliased `a`. Parenthesized
// so callers can splice it into any boolean context without precedence
// surprises.
//
// Credit-card payments are excluded because the card's own purchases are
// already counted -- the payment is the same money a second time. The detailed
// category is what isolates them: the primary category (LOAN_PAYMENTS) also
// covers mortgage, student, auto and personal loan payments, which are real
// obligations and must stay. Only the exact card-payment value is excluded, not
// the LOAN_PAYMENTS_* family.
//
// Two known limits, neither observed in practice today:
//   - A row Plaid never enriched has a NULL detailed category and falls
//     through. ExpenseSyncService.isCreditCardPayment catches those, but only
//     when deciding whether to auto-create a tracked expense -- it does NOT
//     guard Top Merchants or the charge list.
//   - The "already counted on the card" premise needs the card's purchases to
//     be in the dataset. A card that is hidden, or at an institution without
//     the transactions product, would lose the payment without the purchases
//     replacing it.
const SPEND_ELIGIBILITY_SQL = `(
  t.amount > 0 AND t.pending = false AND a.is_hidden = FALSE
  AND a.type IN ('depository', 'credit')
  AND UPPER(COALESCE(t.category, '')) NOT LIKE '%TRANSFER%'
  AND UPPER(COALESCE(t.detailed_category, '')) <> '${CREDIT_CARD_PAYMENT_CATEGORY}'
)`;

module.exports = { SPEND_ELIGIBILITY_SQL, CREDIT_CARD_PAYMENT_CATEGORY };
