'use strict';

// --- the spam quarantine (#74) ---------------------------------------------
//
// Everything below decides ONE bit -- whether a transaction is noise the user
// should never have to give a verdict on -- and it decides it as a FLAG BESIDE
// the ladder's verdict, never in place of it. The row keeps its category, its
// netted legs and its at-the-time dollars; the quarantine only removes it from
// the default feed and from the triage queue. That is what makes un-quarantine
// lossless, and it is why nothing here can hide money: the money is still on
// the row, and eth_transfers -- which the balance audit derives from -- is not
// touched at all.
//
// NOTHING here reads method_id or method_name either. Selector collisions are
// mined deliberately, so a quarantine that read calldata would let an attacker
// choose whether their own transfer was hidden.

const { DEFAULT_CHAIN_ID } = require('../../config/chains');
const { tokenAssetKey } = require('../../utils/assetPriceKey');
const { toBigIntLenient, absBigInt } = require('../../utils/units');
const {
  NFT_TRANSFER_TYPES, SPAM_REASONS, SPAM_DUST_USD, NEVER_SPAM_CATEGORIES,
} = require('../../utils/ethActivityVocabulary');
const { counterpartyAddress } = require('./legs');

// Base units of a leg as a BigInt magnitude. NFT legs carry a COUNT OF UNITS
// (033) rather than wei, which is fine: every caller below only asks whether it
// is zero.
const legUnits = (leg) => {
  const raw = toBigIntLenient(leg.value_wei);
  return absBigInt(raw);
};

// Leg types whose `from_address` is a fact about the TRANSACTION rather than a
// claim made by a contract.
//
// `native` and `internal` come from txlist / txlistinternal, where the sender is
// the transaction's actual signer or the trace's actual caller. A `token` or
// `nft` leg's `from` is copied verbatim out of a Transfer EVENT (see
// EthWalletService.normalizeFeeds), and any contract may emit one naming any
// address and any amount. That is not a corner case: the fake-token poisoning
// variant deploys a counterfeit USDT and emits Transfer(victim, lookalike,
// 1000e6) purely so the victim's history shows a plausible payment to an
// address the attacker controls. Nothing about the wallet may be inferred from
// a leg the attacker wrote.
const SIGNED_LEG_TYPES = new Set(['native', 'internal']);

// Did the wallet's owner sign this transaction?
//
// A gas leg exists exactly once per tx the wallet SENT (EthWalletService
// synthesizes it from txlist), so its presence IS the signature. The
// value-leg fallback covers a chain whose `normal` feed was skipped or is
// unsupported (039) while the token feed landed -- without it, a partial sync
// could read the user's own outgoing transfer as an unsolicited arrival.
//
// The fallback insists on a nonzero outbound leg OF A SIGNED TYPE, and both
// halves are load-bearing:
//   * nonzero, because the commonest poisoning variant is a spoofed ZERO-value
//     Transfer with `from` set to the victim -- transferFrom(victim, lookalike,
//     0) needs no allowance in most ERC-20s -- which appears in the victim's
//     feed as an outbound leg they never signed;
//   * a signed type, because the same forgery works just as well with a nonzero
//     amount on a counterfeit token. Accepting it would let an attacker switch
//     off every heuristic below for a transaction of their choosing, simply by
//     writing the victim's address into their own event log.
function walletInitiated(wallet, gasLegs, valueLegs) {
  if (gasLegs.length > 0) return true;
  return valueLegs.some((leg) => SIGNED_LEG_TYPES.has(leg.transfer_type)
    && leg.from_address === wallet && legUnits(leg) > 0n);
}

