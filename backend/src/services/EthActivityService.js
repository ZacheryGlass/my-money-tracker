'use strict';

const pool = require('../config/database');
const logger = require('../config/logger');
const EthWallet = require('../models/EthWallet');
const EthActivity = require('../models/EthActivity');
const ExchangeMatchService = require('./ExchangeMatchService');
const { DEFAULT_CHAIN_ID } = require('../config/chains');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';


// The full category vocabulary (038's CHECK constraint carries the same list).
// A superset by design: later issues fill in exchange_trade, staking_reward and
// bridge_out/bridge_in (#59). 'spend' and 'approval' are reachable only through
// an override -- see classifyActivity.
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

const NFT_TRANSFER_TYPES = new Set(['nft', 'nft1155']);
const NFT_STANDARDS = new Set(['erc721', 'erc1155']);

// review_reason is VARCHAR(200); these are the only values written.
const REVIEW_REASONS = {
  unlabeled_send: 'Counterparty has no verdict: spending, a gift, or a transfer?',
  unlabeled_receive: 'Counterparty has no verdict: income, a refund, or a transfer?',
  unmatched: 'Inbound and outbound legs did not match a known shape',
  no_legs: 'No transfer legs found for this transaction',
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

function weakestBasis(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (USD_BASIS_RANK[a] ?? 2) >= (USD_BASIS_RANK[b] ?? 2) ? a : b;
}

// USD is accumulated in INTEGER CENTS, never in dollars.
// eth_transfers.usd_at_time is NUMERIC(20,2) and arrives as a string; summing
// the parsed dollars would drift by fractions of a cent across a swap's legs
// and land a $3,000.00 trade at $2,999.99. Exact NUMERIC in SQL, exact cents
// in JS -- floats value nothing here.
function toCents(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}

function fromCents(cents) {
  return cents == null ? null : Number((cents / 100).toFixed(2));
}

// NUMERIC(78,0) arrives as a string. Tolerates null and a stray scale so one
// malformed row cannot throw mid-rebuild.
function toBigInt(value) {
  if (value === null || value === undefined) return 0n;
  const text = String(value).trim();
  if (!text) return 0n;
  const whole = text.split('.')[0];
  try {
    return BigInt(whole);
  } catch {
    return 0n;
  }
}

// Branch on transfer_type FIRST. value_wei on an NFT leg is a count of units
// (033), not wei and not a scaled token amount, so scaling it by 18 -- or by
// anything -- would render a 1-of-1 as 0.000000000000000001. token_decimals is
// written 0 on those rows, but this never relies on that.
//
// THE DECIMALS-REPAIR RULE, shared verbatim with the valuation SQL
// (AssetPriceHistory quantitySql): the leg's OWN token_decimals, else the
// MINIMUM non-NULL value seen for that (chain, contract) across the wallet,
// else 18 -- clamped to [0, 78] so a malformed feed value cannot turn
// 10^decimals into an aborting exponent. Etherscan omits tokenDecimal on some
// legs of a contract it fills in on others, so a repair is needed; it just has
// to be the SAME repair on both sides. When it was not, one row could show a
// netted `amount` scaled by 6 next to a `usd_value` scaled by 18 -- two numbers
// about the same transfer that cannot both be true.
function legDecimals(transfer, fallback = 18) {
  if (NFT_TRANSFER_TYPES.has(transfer.transfer_type)) return 0;
  if (transfer.transfer_type === 'token') {
    const raw = transfer.token_decimals != null ? Number(transfer.token_decimals) : fallback;
    const decimals = Number.isFinite(raw) ? raw : 18;
    return Math.max(0, Math.min(decimals, 78));
  }
  return 18;
}

// The wallet-wide half of that rule: MIN(token_decimals) per (chain, contract)
// over every leg, matching the SQL window function exactly. Built across ALL of
// a wallet's transfers, not per transaction -- the SQL partition spans the
// wallet, so a per-tx map would disagree the moment the only leg naming its
// decimals sat in a different transaction.
function tokenDecimalsFallbacks(transfers) {
  const byToken = new Map();
  for (const transfer of transfers) {
    if (transfer.transfer_type !== 'token' || !transfer.token_contract) continue;
    if (transfer.token_decimals == null) continue;
    const value = Number(transfer.token_decimals);
    if (!Number.isFinite(value)) continue;
    const key = `${transfer.chain_id ?? DEFAULT_CHAIN_ID}:${transfer.token_contract}`;
    const seen = byToken.get(key);
    if (seen == null || value < seen) byToken.set(key, value);
  }
  return byToken;
}

// Base units -> a whole-unit decimal string. Sign is carried by `direction`, so
// this returns the magnitude. NOT EthWalletService.unitsToDecimalString: that
// one clamps to the holdings column's DECIMAL(20,8); this is full precision,
// for display inside legs JSONB where nothing bounds the scale.
function formatUnits(value, decimals) {
  const abs = value < 0n ? -value : value;
  if (decimals <= 0) return abs.toString();
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

// The netting key. An NFT nets per (contract, token_id): two different ids from
// one collection are two different things and must never cancel out.
function assetOf(transfer, decimalsFallbacks = new Map()) {
  if (NFT_TRANSFER_TYPES.has(transfer.transfer_type)) {
    return {
      key: `nft:${transfer.token_contract}:${transfer.token_id}`,
      asset: transfer.token_symbol || 'NFT',
      contract: transfer.token_contract || null,
      token_id: transfer.token_id != null ? String(transfer.token_id) : null,
      token_standard: transfer.token_standard
        || (transfer.transfer_type === 'nft' ? 'erc721' : 'erc1155'),
      decimals: 0,
    };
  }
  if (transfer.transfer_type === 'token') {
    return {
      key: `erc20:${transfer.token_contract}`,
      asset: transfer.token_symbol || 'TOKEN',
      contract: transfer.token_contract || null,
      token_id: null,
      token_standard: transfer.token_standard || 'erc20',
      // The feed omits tokenDecimal on some legs; the wallet-wide MIN for this
      // (chain, contract) fills the gap, which is the same repair the valuation
      // SQL makes. One leg missing its decimals can no longer pin the netted
      // amount to a scale the dollar figure disagrees with.
      decimals: legDecimals(
        transfer,
        decimalsFallbacks.get(`${transfer.chain_id ?? DEFAULT_CHAIN_ID}:${transfer.token_contract}`) ?? 18
      ),
    };
  }
  // native + internal are both ETH, and netting them together is the point: a
  // contract that refunds part of the ETH you sent is one net outflow.
  return { key: 'ETH', asset: 'ETH', contract: null, token_id: null, token_standard: null, decimals: 18 };
}

function counterpartyAddress(wallet, leg) {
  return leg.from_address === wallet ? leg.to_address : leg.from_address;
}

// Who the transaction was with. Exchange first (that verdict is the one with
// financial consequences), then a single unambiguous counterparty, then the
// contract the wallet called -- which is the gas leg's destination, and the
// only meaningful "who" for a router swap that touched six pool addresses.
function resolveCounterparty(wallet, valueLegs, gasLegs) {
  const exchangeLeg = valueLegs.find((leg) => !leg.counterparty_is_own && leg.counterparty_exchange);
  if (exchangeLeg) {
    return { address: counterpartyAddress(wallet, exchangeLeg), name: exchangeLeg.counterparty_exchange };
  }
  const addresses = new Set(
    valueLegs
      .filter((leg) => !leg.counterparty_is_own)
      .map((leg) => counterpartyAddress(wallet, leg))
      .filter(Boolean)
  );
  if (addresses.size === 1) return { address: [...addresses][0], name: null };
  const gasTo = gasLegs.find((leg) => leg.to_address)?.to_address || null;
  if (gasTo) return { address: gasTo, name: null };
  // A self-transfer's only counterparties are own addresses, filtered out
  // above; fall back to the first of them rather than reporting none.
  const ownAddress = valueLegs.map((leg) => counterpartyAddress(wallet, leg)).find(Boolean);
  return { address: ownAddress || null, name: null };
}

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
// a failed send to Coinbase as a completed exchange deposit and rule 4 read a
// reverted approve as a successful contract call. Every other rule below
// presumes value actually moved. Gas still counts either way -- fee_wei comes
// off the gas leg, which is never is_error.
//
// NOTHING here reads method_id or method_name. They ride along for display.
function classifyActivity({ wallet, failed, valueLegs, hadValueLegs, netLegs, gasLegs }) {
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

  // 3. Zero-address legs. Scoped to NFT legs deliberately: an ERC-20 minted
  // from 0x0 into the wallet is a claim or an airdrop, which is a judgment
  // call, and rule 7 is where judgment calls go. A mint that cost ETH is still
  // a mint (this rule sits above nft_purchase by the issue's numbering, and
  // that is the right answer).
  const nftLegs = valueLegs.filter((leg) => NFT_TRANSFER_TYPES.has(leg.transfer_type));
  if (nftLegs.some((leg) => leg.from_address === ZERO_ADDRESS && leg.to_address === wallet)) {
    return verdict('nft_mint');
  }
  if (nftLegs.some((leg) => leg.to_address === ZERO_ADDRESS && leg.from_address === wallet)) {
    return verdict('nft_burn');
  }

  // 4. Nothing moved on net.
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

  // 5. Fungible out + a different fungible in. Netting is per asset, so an out
  // entry and an in entry existing at all means two different assets.
  if (fungibleOut && fungibleIn) return verdict('swap');

  // 6. NFT against fungible.
  if (nfts.some((leg) => leg.direction === 'in') && fungibleOut) return verdict('nft_purchase');
  if (nfts.some((leg) => leg.direction === 'out') && fungibleIn) return verdict('nft_sale');

  // 7. One-way, unlabeled counterparty. NEVER auto-classified as spending:
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

// Base units of a leg as a BigInt magnitude. NFT legs carry a COUNT OF UNITS
// (033) rather than wei, which is fine: every caller below only asks whether it
// is zero.
const legUnits = (leg) => {
  const raw = toBigInt(leg.value_wei);
  return raw < 0n ? -raw : raw;
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
function spamContext(wallet, transfers, ownAddresses = []) {
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

  return { voluntaryContracts, familiarAddresses, familiarByAbbreviation };
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
  wallet, category, failed, initiated, valueLegs, netLegs, labeledAddresses, context,
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
  // Gate 4: value left the wallet on net. Unreachable given gate 3 (nothing
  // leaves a wallet without its signature) and kept anyway, because it is the
  // property the issue states outright and it should not depend on gate 3
  // staying correct.
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
  const pricedInflow = netLegs.filter((leg) => leg.direction === 'in'
    && leg.usd != null
    && (leg.usd_basis === 'exact' || leg.usd_basis === 'carried'));
  const pricedInflowUsd = pricedInflow.reduce((sum, leg) => sum + Math.abs(Number(leg.usd) || 0), 0);

  // THE GATE EVERY HEURISTIC BELOW SHARES: if we can see a dollar of real value
  // arriving, nothing here may hide this transaction. Stated once, so a rule
  // cannot be added later without it.
  if (pricedInflowUsd >= SPAM_DUST_USD) return null;

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
  const nothingMoved = inbound.every((leg) => legUnits(leg) === 0n);
  const seenAndTiny = pricedInflow.length > 0;
  const unseenAndAlien = pricedInflow.length === 0
    && unfamiliar(inbound.filter((leg) => leg.token_contract));
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
  if (tokenLegs.length > 0 && pricedInflow.length === 0 && unfamiliar(inbound)) {
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
  }),
});

// Pure: one transaction's eth_transfers legs -> one eth_activity row body.
function buildActivityRow(wallet, chainId, txHash, legs, ignoredContracts, decimalsFallbacks = new Map(),
  spamInputs = EMPTY_SPAM_INPUTS) {
  const gasLegs = legs.filter((leg) => leg.transfer_type === 'gas');
  const feeWei = gasLegs.reduce((sum, leg) => sum + toBigInt(leg.value_wei), 0n);

  // Reverted, read from two places because a revert can land in two shapes.
  //
  // 1. A value-bearing tx reverts: is_error rides on the native leg (or the
  //    internal trace). The gas leg is written is_error = false on purpose --
  //    the fee did not fail, and the mirror and the triage queue rely on that.
  // 2. A ZERO-VALUE tx reverts (a failed approve, a swap that reverts before
  //    any Transfer log) -- the most common revert shape on chain. It emits no
  //    native leg at all, so the only row is the gas leg, whose is_error is
  //    false by rule 1's semantics. tx_is_error carries the transaction's own
  //    status there (038) so the gate can see it without changing what
  //    is_error means to anyone else.
  //
  // tx_is_error is FORWARD-ONLY data, the same precedent as 034's method
  // capture: rows ingested before 038 have NULL and read as "not known to have
  // failed", so an old reverted approve still classifies contract_interaction.
  // Removing and re-adding the wallet re-ingests from block 0 and heals it.
  const failed = legs.some((leg) => (leg.transfer_type !== 'gas' && leg.is_error) || leg.tx_is_error === true);

  // At most one leg per tx carries calldata (034): the native leg when ETH
  // moved, else the gas leg.
  const methodLeg = legs.find((leg) => leg.method_id) || null;

  const allValueLegs = legs.filter((leg) => leg.transfer_type !== 'gas' && !leg.is_error);
  // Ignored tokens are filtered here as they are in the balance deltas, the
  // ledger mirror and the transfers feed: the user declared them noise, and
  // letting spam drive classification would refill the review queue nightly.
  const valueLegs = allValueLegs.filter(
    (leg) => !(leg.token_contract && ignoredContracts.has(leg.token_contract))
  );

  const nets = new Map();
  for (const leg of valueLegs) {
    const incoming = leg.to_address === wallet;
    const outgoing = leg.from_address === wallet;
    // A leg the wallet is not party to cannot appear in its feed; skip rather
    // than assume a direction.
    if (!incoming && !outgoing) continue;
    const asset = assetOf(leg, decimalsFallbacks);
    const entry = nets.get(asset.key) || { ...asset, raw: 0n, usdCents: 0, usdBasis: null };
    // A leg from the wallet to itself nets to zero, which is correct.
    if (incoming) entry.raw += toBigInt(leg.value_wei);
    if (outgoing) entry.raw -= toBigInt(leg.value_wei);

    // USD nets the same way the quantity does, and it MUST: every leg of one
    // transaction shares a date, so it shares a price, and the signed sum of
    // leg dollars is the netted quantity times that price. Summing here rather
    // than multiplying the net amount by a price also keeps this layer out of
    // the pricing business entirely -- usd_at_time is written once, in SQL.
    //
    // Two `if`s, not a ternary on `incoming`: a leg from the wallet TO ITSELF
    // has both flags set, and the quantity above nets it to zero. A ternary
    // would add its dollars and never subtract them, so a self-leg riding
    // alongside a real one (a rebase, a claim-and-restake) would understate the
    // outflow by exactly the self-leg's value while showing the correct amount.
    const cents = toCents(leg.usd_at_time);
    entry.usdBasis = weakestBasis(entry.usdBasis, leg.usd_basis || 'unpriced');
    if (cents != null) {
      if (incoming) entry.usdCents += cents;
      if (outgoing) entry.usdCents -= cents;
    }
    nets.set(asset.key, entry);
  }

  const netLegs = [...nets.values()]
    .filter((entry) => entry.raw !== 0n)
    .map((entry) => ({
      asset: entry.asset,
      contract: entry.contract,
      token_id: entry.token_id,
      token_standard: entry.token_standard,
      direction: entry.raw > 0n ? 'in' : 'out',
      amount: formatUnits(entry.raw, entry.decimals),
      amount_raw: (entry.raw < 0n ? -entry.raw : entry.raw).toString(),
      // Magnitude, like `amount`: direction already carries the sign. NULL when
      // the asset could not be priced on this date -- never 0, which would read
      // as "worth nothing" rather than "not known".
      usd: entry.usdBasis === 'exact' || entry.usdBasis === 'carried'
        ? fromCents(Math.abs(entry.usdCents))
        : null,
      usd_basis: entry.usdBasis || 'unpriced',
    }))
    // Deterministic: out before in, then asset, then id. A rebuild that
    // reordered legs would show as a diff on every sync.
    .sort((a, b) => (a.direction === b.direction
      ? (a.asset === b.asset ? String(a.token_id).localeCompare(String(b.token_id)) : a.asset.localeCompare(b.asset))
      : (a.direction === 'out' ? -1 : 1)));

  const classification = classifyActivity({
    wallet,
    failed,
    valueLegs,
    hadValueLegs: allValueLegs.length > 0,
    netLegs,
    gasLegs,
  });

  const counterparty = resolveCounterparty(wallet, valueLegs, gasLegs);
  const usd = rollUpUsd(netLegs, gasLegs, failed);

  // AFTER the ladder and after the valuation, both of which it reads. The
  // quarantine is a second opinion about a transaction that has already been
  // classified and priced -- it never decides what the transaction WAS, only
  // whether the user has to look at it.
  const spamReason = detectSpam({
    wallet,
    category: classification.category,
    failed,
    initiated: walletInitiated(wallet, gasLegs, valueLegs),
    valueLegs,
    netLegs,
    labeledAddresses: spamInputs.labeledAddresses,
    context: spamInputs.context,
  });

  return {
    chain_id: chainId,
    tx_hash: txHash,
    block_number: Math.min(...legs.map((leg) => Number(leg.block_number))),
    block_time: legs.reduce(
      (earliest, leg) => (earliest && new Date(earliest) <= new Date(leg.block_time) ? earliest : leg.block_time),
      null
    ),
    ...classification,
    counterparty_address: counterparty.address,
    counterparty_name: counterparty.name,
    method_id: methodLeg?.method_id || null,
    method_name: methodLeg?.method_name || null,
    // A reverted transaction moved nothing, so it has no legs -- only the fee.
    legs: failed ? [] : netLegs,
    fee_wei: feeWei.toString(),
    usd_value: usd.value,
    usd_fee: usd.fee,
    usd_basis: usd.basis,
    // The quarantine rides BESIDE everything above, never over it (#74). Note
    // that needs_review keeps the ladder's honest answer: readers mask it while
    // the row is quarantined, so un-quarantining puts a false positive back in
    // the queue instead of quietly marking it reviewed.
    spam: spamReason != null,
    spam_reason: spamReason,
  };
}

// The transaction-level dollar figure, at the time.
//
// ONE SIDE, not both. A swap of 1 ETH for 3,000 USDC is a $3,000 event, not a
// $6,000 one, so the outbound side is the value when there is one and the
// inbound side otherwise (a receive, an airdrop, a withdrawal). The netted legs
// already collapsed a refund into its outflow, so this cannot double-count a
// contract that handed part of the ETH back.
//
// NFT legs contribute nothing: their value is out of scope (#73) and their
// amount is a COUNT OF UNITS (033). The ETH leg of a purchase already carries
// what was actually paid, which IS the at-the-time value of the NFT.
function rollUpUsd(netLegs, gasLegs, failed) {
  let feeCents = 0;
  let feeBasis = null;
  for (const leg of gasLegs) {
    feeBasis = weakestBasis(feeBasis, leg.usd_basis || 'unpriced');
    const cents = toCents(leg.usd_at_time);
    if (cents != null) feeCents += Math.abs(cents);
  }
  const fee = gasLegs.length && (feeBasis === 'exact' || feeBasis === 'carried')
    ? fromCents(feeCents)
    : null;

  // A reverted transaction moved no value; only its fee is real. Reporting a
  // dollar value for it would put a completed-looking amount on a transaction
  // that never happened.
  if (failed || !netLegs.length) {
    return { value: null, fee, basis: 'not_applicable' };
  }

  const priced = netLegs.filter((leg) => leg.usd_basis !== 'not_applicable');
  if (!priced.length) return { value: null, fee, basis: 'not_applicable' };

  const outbound = priced.filter((leg) => leg.direction === 'out');
  const inbound = priced.filter((leg) => leg.direction === 'in');
  const basisOf = (legs) => legs.reduce((weakest, leg) => weakestBasis(weakest, leg.usd_basis), null);
  const valued = (basis) => basis === 'exact' || basis === 'carried';

  // Outbound is the PREFERRED side, not the only one. Both sides of a swap are
  // the same event, so when the preferred side is unpriced and the other side
  // has a real figure, taking the figure is strictly better than reporting
  // nothing: selling an unlisted token for 2 ETH is a two-ETH event, and
  // "usd_value: null" on it is the silent-zero failure by another route -- the
  // number was right there on the other leg. Only when NEITHER side is priced
  // does the transaction report unpriced.
  let side = outbound.length ? outbound : inbound;
  let basis = basisOf(side);
  if (!valued(basis)) {
    const other = side === outbound ? inbound : outbound;
    const otherBasis = basisOf(other);
    if (other.length && valued(otherBasis)) {
      side = other;
      basis = otherBasis;
    }
  }
  if (!side.length) return { value: null, fee, basis: 'not_applicable' };
  if (!valued(basis)) return { value: null, fee, basis };

  const cents = side.reduce((sum, leg) => sum + Math.abs(toCents(leg.usd) ?? 0), 0);
  return { value: fromCents(cents), fee, basis };
}

// Pure: a wallet's eth_transfers rows -> its eth_activity rows, one per
// (chain_id, tx_hash). The chain is part of the group key, not just the row:
// block numbers are independent per-chain sequences and a cross-chain replay
// (same account, same nonce, same calldata on two chains) genuinely shares a
// hash -- grouping on tx_hash alone would fuse two different transactions into
// one row and violate eth_activity's UNIQUE. Exported for tests, which is
// where every ladder rule is exercised.
function buildActivityRows(walletAddress, transfers, {
  ignoredContracts = new Set(),
  // Addresses the OWNER has given an explicit verdict to, in any kind. Only the
  // user's own rows: 'exchange' and 'own' already ride on the legs
  // (counterparty_exchange / counterparty_is_own, builtins resolved), and
  // 'external' -- reviewed, genuinely a third party -- is inert in
  // classification but must still keep the quarantine off a reviewed address.
  labeledAddresses = new Set(),
  // Every address the OWNER has declared theirs -- their other tracked wallets
  // and their 'own'-labeled untracked addresses. Seeds the lookalike set; see
  // spamContext.
  ownAddresses = [],
} = {}) {
  const wallet = String(walletAddress).toLowerCase();
  // Wallet-wide, before the grouping: the SQL partition this mirrors spans the
  // wallet, not the transaction.
  const decimalsFallbacks = tokenDecimalsFallbacks(transfers);
  // Also wallet-wide, and for the same reason: "has this token ever been
  // touched on purpose?" is a question about the whole history.
  //
  // Built from the RAW transfers, ignored tokens included. An ignored token the
  // user once traded is still a token they chose to hold, and dropping that
  // evidence would let the ignore list quietly make its own past voluntary.
  const spamInputs = {
    labeledAddresses,
    context: spamContext(wallet, transfers, ownAddresses.map((a) => String(a).toLowerCase())),
  };
  const byTx = new Map();
  for (const transfer of transfers) {
    const chainId = transfer.chain_id ?? DEFAULT_CHAIN_ID;
    const groupKey = `${chainId}:${transfer.tx_hash}`;
    const existing = byTx.get(groupKey);
    if (existing) existing.legs.push(transfer);
    else byTx.set(groupKey, { chainId, txHash: transfer.tx_hash, legs: [transfer] });
  }
  return [...byTx.values()].map(({ chainId, txHash, legs }) =>
    buildActivityRow(wallet, chainId, txHash, legs, ignoredContracts, decimalsFallbacks, spamInputs));
}

class EthActivityService {
  // Deterministic full rebuild of one wallet's activity rows. Called after
  // every sync and every classification refresh, exactly like the ledger
  // mirror. Overrides live in their own table and are untouched here.
  //
  // `rebuildMatches: false` is for a caller that is walking EVERY wallet of one
  // user: the match pass is user-wide by design, so running it per wallet
  // repeats the same full re-derivation N times. Such a caller runs it once
  // itself, after the loop -- see EthWalletService.
  static async rebuildForWallet(walletId, { rebuildMatches = true } = {}) {
    const wallet = await EthWallet.findById(walletId);
    if (!wallet) throw new Error(`EthWallet ${walletId} not found`);

    const [transfersResult, ignoredResult, labeledResult, ownWalletsResult] = await Promise.all([
      pool.query(
        'SELECT * FROM eth_transfers WHERE wallet_id = $1 ORDER BY block_number, id',
        [walletId]
      ),
      pool.query('SELECT contract_address FROM eth_ignored_tokens WHERE user_id = $1', [wallet.user_id]),
      // Which counterparties already carry a verdict, in ANY kind -- the same
      // question the triage queue asks, and it has to get the same answer.
      //
      // The user's own rows, plus the builtin rows for addresses THIS WALLET
      // has actually transacted with. The second arm is bounded on purpose: an
      // unrestricted `OR user_id IS NULL` would drag 036's 5,129-address pack
      // into every rebuild. It cannot be dropped either -- 'exchange' and 'own'
      // reach the builder denormalized onto each leg, but 'external' is inert
      // in classification by design, so a builtin 'external' (the pack's 389
      // payment processors and fiat on-ramps) would otherwise reach nothing at
      // all, and a payout from one of them in an unpriced token would be
      // quarantined by a pack row that already says "reviewed third party".
      //
      // `kind` and `user_id` ride along so this one query also yields the
      // own-address set below.
      pool.query(
        `SELECT DISTINCT l.address, l.kind, l.user_id
           FROM eth_address_labels l
          WHERE l.user_id = $1
             OR (l.user_id IS NULL AND l.address IN (
                   SELECT t.from_address FROM eth_transfers t WHERE t.wallet_id = $2
                   UNION
                   SELECT t.to_address FROM eth_transfers t WHERE t.wallet_id = $2))`,
        [wallet.user_id, walletId]
      ),
      // Every address the owner has declared theirs, across ALL their wallets --
      // the thing a poisoner most wants to imitate, and invisible to this
      // wallet's own transfers unless the two have transacted.
      pool.query('SELECT address FROM eth_wallets WHERE user_id = $1', [wallet.user_id]),
    ]);
    const ignoredContracts = new Set(ignoredResult.rows.map((row) => row.contract_address));
    const labeledAddresses = new Set(labeledResult.rows.map((row) => row.address));
    const ownAddresses = [
      ...ownWalletsResult.rows.map((row) => row.address),
      // 'own' is STRICTLY user-scoped with no builtin fallback -- a global "this
      // address is yours" row would be nonsense -- so the user_id test here is
      // not redundant with the query's first arm.
      ...labeledResult.rows
        .filter((row) => row.kind === 'own' && row.user_id === wallet.user_id)
        .map((row) => row.address),
    ];

    const rows = buildActivityRows(wallet.address, transfersResult.rows, {
      ignoredContracts, labeledAddresses, ownAddresses,
    });
    await this._nameCounterparties(wallet.user_id, rows);
    const written = await EthActivity.replaceForWallet(walletId, rows);

    // The exchange matching pass (#61), re-derived here for the same reason the
    // rows above are: it is a claim about these rows, and eth_activity is
    // delete-then-insert, so any match written earlier was cascaded away by the
    // DELETE that just ran. It also OWNS the needs_review flag on the two
    // exchange categories -- an exchange flow with no record behind it is the
    // thing the issue wants surfaced -- so it has to run after the ladder, not
    // inside it. Non-fatal: a sync that fetched every transfer must not report
    // failure because a derived side table could not be refreshed.
    const matches = rebuildMatches
      ? await ExchangeMatchService.rebuildForUserSafely(wallet.user_id, { walletId })
      : null;

    logger.info({ walletId, activity: written }, 'ETH activity rebuilt');
    return { activity: written, matches };
  }

  // Fills counterparty_name for display from the owner's labels, resolved with
  // the same precedence as classification: a user row shadows a builtin. An
  // exchange name is already denormalized onto the leg, so those rows keep it.
  static async _nameCounterparties(userId, rows) {
    const pending = [...new Set(
      rows.filter((row) => row.counterparty_address && !row.counterparty_name)
        .map((row) => row.counterparty_address)
    )];
    if (!pending.length) return;

    const result = await pool.query(
      `SELECT DISTINCT ON (address) address, name
       FROM eth_address_labels
       WHERE address = ANY($1::varchar[]) AND (user_id = $2 OR user_id IS NULL)
       ORDER BY address, user_id NULLS LAST`,
      [pending, userId]
    );
    const names = new Map(result.rows.map((row) => [row.address, row.name]));
    for (const row of rows) {
      if (!row.counterparty_name && row.counterparty_address) {
        row.counterparty_name = names.get(row.counterparty_address) || null;
      }
    }
  }
}

module.exports = EthActivityService;
module.exports.buildActivityRows = buildActivityRows;
module.exports.CATEGORIES = CATEGORIES;
module.exports.DEFAULT_CHAIN_ID = DEFAULT_CHAIN_ID;
module.exports.ZERO_ADDRESS = ZERO_ADDRESS;
module.exports.REVIEW_REASONS = REVIEW_REASONS;
module.exports.SPAM_REASONS = SPAM_REASONS;
module.exports.SPAM_DUST_USD = SPAM_DUST_USD;
