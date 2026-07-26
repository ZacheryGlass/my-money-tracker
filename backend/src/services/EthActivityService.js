'use strict';

const pool = require('../config/database');
const logger = require('../config/logger');
const EthWallet = require('../models/EthWallet');
const EthActivity = require('../models/EthActivity');
const EthActivityLink = require('../models/EthActivityLink');
const ExchangeMatchService = require('./ExchangeMatchService');
const { DEFAULT_CHAIN_ID } = require('../config/chains');
const { tokenAssetKey } = require('../utils/assetPriceKey');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';


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

const NFT_TRANSFER_TYPES = new Set(['nft', 'nft1155']);
const NFT_STANDARDS = new Set(['erc721', 'erc1155']);

// review_reason is VARCHAR(200); these are the only values written.
const REVIEW_REASONS = {
  unlabeled_send: 'Counterparty has no verdict: spending, a gift, or a transfer?',
  unlabeled_receive: 'Counterparty has no verdict: income, a refund, or a transfer?',
  unmatched: 'Inbound and outbound legs did not match a known shape',
  no_legs: 'No transfer legs found for this transaction',
  unmatched_bridge: 'Bridge transfer with no matching leg on the other chain yet',
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

// Did the feed actually give this leg a symbol, or is the display string about
// to be a placeholder? Whitespace counts as absent: ' ' is not a symbol.
function hasSymbol(transfer) {
  return typeof transfer.token_symbol === 'string' && transfer.token_symbol.trim() !== '';
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
      symbol_known: hasSymbol(transfer),
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
      // `asset` above is a DISPLAY string, and 'TOKEN' is a placeholder, not a
      // symbol -- two different unnamed ERC-20s both render as 'TOKEN'. Anything
      // that compares assets for IDENTITY (bridge pairing) must know the
      // difference, so the leg says whether its symbol was ever read. The
      // netting loop upgrades to the first NON-EMPTY symbol seen for the same
      // contract, so one named leg makes the whole netted asset readable.
      symbol_known: hasSymbol(transfer),
    };
  }
  // native + internal are both ETH, and netting them together is the point: a
  // contract that refunds part of the ETH you sent is one net outflow.
  return {
    key: 'ETH', asset: 'ETH', contract: null, token_id: null, token_standard: null,
    decimals: 18, symbol_known: true,
  };
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
// a failed send to Coinbase as a completed exchange deposit and rule 5 read a
// reverted approve as a successful contract call. Every other rule below
// presumes value actually moved. Gas still counts either way -- fee_wei comes
// off the gas leg, which is never is_error.
//
// NOTHING here reads method_id or method_name. They ride along for display.
function classifyActivity({
  wallet, failed, valueLegs, hadValueLegs, netLegs, gasLegs, bridgeAddresses = new Set(),
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

// Pure: one transaction's eth_transfers legs -> one eth_activity row body.
function buildActivityRow(wallet, chainId, txHash, legs, ignoredContracts, decimalsFallbacks = new Map(),
  spamInputs = EMPTY_SPAM_INPUTS, bridgeAddresses = new Set()) {
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
    // The first NON-EMPTY symbol for the contract wins: a later leg of the same
    // contract that DID carry one upgrades the placeholder, and only then does
    // the asset become comparable for identity (bridge pairing).
    if (!entry.symbol_known && asset.symbol_known) {
      entry.asset = asset.asset;
      entry.symbol_known = true;
    }
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
      // Emitted ONLY when the symbol is a placeholder, so the common leg keeps
      // its shape and the flag reads as an explicit "do not trust `asset` as an
      // identity". Absent means known -- which is also how the rows written
      // before this flag existed read, and eth_activity is derived wholesale, so
      // they are rewritten at the next sync anyway.
      ...(entry.symbol_known ? {} : { symbol_known: false }),
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
    bridgeAddresses,
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
    chainId,
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
  // Asset keys the price providers have reported as having no series at all
  // ('unlisted'/'empty' in asset_price_coverage). "No market", as distinct from
  // "this row happens to be unpriced" -- see noMarket in detectSpam.
  unlistedAssets = new Set(),
  // Every address the OWNER has declared theirs -- their other tracked wallets
  // and their 'own'-labeled untracked addresses. Seeds the lookalike set; see
  // spamContext.
  ownAddresses = [],
  // The owner's 'bridge'-labeled addresses, precedence already resolved in SQL.
  // Drives the ladder's rule 3; see _bridgeAddressesForUser.
  bridgeAddresses = new Set(),
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
    context: spamContext(
      wallet, transfers, ownAddresses.map((a) => String(a).toLowerCase()), unlistedAssets
    ),
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
    buildActivityRow(wallet, chainId, txHash, legs, ignoredContracts, decimalsFallbacks, spamInputs,
      bridgeAddresses));
}

// --- bridge matching -------------------------------------------------------
//
// A bridge deposit is ONE movement of the user's own money that the chains
// record as two unrelated transactions: an outflow on chain A and an inflow on
// chain B, with different hashes, different block numbers (per-chain sequences,
// 039) and -- for a third-party fast bridge -- a different counterparty address
// on each side, because the relayer who fills you on the destination is not the
// contract you deposited into. So matching is amount-and-time based, never
// address based.
//
// Every bound below fails in the SAFE direction. A leg we decline to pair stays
// `needs_review` and visible; a leg paired WRONGLY silently fuses two unrelated
// transfers into one "self-transfer" and deletes a real send from the ledger.

// Canonical bridges take no cut of the asset (you get exactly what you sent, and
// pay in gas); fast bridges price relayer capital in, typically well under 1%.
// 2% is generous enough to cover those and tight enough that two unrelated
// round-number transfers do not pair.
const BRIDGE_MAX_FEE_BPS = 200n;

// L1 -> L2 lands in minutes on every rollup here; L2 -> L1 waits out the
// optimistic challenge period (7 days on Arbitrum/OP-stack). The window is
// chosen by the chain the money LEFT, which is the only thing that decides
// which of the two it is.
const BRIDGE_DEPOSIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const BRIDGE_WITHDRAWAL_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;

// A whole-unit decimal string ("0.25") -> base units at a fixed 18-decimal
// scale, so two chains that spell the same token with different decimals still
// compare. Digits past the 18th are dropped on BOTH sides identically and are
// ~17 orders of magnitude below the fee tolerance. Returns null for anything
// that is not a plain non-negative decimal -- a leg we cannot read is a leg we
// do not pair.
function scaleAmount(text) {
  const raw = String(text ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const [whole, frac = ''] = raw.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(`${frac}${'0'.repeat(18)}`.slice(0, 18));
}

// Two spellings of one asset, both 1:1 by construction:
//   WETH  -- wrapped ETH; bridges deliver either side of the wrapper freely.
//   FOO.e -- the bridged-representation suffix (Arbitrum's USDC.e), which is
//            what the canonical bridge MINTS for FOO, so refusing to match it
//            would leave every canonical ERC-20 deposit unpaired.
// Deliberately short. Every entry here is an assertion that two symbols are the
// same money, and a wrong one pairs two different assets.
//
// ORDER MATTERS, and it is the suffix first. The two rules COMPOSE -- a bridged
// wrapped ether is spelled `WETH.e` -- so testing WETH before stripping the
// suffix leaves `WETH.e` in a bucket of its own that pairs with neither ETH nor
// WETH, and the deposit it belongs to stays unmatched forever.
function bridgeAsset(symbol) {
  const upper = String(symbol ?? '').trim().toUpperCase();
  const base = upper.replace(/\.E$/, '');
  if (!base) return null;
  return base === 'WETH' ? 'ETH' : base;
}

// One bridge activity row -> the single fungible movement it represents, or
// null if it is not a shape we will pair. Exactly one net leg is required: a
// transaction that also moved a second asset (or an NFT) is not a plain value
// bridge, and guessing which leg crossed the chain is the kind of guess that
// writes a wrong number into someone's ledger.
function bridgeMovement(row, direction) {
  const legs = Array.isArray(row.legs) ? row.legs : [];
  if (legs.length !== 1) return null;
  const [leg] = legs;
  if (leg.direction !== direction) return null;
  if (NFT_STANDARDS.has(leg.token_standard)) return null;
  // A leg we cannot read is a leg we do not pair. `asset` is a display string
  // and 'TOKEN' is what an ERC-20 whose symbol the feed never supplied renders
  // as -- so two DIFFERENT unnamed tokens would compare equal here and fuse
  // into one "movement", which is precisely the wrong-pairing failure this
  // whole section is bounded against.
  if (leg.symbol_known === false) return null;
  const asset = bridgeAsset(leg.asset);
  const amount = scaleAmount(leg.amount);
  if (!asset || amount === null || amount === 0n) return null;
  const time = new Date(row.block_time).getTime();
  if (!Number.isFinite(time)) return null;
  return { asset, amount, time };
}

// Pure so the whole pairing policy is testable without a database. `outs` and
// `ins` must already be time-ordered; the greedy first-fit that follows is what
// makes the result deterministic -- with two identical bridges in flight, the
// earlier out claims the earlier in.
function pairBridgeLegs(outs, ins) {
  const claimed = new Set();
  const links = [];
  for (const out of outs) {
    const match = ins.find((candidate) => {
      if (claimed.has(candidate.id)) return false;
      // Cross-chain by definition. Same-chain would pair a send with an
      // unrelated receive on the same chain, which is not a bridge at all.
      if (candidate.chain_id === out.chain_id) return false;
      if (candidate.asset !== out.asset) return false;
      // Money cannot arrive before it left.
      if (candidate.time < out.time) return false;
      const window = out.chain_id === DEFAULT_CHAIN_ID
        ? BRIDGE_DEPOSIT_WINDOW_MS
        : BRIDGE_WITHDRAWAL_WINDOW_MS;
      if (candidate.time - out.time > window) return false;
      // The fee comes out of the amount, so the far side is never larger.
      if (candidate.amount > out.amount) return false;
      return (out.amount - candidate.amount) * 10000n <= out.amount * BRIDGE_MAX_FEE_BPS;
    });
    if (!match) continue;
    claimed.add(match.id);
    links.push({
      out_activity_id: out.id,
      in_activity_id: match.id,
      asset: out.asset,
      out_amount: out.rawAmount,
      in_amount: match.rawAmount,
      // The delta IS the bridge fee, in units of the asset. Computed from the
      // scaled integers rather than the display strings so it never inherits a
      // float's rounding.
      fee_amount: formatUnits(out.amount - match.amount, 18),
    });
  }
  return links;
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

    const [
      transfersResult, ignoredResult, labeledResult, ownWalletsResult, coverageResult, bridgeAddresses,
    ] = await Promise.all([
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
        // The counterparty set is built ONCE and probed, rather than asked as a
        // correlated EXISTS per label row.
        //
        // The correlated form read better -- "stop at the first matching
        // transfer" -- but the label side is 036's 5,129 rows, so Postgres ran
        // that subquery 5,129 times, and the `OR` across the two address
        // columns made each run a scan. Measured at 16.9s on a 30k-transfer
        // wallet, inside a rebuild that routes/eth.js awaits on every label
        // write and every ignore toggle. The UNION materializes the wallet's
        // distinct counterparties one time (a hashed probe afterwards), and 045
        // adds the (wallet_id, from_address) / (wallet_id, to_address) indexes
        // that make each half an index-only scan.
        `WITH counterparties AS (
             SELECT from_address AS address FROM eth_transfers WHERE wallet_id = $2
              UNION
             SELECT to_address AS address FROM eth_transfers WHERE wallet_id = $2
           )
         SELECT l.address, l.kind, l.user_id
           FROM eth_address_labels l
          WHERE l.user_id = $1
             OR (l.user_id IS NULL
                 AND l.address IN (SELECT address FROM counterparties))`,
        [wallet.user_id, walletId]
      ),
      // Every address the owner has declared theirs, across ALL their wallets --
      // the thing a poisoner most wants to imitate, and invisible to this
      // wallet's own transfers unless the two have transacted.
      pool.query('SELECT address FROM eth_wallets WHERE user_id = $1', [wallet.user_id]),
      // Assets the price providers say have NO series at all. 'range_limited'
      // and 'error' are deliberately excluded: they mean the series does not
      // reach this row, which says nothing about whether the asset has a market.
      pool.query(
        "SELECT asset_key FROM asset_price_coverage WHERE status IN ('unlisted', 'empty')"
      ),
      // The owner's bridge-labeled counterparties (#59), driving rule 3.
      this._bridgeAddressesForUser(wallet.user_id),
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

    const unlistedAssets = new Set(coverageResult.rows.map((row) => row.asset_key));

    const rows = buildActivityRows(wallet.address, transfersResult.rows, {
      ignoredContracts, labeledAddresses, ownAddresses, unlistedAssets, bridgeAddresses,
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

  // The owner's bridge-labeled addresses, precedence already resolved.
  //
  // The DISTINCT ON picks the winning row per address (user shadows builtin,
  // ORDER BY user_id NULLS LAST) and the kind test sits OUTSIDE it -- the same
  // shape as EthAddressLabel.findAllForUser, and for the same reason. Filtering
  // on kind INSIDE would drop a user's 'external' override out of the candidate
  // set and let the builtin 'bridge' row it was written to overrule resurface
  // underneath it, which is exactly how a correction stops working.
  //
  // 'own' beating 'bridge' needs nothing here: kind is one column on the
  // winning row, so an address the user declared theirs is simply not in this
  // set (and rule 1 claims the transaction before this rung anyway).
  static async _bridgeAddressesForUser(userId) {
    const result = await pool.query(
      `SELECT address FROM (
         SELECT DISTINCT ON (address) address, kind
         FROM eth_address_labels
         WHERE user_id = $1 OR user_id IS NULL
         ORDER BY address, user_id NULLS LAST
       ) resolved
       WHERE kind = 'bridge'`,
      [userId]
    );
    return new Set(result.rows.map((row) => row.address));
  }

  // Pairs each bridge_out with the bridge_in that completes it, across chains
  // and across every wallet the user owns -- a bridge from one of their
  // addresses to another is still one movement.
  //
  // DERIVED WHOLESALE, like eth_activity itself: the links are recomputed from
  // the current rows every time, never patched. That is what makes them
  // self-healing -- rebuilding wallet A cascades away any link that pointed at
  // one of its rows (ON DELETE CASCADE), and re-running this restores the ones
  // that are still true. It also means the review flag has to be re-asserted in
  // BOTH directions below: a leg matched an hour ago can be orphaned by a
  // resync of the wallet on the other side, and leaving it unflagged would
  // claim a completed transfer that no longer has a far side.
  //
  // Per USER, not per wallet, because the two legs of one bridge can sit on two
  // different wallet rows. Callers run it once after the per-wallet rebuilds.
  static async matchBridgeTransfersForUser(userId) {
    if (!userId) throw new Error('EthActivityService.matchBridgeTransfersForUser requires a userId');

    // The RESOLVED category, never the derived one. Every other reader
    // COALESCEs eth_activity_overrides over eth_activity (EthActivity's
    // RESOLVED_COLUMNS), and a matcher that skipped that would keep pairing a
    // transaction the user has explicitly re-categorized as a plain send --
    // handing it a link, and silently un-flagging the far side on the strength
    // of a verdict the user withdrew. It reads the other way too: a row the user
    // overrode INTO bridge_out becomes matchable, which is the same rule.
    const { rows } = await pool.query(
      `SELECT a.id, a.chain_id, a.block_time,
              COALESCE(o.category, a.category) AS category, a.legs
       FROM eth_activity a
       JOIN eth_wallets w ON w.id = a.wallet_id
       LEFT JOIN eth_activity_overrides o
         ON o.wallet_id = a.wallet_id AND o.chain_id = a.chain_id AND o.tx_hash = a.tx_hash
       WHERE w.user_id = $1
         AND COALESCE(o.category, a.category) IN ('bridge_out', 'bridge_in')
       -- Time first: block_number is a per-chain sequence (039) and means
       -- nothing across chains, and the greedy pairing below depends on both
       -- sides being in true chronological order. The rest of the key only
       -- makes the order total, so a rebuild cannot reshuffle equal timestamps.
       ORDER BY a.block_time, a.chain_id, a.id`,
      [userId]
    );

    const candidates = (direction, category) => rows
      .filter((row) => row.category === category)
      .map((row) => {
        const movement = bridgeMovement(row, direction);
        if (!movement) return null;
        return { id: row.id, chain_id: row.chain_id, rawAmount: row.legs[0].amount, ...movement };
      })
      .filter(Boolean);

    const links = pairBridgeLegs(candidates('out', 'bridge_out'), candidates('in', 'bridge_in'));
    const written = await EthActivityLink.replaceForUser(userId, links);
    const flagged = await EthActivityLink.syncBridgeReviewState(userId, REVIEW_REASONS.unmatched_bridge);

    logger.info({ userId, matched: written, unmatched: flagged }, 'ETH bridge legs matched');
    return { matched: written, unmatched: flagged };
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
// The pairing policy, exported pure so every bound (fee tolerance, window,
// direction, cross-chain requirement) is testable without a database.
module.exports.pairBridgeLegs = pairBridgeLegs;
module.exports.bridgeAsset = bridgeAsset;
module.exports.BRIDGE_MAX_FEE_BPS = BRIDGE_MAX_FEE_BPS;
module.exports.BRIDGE_DEPOSIT_WINDOW_MS = BRIDGE_DEPOSIT_WINDOW_MS;
module.exports.BRIDGE_WITHDRAWAL_WINDOW_MS = BRIDGE_WITHDRAWAL_WINDOW_MS;
