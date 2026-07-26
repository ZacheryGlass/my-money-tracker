'use strict';

const pool = require('../config/database');
const logger = require('../config/logger');
const EthWallet = require('../models/EthWallet');
const EthActivity = require('../models/EthActivity');
const EthActivityLink = require('../models/EthActivityLink');
const { DEFAULT_CHAIN_ID } = require('../config/chains');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';


// The full category vocabulary (038's CHECK constraint carries the same list).
// A superset by design: later issues fill in exchange_trade (#61) and
// staking_reward (#61). 'spend' and 'approval' are reachable only through an
// override -- see classifyActivity.
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
function legDecimals(transfer) {
  if (NFT_TRANSFER_TYPES.has(transfer.transfer_type)) return 0;
  if (transfer.transfer_type === 'token') {
    const decimals = transfer.token_decimals != null ? Number(transfer.token_decimals) : 18;
    return Number.isFinite(decimals) ? Math.max(0, Math.min(decimals, 78)) : 18;
  }
  return 18;
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
function assetOf(transfer) {
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
      decimals: legDecimals(transfer),
      // legDecimals falls back to 18 when the feed omitted tokenDecimal, and
      // one such leg first in the list would otherwise pin the whole netted
      // amount to the wrong scale. The netting loop upgrades to the first
      // NON-NULL value it sees for the same contract.
      decimals_known: transfer.token_decimals != null,
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
// `failed` (#56's rule 8) is evaluated as a GATE rather than a rung. A
// reverted transaction moved nothing, so running it last would let rule 2 read
// a failed send to Coinbase as a completed exchange deposit and rule 5 read a
// reverted approve as a successful contract call. Every other rule below
// presumes value actually moved. Gas still counts either way -- fee_wei comes
// off the gas leg, which is never is_error.
//
// NOTHING here reads method_id or method_name. They ride along for display.
function classifyActivity({ wallet, failed, valueLegs, hadValueLegs, netLegs, gasLegs, bridgeAddresses }) {
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
  // a mint (this rule sits above nft_purchase by #56's numbering, and that is
  // the right answer).
  const nftLegs = valueLegs.filter((leg) => NFT_TRANSFER_TYPES.has(leg.transfer_type));
  if (nftLegs.some((leg) => leg.from_address === ZERO_ADDRESS && leg.to_address === wallet)) {
    return verdict('nft_mint');
  }
  if (nftLegs.some((leg) => leg.to_address === ZERO_ADDRESS && leg.from_address === wallet)) {
    return verdict('nft_burn');
  }

  // 5. Nothing moved on net.
  //
  // #56 splits this into `approval` / `contract_interaction`, but the
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

// Pure: one transaction's eth_transfers legs -> one eth_activity row body.
function buildActivityRow(wallet, chainId, txHash, legs, ignoredContracts, bridgeAddresses) {
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
    const asset = assetOf(leg);
    const entry = nets.get(asset.key) || { ...asset, raw: 0n };
    // First NON-NULL token_decimals across the contract's legs wins, rather
    // than whichever leg happened to be first.
    if (!entry.decimals_known && asset.decimals_known) {
      entry.decimals = asset.decimals;
      entry.decimals_known = true;
    }
    // A leg from the wallet to itself nets to zero, which is correct.
    if (incoming) entry.raw += toBigInt(leg.value_wei);
    if (outgoing) entry.raw -= toBigInt(leg.value_wei);
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
  };
}

// Pure: a wallet's eth_transfers rows -> its eth_activity rows, one per
// (chain_id, tx_hash). The chain is part of the group key, not just the row:
// block numbers are independent per-chain sequences and a cross-chain replay
// (same account, same nonce, same calldata on two chains) genuinely shares a
// hash -- grouping on tx_hash alone would fuse two different transactions into
// one row and violate eth_activity's UNIQUE. Exported for tests, which is
// where every ladder rule is exercised.
function buildActivityRows(
  walletAddress,
  transfers,
  { ignoredContracts = new Set(), bridgeAddresses = new Set() } = {}
) {
  const wallet = String(walletAddress).toLowerCase();
  const byTx = new Map();
  for (const transfer of transfers) {
    const chainId = transfer.chain_id ?? DEFAULT_CHAIN_ID;
    const groupKey = `${chainId}:${transfer.tx_hash}`;
    const existing = byTx.get(groupKey);
    if (existing) existing.legs.push(transfer);
    else byTx.set(groupKey, { chainId, txHash: transfer.tx_hash, legs: [transfer] });
  }
  return [...byTx.values()].map(({ chainId, txHash, legs }) =>
    buildActivityRow(wallet, chainId, txHash, legs, ignoredContracts, bridgeAddresses));
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
function bridgeAsset(symbol) {
  const upper = String(symbol ?? '').trim().toUpperCase();
  if (!upper) return null;
  if (upper === 'WETH') return 'ETH';
  return upper.replace(/\.E$/, '');
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
  static async rebuildForWallet(walletId) {
    const wallet = await EthWallet.findById(walletId);
    if (!wallet) throw new Error(`EthWallet ${walletId} not found`);

    const [transfersResult, ignoredResult, bridgeAddresses] = await Promise.all([
      pool.query(
        'SELECT * FROM eth_transfers WHERE wallet_id = $1 ORDER BY block_number, id',
        [walletId]
      ),
      pool.query('SELECT contract_address FROM eth_ignored_tokens WHERE user_id = $1', [wallet.user_id]),
      this._bridgeAddressesForUser(wallet.user_id),
    ]);
    const ignoredContracts = new Set(ignoredResult.rows.map((row) => row.contract_address));

    const rows = buildActivityRows(wallet.address, transfersResult.rows, { ignoredContracts, bridgeAddresses });
    await this._nameCounterparties(wallet.user_id, rows);
    const written = await EthActivity.replaceForWallet(walletId, rows);

    logger.info({ walletId, activity: written }, 'ETH activity rebuilt');
    return { activity: written };
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

    const { rows } = await pool.query(
      `SELECT a.id, a.chain_id, a.block_time, a.category, a.legs
       FROM eth_activity a
       JOIN eth_wallets w ON w.id = a.wallet_id
       WHERE w.user_id = $1 AND a.category IN ('bridge_out', 'bridge_in')
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
// The pairing policy, exported pure so every bound (fee tolerance, window,
// direction, cross-chain requirement) is testable without a database.
module.exports.pairBridgeLegs = pairBridgeLegs;
module.exports.bridgeAsset = bridgeAsset;
module.exports.BRIDGE_MAX_FEE_BPS = BRIDGE_MAX_FEE_BPS;
module.exports.BRIDGE_DEPOSIT_WINDOW_MS = BRIDGE_DEPOSIT_WINDOW_MS;
module.exports.BRIDGE_WITHDRAWAL_WINDOW_MS = BRIDGE_WITHDRAWAL_WINDOW_MS;