// Wallet-wide evidence, computed once over every stored transfer, exactly like
// tokenDecimalsFallbacks: the questions are about the wallet's whole history
// ("has this token ever been touched on purpose?"), so a per-transaction view
// would answer them differently depending on which transaction was asked.
function spamContext(wallet, transfers, ownAddresses = [], unlistedAssets = new Set()) {
  const initiatedTxs = new Set();
  const byTx = new Map();
  for (const transfer of transfers) {
    const groupKey = `${transfer.chain_id ?? DEFAULT_CHAIN_ID}:${transfer.tx_hash}`;
    const legs = byTx.get(groupKey);
    if (legs) legs.push(transfer);
    else byTx.set(groupKey, [transfer]);
    if (transfer.transfer_type === 'gas' && transfer.from_address === wallet) {
      initiatedTxs.add(groupKey);
    }
  }

  // Contracts the wallet has interacted with VOLUNTARILY -- the issue's "no
  // outbound, no approval, no purchase leg" test. Every contract touched by a
  // transaction the wallet SIGNED: a swap, a purchase, a claim and an approve
  // (whose only trace is the gas leg's destination) all land here, and an
  // outbound ERC-20 transfer does too, because sending a token requires signing
  // for it.
  //
  // A signature is the whole membership test, and there is deliberately no
  // "the wallet appears as the sender" shortcut beside it: `from_address` on a
  // token leg is attacker-written (SIGNED_LEG_TYPES), so a counterfeit contract
  // could otherwise whitelist ITSELF, permanently, by emitting one forged
  // Transfer -- and every later airdrop of that counterfeit would then read as
  // an asset the user chose to hold.
  //
  // Address-keyed rather than (chain, contract)-keyed on purpose: the same
  // deployment on two chains is one decision by the user, and the conservative
  // direction for this set is WIDER -- a contract wrongly considered familiar
  // costs a quarantine that does not happen.
  const voluntaryContracts = new Set();
  // Addresses a lookalike would be imitating: the wallet itself, the owner's
  // other addresses, and every address the wallet has deliberately paid.
  // "Deliberately" is the same nonzero-and-signed test as above -- a poisoned
  // lookalike must never be able to join the set that shields the next one.
  //
  // The owner's OTHER addresses are passed in rather than inferred from
  // counterparty_is_own alone: that flag only appears on transfers between two
  // of them, so a user with two wallets that have never transacted would be
  // blind to a lookalike of their second address on their first -- and an own
  // address is the single most valuable thing for a poisoner to imitate. There
  // is no false-positive cost either: an address the user declared theirs is
  // unambiguous.
  const familiarAddresses = new Set([wallet, ...ownAddresses.filter(Boolean)]);

  for (const [groupKey, legs] of byTx) {
    const initiated = initiatedTxs.has(groupKey);
    for (const leg of legs) {
      if (leg.counterparty_is_own) {
        const own = counterpartyAddress(wallet, leg);
        if (own) familiarAddresses.add(own);
      }
      if (leg.transfer_type === 'gas') {
        // The contract the wallet called. An approve leaves no other trace.
        if (leg.to_address) voluntaryContracts.add(leg.to_address);
        continue;
      }
      if (leg.is_error) continue;
      if (leg.token_contract && initiated) voluntaryContracts.add(leg.token_contract);
      // An address the wallet has deliberately paid. Gated on the signature for
      // the same reason as the set above: an unsigned "outbound" leg is a
      // forged one, and a poisoned lookalike must never be able to join the set
      // that shields the next one from the lookalike test.
      const outbound = leg.from_address === wallet && legUnits(leg) > 0n;
      if (initiated && outbound && leg.to_address) familiarAddresses.add(leg.to_address);
    }
  }

  // Indexed by the abbreviation, not scanned. A busy wallet is tens of
  // thousands of transactions against hundreds of familiar addresses, and the
  // lookalike test runs per counterparty per transaction; a linear scan turns
  // an O(n) rebuild into an O(n*m) one for no reason.
  const familiarByAbbreviation = new Map();
  for (const address of familiarAddresses) {
    const abbreviation = abbreviate(address);
    if (abbreviation && !familiarByAbbreviation.has(abbreviation)) {
      familiarByAbbreviation.set(abbreviation, address);
    }
  }

  return { voluntaryContracts, familiarAddresses, familiarByAbbreviation, unlistedAssets };
}

// How an address is shown everywhere -- here, in every explorer, in every
// wallet UI -- and therefore what a human actually compares before pasting:
// the first and last four hex characters. That abbreviation IS the attack
// surface, so it is what the lookalike test keys on.
function abbreviate(address) {
  if (!address || address.length !== 42) return null;
  return `${address.slice(0, 6)}|${address.slice(-4)}`;
}

