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

// Why a transaction was quarantined as spam (#74). The server stores a REASON
// CODE rather than prose precisely so this map can exist: the poisoning verdict
// carries a security warning the other three must not, and a client cannot
// branch on a sentence.
//
// A missing code is rendered as the generic line rather than swallowed -- a row
// hidden for reasons nobody can state is the failure a quarantine cannot have.
export const SPAM_REASON_LABELS = {
  address_poisoning: {
    title: 'Lookalike address',
    detail: 'The sender\'s address copies the first and last four characters of one you actually use. '
      + 'Never copy an address out of transaction history — always paste it from the source.',
    warn: true,
  },
  zero_value_transfer: {
    title: 'Zero-value transfer',
    detail: 'Nothing moved, and your wallet did not send it. This is how a poisoned address gets into your history.',
  },
  unsolicited_token: {
    title: 'Unsolicited token',
    detail: 'A token you have never traded or approved, arriving unasked, that no price provider lists.',
  },
  unsolicited_nft: {
    title: 'Unsolicited NFT',
    detail: 'An NFT from a collection you have never bought from or interacted with, sent to you unasked.',
  },
};

export const spamReasonLabel = (code) => SPAM_REASON_LABELS[code] || {
  title: 'Marked as spam',
  detail: 'Hidden from the ledger. Nothing was deleted.',
};

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
