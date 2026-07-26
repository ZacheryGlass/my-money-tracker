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
];

// undefined omits `kind` from the request body entirely; any other verdict is
// posted verbatim and the API validates it.
export const labelVerdictKind = (verdict) => (verdict === LABEL_VERDICT_KEEP ? undefined : verdict);

// Mirrors the API rule: an exchange NAME is the text that appears in the ledger
// AND the assertion that turns spending into a transfer, so it must be typed.
// External/own names never reach classification and fall back to a short
// address. KEEP is held to the exchange bar because that is what a fresh row
// becomes.
export const labelVerdictNeedsName = (verdict) => verdict !== 'external' && verdict !== 'own';

// The unified crypto ledger's category vocabulary (#63). MUST stay in step with
// backend CryptoLedger.CATEGORIES -- the activity layer's own list plus the two
// values only an exchange record produces. The server answers an unknown
// ?category= with a 400, so a value offered here that the server does not know
// is a dead filter rather than a wider feed.
//
// Ordered as the ladder reads, not alphabetically: the deterministic verdicts
// first, the judgement calls last, so the picker on a flagged row puts the
// likely answers where the eye lands.
export const LEDGER_CATEGORIES = [
  ['self_transfer', 'Self transfer'],
  ['exchange_deposit', 'Exchange deposit'],
  ['exchange_withdrawal', 'Exchange withdrawal'],
  ['exchange_trade', 'Exchange trade'],
  ['exchange_transfer', 'Exchange transfer'],
  ['staking_reward', 'Staking reward'],
  ['swap', 'Swap'],
  ['bridge_out', 'Bridge out'],
  ['bridge_in', 'Bridge in'],
  ['nft_purchase', 'NFT purchase'],
  ['nft_sale', 'NFT sale'],
  ['nft_mint', 'NFT mint'],
  ['nft_burn', 'NFT burn'],
  ['airdrop', 'Airdrop'],
  ['send', 'Send'],
  ['receive', 'Receive'],
  ['spend', 'Spend'],
  ['approval', 'Approval'],
  ['contract_interaction', 'Contract call'],
  ['fee', 'Fee'],
  ['failed', 'Failed'],
];

const LEDGER_CATEGORY_LABELS = new Map(LEDGER_CATEGORIES);

// Only 'fee' and 'exchange_transfer' are missing from eth_activity's CHECK
// constraint, so they are the two an on-chain override cannot be set to. The
// filter offers both (an exchange row really does land there); the override
// picker subtracts them, or the user could save a category the server rejects.
export const ONCHAIN_OVERRIDE_CATEGORIES = LEDGER_CATEGORIES.filter(
  ([value]) => value !== 'fee' && value !== 'exchange_transfer'
);

export function formatLedgerCategory(category) {
  if (!category) return UNCATEGORIZED_LABEL;
  return LEDGER_CATEGORY_LABELS.get(category) || formatTransactionCategory(category);
}

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
