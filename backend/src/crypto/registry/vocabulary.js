'use strict';

// The crypto vocabulary registry: category, review-reason, spam-reason,
// USD-basis, label-kind and filter constants that migrations (038/043/045
// CHECKs), routes, the ledger's filter lists and (through GET /api/crypto/meta)
// the frontend all agree on. utils/ethActivityVocabulary.js re-exports this.
//
// Adding a category or a label kind: one entry here, its rule, and one
// CHECK-widening migration listing the full union. Shared rather than re-declared per module
// because two copies of a CHECK-mirrored list WILL drift, and because reading
// one constant must not require loading a 1,400-line service (models/CryptoLedger
// once required all of EthActivityService for CATEGORIES alone).
//
// Dependency-free on purpose -- anything here is importable from a model, a
// route, a service or a test without pulling in the database or the logger.
//
// NFT_TRANSFER_TYPES has the same members as assetPriceKey's
// UNPRICEABLE_TRANSFER_TYPES but a different meaning ("this leg is an NFT" vs
// "this leg's value_wei carries no priceable value"). They are deliberately not
// merged: the sets coincide today because NFT value_wei is a unit count (033),
// but each list follows its own rule if that ever diverges.

// The full category vocabulary (038's CHECK constraint carries the same list).
// A superset by design: later issues fill in exchange_trade and staking_reward.
// bridge_out/bridge_in are now REACHABLE from the ladder -- #59 added the rung
// that classifies them. 'spend' and 'approval' remain reachable only through an
// override -- see classifyActivity.
//
// #61 (exchange matching) deliberately added NONE of them: pairing an on-chain
// transfer with the exchange's own record says the two rows are the same money,
// not that the transaction was something other than the deposit or withdrawal
// the ladder already called it.
const CATEGORIES = [
  'self_transfer', 'exchange_deposit', 'exchange_withdrawal', 'exchange_trade',
  'staking_reward', 'swap', 'nft_purchase', 'nft_sale', 'nft_mint', 'nft_burn',
  'airdrop', 'send', 'receive', 'spend', 'approval', 'contract_interaction',
  'bridge_out', 'bridge_in', 'failed',
];

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const NFT_TRANSFER_TYPES = new Set(['nft', 'nft1155']);
const NFT_STANDARDS = new Set(['erc721', 'erc1155']);

// review_reason is VARCHAR(200); these are the only values written.
const REVIEW_REASONS = {
  unlabeled_send: 'Counterparty has no verdict: spending, a gift, or a transfer?',
  unlabeled_receive: 'Counterparty has no verdict: income, a refund, or a transfer?',
  unmatched: 'Inbound and outbound legs did not match a known shape',
  no_legs: 'No transfer legs found for this transaction',
  unmatched_bridge: 'Bridge transfer with no matching leg on the other chain yet',
  excluded_bridge: 'Bridge counterparty is Base (8453), which is excluded from this history',
};

// The spam quarantine's reason codes (#74). spam_reason is VARCHAR(32) and 045's
// CHECK carries the same list.
//
// CODES, not sentences -- deliberately unlike REVIEW_REASONS, whose finished
// prose is what lands in the column. The poisoning verdict has to render with a
// security warning the others must not carry, and a client cannot branch on
// prose. The display text lives with the other label maps on the front end.
const SPAM_REASONS = {
  // A lookalike counterparty: same first and last four hex characters as an
  // address this wallet actually uses, which is the entire mechanism of the
  // attack -- the payoff is a future copy-paste out of transaction history.
  ADDRESS_POISONING: 'address_poisoning',
  // Nothing moved, and the wallet did not ask for it.
  ZERO_VALUE_TRANSFER: 'zero_value_transfer',
  // An unpriced token the wallet has never voluntarily touched, arriving
  // unbidden.
  UNSOLICITED_TOKEN: 'unsolicited_token',
  // Same profile, NFT feeds. Endemic since 033, and free to send on an L2.
  UNSOLICITED_NFT: 'unsolicited_nft',
};

// Below this, an inbound transfer is dust: too small to be the payment anybody
// meant to make. Matches EthTransfer.DEFAULT_MIN_USD, the triage queue's own
// materiality floor -- two thresholds for "not worth a human's attention" that
// disagreed would put rows in the queue that the ledger had already hidden.
const SPAM_DUST_USD = 1;

// Categories a quarantine may NEVER claim, whatever the evidence looks like.
//
// Every one of them is a statement that real money moved in a direction the
// heuristics are not allowed to second-guess: the wallet signed it, or a
// counterparty the user gave a verdict to is on the other end. The gates in
// detectSpam already exclude all of these; this is the belt-and-suspenders
// layer, because the cost of one wrong quarantine here is a payment that
// vanishes from the default ledger.
//
// bridge_out/bridge_in (#59) sit here for the same reason 'exchange_deposit'
// does, and the union makes it load-bearing rather than forward-looking: a
// bridge label IS a verdict on the counterparty, so a bridge row must never be
// spam-scanned as an unknown sender. Gate 1 stops it before any heuristic runs,
// which is also why detectSpam's `reviewed` test does not need a bridge arm.
const NEVER_SPAM_CATEGORIES = new Set([
  'failed', 'self_transfer', 'exchange_deposit', 'exchange_withdrawal',
  'exchange_trade', 'swap', 'nft_purchase', 'nft_sale', 'nft_burn',
  'bridge_out', 'bridge_in', 'spend',
]);

