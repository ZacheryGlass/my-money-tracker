export const UNCATEGORIZED_LABEL = 'Uncategorized';

// Counterparty label verdicts, shared by the two places a label is written by
// hand: the Crypto page's inline Label button and Settings' label form.
//
// KEEP is a UI-only sentinel, not a kind. It posts NO kind field, which the API
// reads as "leave the existing verdict alone" -- the only way to rename a label
// without re-voting on it, and the reason renaming an address marked as yours
// cannot silently turn it into an exchange. On a brand-new address it still
// lands as 'exchange', the server-side insert default.
//
// Offering the choice at all is what makes a builtin correctable: thousands of
// counterparties arrive pre-labeled from the scraped pack (migration 036), and
// a wrong 'exchange' among them rewrites real spending as an internal transfer.
// A user row for the same address shadows the builtin, so picking External or
// My own address here is the fix -- and it heals existing history, because the
// write triggers a full reclassification.
export const LABEL_VERDICT_KEEP = 'keep';

export const LABEL_VERDICT_OPTIONS = [
  { value: LABEL_VERDICT_KEEP, label: 'Keep current verdict' },
  { value: 'exchange', label: 'Exchange' },
  { value: 'external', label: 'External (third party)' },
  { value: 'own', label: 'My own address' },
  // A cross-chain bridge contract: money sent here is the user's own money
  // changing chains, not spending. Seeded for the canonical bridges of the
  // chains this app syncs, but offered by hand because bridges redeploy far
  // faster than a seed can follow.
  { value: 'bridge', label: 'Bridge (cross-chain)' },
];

// undefined omits `kind` from the request body entirely; any other verdict is
// posted verbatim and the API validates it.
export const labelVerdictKind = (verdict) => (verdict === LABEL_VERDICT_KEEP ? undefined : verdict);

// Mirrors the API rule: an exchange NAME is the text that appears in the ledger
// AND the assertion that turns spending into a transfer, so it must be typed.
// External/own/bridge names never reach classification and fall back to a short
// address. KEEP is held to the exchange bar because that is what a fresh row
// becomes.
const NAME_OPTIONAL_VERDICTS = new Set(['external', 'own', 'bridge']);
export const labelVerdictNeedsName = (verdict) => !NAME_OPTIONAL_VERDICTS.has(verdict);

export function formatCategoryLabel(category, fallback = UNCATEGORIZED_LABEL) {
  const label = typeof category === 'string' ? category.trim() : '';
  return label || fallback;
}

// Title-case a raw transaction category ("FOOD_AND_DRINK" -> "Food And Drink").
export function formatTransactionCategory(category, fallback = UNCATEGORIZED_LABEL) {
  if (!category) return fallback;
  return category
    .toLowerCase()
    .split(/[_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