// Does `address` imitate one of the wallet's own or frequently-paid addresses?
// An exact match is not a lookalike; it IS the address, and it is already
// familiar. Returns the imitated address so a warning can name it.
function lookalikeTarget(address, context) {
  const abbreviation = abbreviate(address);
  if (!abbreviation) return null;
  if (context.familiarAddresses.has(address)) return null;
  return context.familiarByAbbreviation.get(abbreviation) || null;
}

// The quarantine verdict for one transaction. Returns a reason code, or null.
//
// FOUR GATES FIRST, and each one is a promise about what a quarantine can never
// do. They run before any heuristic because a heuristic that has to remember to
// check them is a heuristic that will eventually forget.
function detectSpam({
  wallet, chainId, category, failed, initiated, valueLegs, netLegs, labeledAddresses, context,
}) {
  // Gate 1: a verdict that asserts real money moved is never overruled.
  if (NEVER_SPAM_CATEGORIES.has(category)) return null;
  // Gate 2: a reverted transaction is already fully explained as `failed`, and
  // it is not in the review queue either.
  if (failed) return null;
  // Gate 3: THE gate. The user signed this transaction, so whatever it is, they
  // asked for it -- a purchase, an approval, or the claim that distinguishes a
  // real airdrop from a scam one. Every heuristic below runs on unsolicited
  // evidence only.
  if (initiated) return null;
  // Gate 4: value left the wallet on net.
  //
  // NOT redundant with gate 3, and the reachable case is the interesting one: a
  // netted outflow can be produced entirely by a forged Transfer event, since
  // `from_address` on a token leg is attacker-written. So the fake-token
  // variant -- a counterfeit USDT emitting Transfer(victim, lookalike, 1000e6)
  // -- reaches here with gate 3 correctly saying "unsigned", and this gate lets
  // it through unquarantined.
  //
  // That is deliberate, and it is the conservative half of a genuine ambiguity:
  // from one wallet's feed, a forged nonzero Transfer is indistinguishable from
  // a REAL outbound transfer on a chain whose `normal` feed is unsupported
  // (039) and therefore emits no gas leg. Quarantining on that evidence would
  // hide real outgoing money; leaving it visible costs one triage entry. The
  // forgery is still defanged in the two places that matter -- it cannot mark
  // its own contract voluntary, and it cannot make its lookalike a familiar
  // address -- so every later airdrop of the counterfeit is quarantined.
  if (netLegs.some((leg) => leg.direction === 'out')) return null;

  // A counterparty with any verdict at all is not an unknown sender. Exchange
  // and own come off the denormalized leg columns (which resolve builtin labels
  // too); the user's own label rows cover 'external', which classification
  // deliberately leaves inert.
  const counterparties = valueLegs
    .map((leg) => counterpartyAddress(wallet, leg))
    .filter(Boolean);
  const reviewed = valueLegs.some((leg) => leg.counterparty_is_own || leg.counterparty_exchange)
    || counterparties.some((address) => labeledAddresses.has(address));
  if (reviewed) return null;

  const inbound = valueLegs.filter((leg) => leg.to_address === wallet);
  const nftLegs = inbound.filter((leg) => NFT_TRANSFER_TYPES.has(leg.transfer_type));
  const tokenLegs = inbound.filter((leg) => leg.transfer_type === 'token');
  const unfamiliar = (legs) => legs.length > 0
    && legs.every((leg) => leg.token_contract && !context.voluntaryContracts.has(leg.token_contract));

  // THE DOLLARS THAT ACTUALLY ARRIVED, summed PER LEG over the netted inflows
  // that carry a figure -- never the transaction-level roll-up.
  //
  // rollUpUsd folds a transaction's legs to the WEAKEST basis on purpose (a
  // partial sum presented as a total is the silent-zero failure wearing a
  // different hat), which means one unpriced junk leg makes the whole
  // transaction report usd_value = null. Reading that as "no market, therefore
  // not a payment" would let a scam leg supply its own evidence: an unsigned
  // transaction crediting 1 ETH AND a worthless token would be quarantined
  // whole, ETH included, because the token dragged the basis down. Asking each
  // leg what it was worth cannot be gamed that way -- an attacker cannot make
  // the ETH leg unpriced.
  const inboundNetLegs = netLegs.filter((leg) => leg.direction === 'in');
  const claimsPriced = inboundNetLegs.filter((leg) => leg.usd_basis === 'exact'
    || leg.usd_basis === 'carried');
  const pricedInflow = claimsPriced.filter((leg) => Number.isFinite(Number(leg.usd)));
  // A leg that says it is priced and then will not parse is not a zero. On a
  // gate whose only job is to refuse to hide money, an unreadable figure has to
  // stop the quarantine, not contribute nothing to the sum and let it proceed.
  if (pricedInflow.length !== claimsPriced.length) return null;
  const pricedInflowUsd = pricedInflow.reduce((sum, leg) => sum + Math.abs(Number(leg.usd)), 0);

  // THE GATE EVERY HEURISTIC BELOW SHARES: if we can see a dollar of real value
  // arriving, nothing here may hide this transaction. Stated once, so a rule
  // cannot be added later without it.
  if (pricedInflowUsd >= SPAM_DUST_USD) return null;

  // "No market", as distinct from "no price on this row". A leg is unpriced
  // whenever the dated series does not reach it -- and it does not reach a 2019
  // transfer whose asset's series starts in 2021, or anything at all until the
  // price job has walked the wallet. Treating that as evidence of worthlessness
  // would quarantine a real 2019 payment in a real token.
  //
  // asset_price_coverage records the provider's own verdict, so the question
  // can be asked properly: 'unlisted' (no series exists, ever) and 'empty' (the
  // provider answered cleanly with no closes) are the two that mean the asset
  // has no market. 'range_limited', 'error' and "never checked" do not, and a
  // token in those states is never quarantined for being unpriced. The cost is
  // that a fresh wallet quarantines nothing under rule 4 until the price job
  // has reported on its assets -- fail-safe, and a night at most.
  const noMarket = (leg) => leg.token_contract
    && context.unlistedAssets.has(tokenAssetKey(leg.chain_id ?? chainId, leg.token_contract));

  // 1. ADDRESS POISONING. Reported first: it is the only verdict here that is
  //    also a security warning, and a poisoning transfer is usually zero-value
  //    (rule 2 below) or dust, so it would otherwise be filed under the blander
  //    reason and lose the warning.
  //
  //    Four hex characters at each end is 32 bits of coincidence, which a few
  //    hundred addresses will not collide on -- but "will not" is not "cannot",
  //    and the cost of being wrong is hiding a payment. So beyond the shared
  //    gate above, a lookalike may only quarantine something that cannot be a
  //    payment anyone meant to make:
  //      * nothing moved at all; or
  //      * we can see what it was worth, and it was under a dollar; or
  //      * we cannot see what it was worth, but every asset that arrived is one
  //        this wallet has never voluntarily touched.
  //    An UNPRICED ETH transfer from a lookalike fails all three and stays --
  //    no price means the size is unknown, not small.
  //
  //    `seenAndTiny` therefore requires EVERY inbound net leg to carry a figure,
  //    not merely one of them. "We can see what it was worth" is a statement
  //    about the transaction, and one priced five-cent junk leg beside an
  //    UNPRICED 2 ETH leg says nothing at all about the ETH -- quarantining on
  //    that is precisely the money-hiding the paragraph above forbids, reached
  //    by letting the attacker's own priced leg answer for the one it rode in
  //    with. (The shared dollar gate does not catch it: the junk leg is under a
  //    dollar, which is what makes it worth sending.)
  //
  //    `nothingMoved` is stated over EVERY value leg, not just the inbound
  //    ones, and that matters twice. It reads correctly for the spoofed
  //    zero-value OUTBOUND shape (which has no inbound legs at all), and it
  //    does not rely on `[].every()` being vacuously true -- which it would
  //    have to, and which would silently start passing every outbound-only
  //    transaction the moment gate 4 was ever loosened.
  //
  //    `unfamiliar(inbound)`, not the token legs alone: filtering the native
  //    legs out first would let an ETH credit be quarantined by the token
  //    beside it, which is the same hole rules 3 and 4 are written to avoid.
  const nothingMoved = valueLegs.length > 0 && valueLegs.every((leg) => legUnits(leg) === 0n);
  const seenAndTiny = pricedInflow.length > 0 && pricedInflow.length === inboundNetLegs.length;
  const unseenAndAlien = pricedInflow.length === 0
    && unfamiliar(inbound) && inbound.every(noMarket);
  if (nothingMoved || seenAndTiny || unseenAndAlien) {
    const impostor = counterparties.find((address) => lookalikeTarget(address, context));
    if (impostor) return SPAM_REASONS.ADDRESS_POISONING;
  }

  // 2. NOTHING MOVED, and the wallet did not ask for it. Zero cost to being
  //    wrong: a transaction in which every leg is exactly zero has no financial
  //    content to hide, whichever direction its legs point. The issue calls
  //    this one "always", and it is the only rule here that earns that.
  if (valueLegs.length > 0 && valueLegs.every((leg) => legUnits(leg) === 0n)) {
    return SPAM_REASONS.ZERO_VALUE_TRANSFER;
  }

  // 3. An unsolicited NFT. No price gate is possible for the NFT itself -- NFT
  //    valuation is out of scope (#73) and value_wei on those legs is a COUNT
  //    OF UNITS (033) -- so the weight falls on gate 3 plus "never touched this
  //    collection". An NFT you bought, minted or bid on was signed by you; one
  //    that simply appeared, from a contract you have never called, is the
  //    endemic case. A genuine gift from a friend is the false positive, and it
  //    costs one click and no data.
  //
  //    `unfamiliar(inbound)` rather than `unfamiliar(nftLegs)`: EVERY leg that
  //    arrived has to be an unfamiliar contract, so a transaction that also
  //    delivered ETH or a token is out of reach. One unsigned transaction can
  //    carry both -- an auction settled by the seller with the overbid
  //    refunded, a Safe batch, a relayed distribution -- and an NFT-shaped rule
  //    must not be the thing that hides the money beside it. A native leg has
  //    no contract, so it fails `unfamiliar` outright.
  if (nftLegs.length > 0 && tokenLegs.length === 0 && unfamiliar(inbound)) {
    return SPAM_REASONS.UNSOLICITED_NFT;
  }

  // 4. An unsolicited token. Three independent conditions, all required: the
  //    wallet did not sign it (gate 3), it has never voluntarily touched the
  //    token, and nothing that arrived carries a price at all. A scam airdrop
  //    fails all three; an unexpected USDC payment fails only the first, and
  //    stays.
  //
  //    Again `unfamiliar(inbound)`, not `unfamiliar(tokenLegs)`: an unpriced
  //    ETH credit riding alongside a junk token is still an ETH credit, and the
  //    junk token must not be able to speak for it.
  //
  //    The accepted cost, stated so it is a decision rather than a surprise: a
  //    scam airdrop that also sends a little ETH is NOT quarantined, and lands
  //    in the review queue as it did before. Letting it through would mean
  //    deciding that an unpriced ETH credit is small, which is the one thing no
  //    evidence here supports -- and spammers pay per recipient to do it, so
  //    the bundled variant is rare where the bare one is endemic.
  //
  //    "Unpriced" stands in for the issue's mass-distribution signal, which a
  //    single wallet's feed genuinely cannot see -- Etherscan reports the legs
  //    that touched THIS address and nothing about the other ten thousand
  //    recipients. It is the closest observable proxy: a token nobody lists is
  //    a token with no market, and a token with no market was not sent to you
  //    as payment.
  if (tokenLegs.length > 0 && pricedInflow.length === 0
      && unfamiliar(inbound) && inbound.every(noMarket)) {
    return SPAM_REASONS.UNSOLICITED_TOKEN;
  }

  return null;
}

// A wallet with no history at all: no address is familiar, no contract is
// voluntary, so no heuristic can fire. Frozen and shared so buildActivityRow's
// default argument is not a per-call allocation.
const EMPTY_SPAM_INPUTS = Object.freeze({
  labeledAddresses: new Set(),
  context: Object.freeze({
    voluntaryContracts: new Set(),
    familiarAddresses: new Set(),
    familiarByAbbreviation: new Map(),
    unlistedAssets: new Set(),
  }),
});

module.exports = {
  walletInitiated,
  spamContext,
  detectSpam,
  EMPTY_SPAM_INPUTS,
};