// The at-the-time USD basis vocabulary (043's CHECK carries the same list),
// weakest last. Folding a set of legs takes the WEAKEST basis among them: one
// unpriced leg makes the total unpriced, because a partial sum presented as a
// total is the silent-zero failure wearing a different hat.
const USD_BASIS_RANK = { exact: 0, carried: 1, unpriced: 2, not_applicable: 3 };

// Display labels, in the order the ledger's pickers list them (deterministic
// verdicts first, judgement calls last). 'fee' and 'exchange_transfer' only an
// exchange record produces; eth_activity's CHECK does not admit them, which is
// why an on-chain override cannot be set to either (`exchangeOnly`).
const LEDGER_CATEGORY_DEFINITIONS = [
  { value: 'self_transfer', label: 'Self transfer' },
  { value: 'exchange_deposit', label: 'Exchange deposit' },
  { value: 'exchange_withdrawal', label: 'Exchange withdrawal' },
  { value: 'exchange_trade', label: 'Exchange trade' },
  { value: 'exchange_transfer', label: 'Exchange transfer', exchangeOnly: true },
  { value: 'staking_reward', label: 'Staking reward' },
  { value: 'swap', label: 'Swap' },
  { value: 'bridge_out', label: 'Bridge out' },
  { value: 'bridge_in', label: 'Bridge in' },
  { value: 'nft_purchase', label: 'NFT purchase' },
  { value: 'nft_sale', label: 'NFT sale' },
  { value: 'nft_mint', label: 'NFT mint' },
  { value: 'nft_burn', label: 'NFT burn' },
  { value: 'airdrop', label: 'Airdrop' },
  { value: 'send', label: 'Send' },
  { value: 'receive', label: 'Receive' },
  { value: 'spend', label: 'Spend' },
  { value: 'approval', label: 'Approval' },
  { value: 'contract_interaction', label: 'Contract call' },
  { value: 'fee', label: 'Fee', exchangeOnly: true },
  { value: 'failed', label: 'Failed' },
];
const EXCHANGE_ONLY_CATEGORIES = ['fee', 'exchange_transfer'];

// Counterparty label verdicts (eth_address_labels.kind, 032/044/046 CHECKs).
// `nameOptional`: the name never reaches classification, so a short address
// will do; an 'exchange' name becomes counterparty_exchange and must be typed.
const LABEL_KIND_DEFINITIONS = [
  { value: 'exchange', label: 'Exchange', nameOptional: false },
  { value: 'external', label: 'External (third party)', nameOptional: true },
  { value: 'own', label: 'My own address', nameOptional: true },
  // A cross-chain bridge contract: money sent here is the user's own money
  // changing chains, not spending.
  { value: 'bridge', label: 'Bridge (cross-chain)', nameOptional: true },
  // An instant-swap service's deposit address (Changelly, ShapeShift and the
  // like): money sent there was SOLD, and what came back is not on this chain.
  { value: 'service', label: 'Swap service', nameOptional: true },
];
const LABEL_KINDS = LABEL_KIND_DEFINITIONS.map((entry) => entry.value);
const NAME_OPTIONAL_LABEL_KINDS = LABEL_KIND_DEFINITIONS
  .filter((entry) => entry.nameOptional).map((entry) => entry.value);

// How a feed treats quarantined spam (#74): the default hides it.
const SPAM_FILTERS = ['exclude', 'only', 'all'];

// The stored verdicts of the balance audit (042).
const RECONCILIATION_STATUSES = ['match', 'dust', 'mismatch', 'skipped', 'unavailable'];

// A user's verdict on a proposed exchange or bridge pairing.
const MATCH_VERDICTS = ['confirmed', 'rejected'];

module.exports = {
  CATEGORIES,
  LEDGER_CATEGORY_DEFINITIONS,
  EXCHANGE_ONLY_CATEGORIES,
  LABEL_KIND_DEFINITIONS,
  LABEL_KINDS,
  NAME_OPTIONAL_LABEL_KINDS,
  SPAM_FILTERS,
  RECONCILIATION_STATUSES,
  MATCH_VERDICTS,
  ZERO_ADDRESS,
  NFT_TRANSFER_TYPES,
  NFT_STANDARDS,
  REVIEW_REASONS,
  SPAM_REASONS,
  SPAM_DUST_USD,
  NEVER_SPAM_CATEGORIES,
  USD_BASIS_RANK,
};
