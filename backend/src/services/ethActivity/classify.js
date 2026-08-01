'use strict';

// The classification ladder (#56/#59): one transaction's legs -> a category
// verdict. Pure -- see legs.js for why this directory stays database-free.

const { counterpartyAddress } = require('./legs');
const {
  ZERO_ADDRESS, NFT_TRANSFER_TYPES, NFT_STANDARDS, REVIEW_REASONS,
} = require('../../utils/ethActivityVocabulary');

const verdict = (category, extra = {}) => ({
  category,
  needs_review: false,
  review_reason: null,
  confidence: 'high',
  ...extra,
});

// The classification ladder. Deterministic rules first, then net flow.
//
// `failed` (the issue's rule 8) is evaluated as a GATE rather than a rung. A
// reverted transaction moved nothing, so running it last would let rule 2 read
// a failed send to Coinbase as a completed exchange deposit and rule 5 read a
// reverted approve as a successful contract call. Every other rule below
// presumes value actually moved. Gas still counts either way -- fee_wei comes
// off the gas leg, which is never is_error.
//
// NOTHING here reads method_id or method_name. They ride along for display.
function classifyActivity({
  wallet, failed, valueLegs, hadValueLegs, netLegs, gasLegs,
  bridgeAddresses = new Set(), serviceAddresses = new Set(),
  custodyAddresses = new Set(),
}) {
  if (failed) return verdict('failed');

  // 1. All value legs between own addresses.
  if (valueLegs.length > 0 && valueLegs.every((leg) => leg.counterparty_is_own)) {
    return verdict('self_transfer');
  }

  // 2. Counterparty labeled exchange. The own test is belt-and-suspenders:
  // reclassifyCounterparties already nulls counterparty_exchange when the
  // counterparty is one of the user's own addresses.
  const exchangeLegs = valueLegs.filter((leg) => !leg.counterparty_is_own && leg.counterparty_exchange);
  if (exchangeLegs.length > 0) {
    // Deposit = value left the wallet for the venue, matching the mirror's
    // outgoing -> CRYPTO_EXCHANGE_DEPOSIT.
    const outbound = exchangeLegs.some((leg) => leg.from_address === wallet);
    return verdict(outbound ? 'exchange_deposit' : 'exchange_withdrawal');
  }

  // EtherDelta's old custody contract is a known external venue, but its
  // internal fills are not standard ERC-20 transfers. Treat visible custody
  // legs as venue movements without claiming that the hidden order-book side
  // was imported; the discovery/coverage surface remains the honest gap.
  const custodyLegs = valueLegs.filter(
    (leg) => !leg.counterparty_is_own && custodyAddresses.has(counterpartyAddress(wallet, leg))
  );
  if (custodyLegs.length > 0) {
    const outbound = custodyLegs.some((leg) => leg.from_address === wallet);
    return verdict(outbound ? 'exchange_deposit' : 'exchange_withdrawal');
  }

  // 3. Counterparty labeled bridge (#59). Money crossing a canonical or
  // third-party bridge is the user's own money changing chains, not spending --
  // but the OTHER half of that movement is a separate transaction on a separate
  // chain, which this pure per-transaction function cannot see. So the rung
  // states only what this transaction shows and flags the row; the cross-chain
  // matching pass (matchBridgeTransfersForUser) clears the flag once it finds
  // the far side, and an unmatched leg stays visible rather than silently
  // asserting a transfer that may never have arrived.
  //
  // PRECEDENCE, and why the rung sits exactly here:
  //   * BELOW rule 1, so 'own' beats 'bridge' exactly as it beats 'exchange'.
  //     A user who has declared an address theirs has overruled every builtin.
  //   * BELOW rule 2, so a labeled exchange keeps the rung it has always had.
  //     A transaction whose counterparties include BOTH an exchange hot wallet
  //     and a bridge contract is not a shape the chain produces, so this order
  //     is a tie-break rather than a policy -- and choosing it this way means
  //     no transaction that classifies today can change verdict.
  //   * ABOVE rules 4-8, which are the ones that would otherwise claim it: a
  //     bridge deposit's on-chain shape is a one-way fungible outflow, i.e.
  //     rule 8's `send`, flagged as possible spending. That is the exact
  //     mistake this issue exists to fix.
  // Label precedence itself (user row shadows builtin) is resolved in SQL
  // before the set ever reaches here -- see _bridgeAddressesForUser.
  const bridgeLegs = valueLegs.filter(
    (leg) => !leg.counterparty_is_own && bridgeAddresses.has(counterpartyAddress(wallet, leg))
  );
  if (bridgeLegs.length > 0) {
    const outbound = bridgeLegs.some((leg) => leg.from_address === wallet);
    return verdict(outbound ? 'bridge_out' : 'bridge_in', {
      needs_review: true,
      review_reason: REVIEW_REASONS.unmatched_bridge,
      // Not 'low': WHO the counterparty is was decided by a label, the same
      // evidence rule 2 acts on with confidence 'high'. What is unresolved is
      // only the far side, which is what the review flag says.
      confidence: 'medium',
    });
  }

  // 3b. Counterparty labeled service (046). Inserted rather than renumbered:
  // rules 1-8 are the issue's own numbering and are cited by name across the
  // services, the tests and CLAUDE.md, so shifting five of them by one would
  // silently rewrite every one of those references.
  //
  // An instant-swap service issues a
  // single-use deposit address per order: value goes in, and what comes back
  // arrives somewhere else entirely -- another chain, another asset, an address
  // named at order time. On THIS chain the movement is one-way and terminal.
  //
  // exchange_trade rather than a direction pair, because the direction is not
  // the interesting fact and the vocabulary has no second value for it: outbound
  // is a disposal, inbound an acquisition, and both are the same event type seen
  // from one side. The row is NOT flagged: unlike a bridge, there is no far side
  // to wait for -- the label already said what the counterparty is, and what was
  // received cannot be learned from this chain no matter how long the row stays
  // in the queue.
  //
  // PRECEDENCE, same reasoning as rule 3:
  //   * BELOW rules 1-3, so no transaction that classifies today changes.
  //   * ABOVE rules 4-8, which is the whole point: without this rung a swap
  //     deposit is rule 8's `send`, flagged as possible spending forever -- and
  //     the alternative label a user reaches for, 'exchange', is worse than
  //     leaving it flagged: it books a disposal as an internal transfer and
  //     deletes it from the record.
  const serviceLegs = valueLegs.filter(
    (leg) => !leg.counterparty_is_own && serviceAddresses.has(counterpartyAddress(wallet, leg))
  );
  if (serviceLegs.length > 0) return verdict('exchange_trade');

  // 4. Zero-address legs. Scoped to NFT legs deliberately: an ERC-20 minted
  // from 0x0 into the wallet is a claim or an airdrop, which is a judgment
  // call, and rule 8 is where judgment calls go. A mint that cost ETH is still
  // a mint (this rule sits above nft_purchase by the issue's numbering, and
  // that is the right answer).
  const nftLegs = valueLegs.filter((leg) => NFT_TRANSFER_TYPES.has(leg.transfer_type));
  if (nftLegs.some((leg) => leg.from_address === ZERO_ADDRESS && leg.to_address === wallet)) {
    return verdict('nft_mint');
  }
  if (nftLegs.some((leg) => leg.to_address === ZERO_ADDRESS && leg.from_address === wallet)) {
    return verdict('nft_burn');
  }

  // 5. Nothing moved on net.
  //
  // The issue splits this into `approval` / `contract_interaction`, but the
  // ONLY thing separating the two is the calldata selector, and method_id /
  // method_name are display-only by standing decision. So every zero-movement
  // call lands as contract_interaction and `approval` is reachable by override
  // alone. Guessing here would be cheap -- nothing moved, so neither label has
  // financial consequences -- but the selector is exactly the attacker-chosen
  // input that must never reach classification, and carving one exception is
  // how that invariant stops being one.
  //
  // Not flagged for review: a zero-value contract call IS explained. Getting
  // here with no gas leg means ignored-token spam (the user already declared it
  // noise -- re-flagging it would rebuild the very queue the ignore list exists
  // to empty), which still has hadValueLegs set.
  //
  // The no_legs arm below is currently UNREACHABLE and kept as a fallback, not
  // as live behaviour: a tx only exists here because it had at least one leg,
  // and the only leg that is neither a gas leg nor a value leg is an errored
  // one -- which the failed gate above already claimed. It stays because the
  // alternative to a flagged row is a confident verdict about a transaction
  // whose legs we cannot see.
  if (netLegs.length === 0) {
    if (gasLegs.length > 0 || hadValueLegs) return verdict('contract_interaction');
    return verdict('contract_interaction', {
      needs_review: true,
      review_reason: REVIEW_REASONS.no_legs,
      confidence: 'low',
    });
  }

  const fungible = netLegs.filter((leg) => !NFT_STANDARDS.has(leg.token_standard));
  const nfts = netLegs.filter((leg) => NFT_STANDARDS.has(leg.token_standard));
  const fungibleOut = fungible.some((leg) => leg.direction === 'out');
  const fungibleIn = fungible.some((leg) => leg.direction === 'in');

  // 6. Fungible out + a different fungible in. Netting is per asset, so an out
  // entry and an in entry existing at all means two different assets.
  if (fungibleOut && fungibleIn) return verdict('swap');

  // 7. NFT against fungible.
  if (nfts.some((leg) => leg.direction === 'in') && fungibleOut) return verdict('nft_purchase');
  if (nfts.some((leg) => leg.direction === 'out') && fungibleIn) return verdict('nft_sale');

  // 8. One-way, unlabeled counterparty. NEVER auto-classified as spending:
  // whether an outbound transfer is a purchase, a gift, or a move to an
  // untracked address of your own is not knowable from the chain, and guessing
  // wrong writes a number into the user's spending totals.
  if (netLegs.every((leg) => leg.direction === 'out')) {
    return verdict('send', {
      needs_review: true,
      review_reason: REVIEW_REASONS.unlabeled_send,
      confidence: 'low',
    });
  }
  if (netLegs.every((leg) => leg.direction === 'in')) {
    return verdict('receive', {
      needs_review: true,
      review_reason: REVIEW_REASONS.unlabeled_receive,
      confidence: 'low',
    });
  }

  // Both directions but no recognized shape -- an NFT-for-NFT trade, say.
  // Flagged rather than forced into the nearest category: an unexplained
  // transaction the user can see is the whole product.
  return verdict('contract_interaction', {
    needs_review: true,
    review_reason: REVIEW_REASONS.unmatched,
    confidence: 'low',
  });
}

module.exports = {
  classifyActivity,
};
