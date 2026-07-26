'use strict';

const pool = require('../config/database');
const logger = require('../config/logger');
const EthWallet = require('../models/EthWallet');
const EthActivity = require('../models/EthActivity');
const { DEFAULT_CHAIN_ID } = require('../config/chains');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';


// The full category vocabulary (038's CHECK constraint carries the same list).
// A superset by design: later issues fill in exchange_trade (#61),
// staking_reward (#61), bridge_out/bridge_in (#59). 'spend' and 'approval' are
// reachable only through an override -- see classifyActivity.
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

// Pure: one transaction's eth_transfers legs -> one eth_activity row body.
function buildActivityRow(wallet, chainId, txHash, legs, ignoredContracts, decimalsFallbacks = new Map()) {
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
function buildActivityRows(walletAddress, transfers, { ignoredContracts = new Set() } = {}) {
  const wallet = String(walletAddress).toLowerCase();
  // Wallet-wide, before the grouping: the SQL partition this mirrors spans the
  // wallet, not the transaction.
  const decimalsFallbacks = tokenDecimalsFallbacks(transfers);
  const byTx = new Map();
  for (const transfer of transfers) {
    const chainId = transfer.chain_id ?? DEFAULT_CHAIN_ID;
    const groupKey = `${chainId}:${transfer.tx_hash}`;
    const existing = byTx.get(groupKey);
    if (existing) existing.legs.push(transfer);
    else byTx.set(groupKey, { chainId, txHash: transfer.tx_hash, legs: [transfer] });
  }
  return [...byTx.values()].map(({ chainId, txHash, legs }) =>
    buildActivityRow(wallet, chainId, txHash, legs, ignoredContracts, decimalsFallbacks));
}

class EthActivityService {
  // Deterministic full rebuild of one wallet's activity rows. Called after
  // every sync and every classification refresh, exactly like the ledger
  // mirror. Overrides live in their own table and are untouched here.
  static async rebuildForWallet(walletId) {
    const wallet = await EthWallet.findById(walletId);
    if (!wallet) throw new Error(`EthWallet ${walletId} not found`);

    const [transfersResult, ignoredResult] = await Promise.all([
      pool.query(
        'SELECT * FROM eth_transfers WHERE wallet_id = $1 ORDER BY block_number, id',
        [walletId]
      ),
      pool.query('SELECT contract_address FROM eth_ignored_tokens WHERE user_id = $1', [wallet.user_id]),
    ]);
    const ignoredContracts = new Set(ignoredResult.rows.map((row) => row.contract_address));

    const rows = buildActivityRows(wallet.address, transfersResult.rows, { ignoredContracts });
    await this._nameCounterparties(wallet.user_id, rows);
    const written = await EthActivity.replaceForWallet(walletId, rows);

    logger.info({ walletId, activity: written }, 'ETH activity rebuilt');
    return { activity: written };
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
