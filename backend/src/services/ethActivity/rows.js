'use strict';

// One transaction's legs -> one eth_activity row body, and a wallet's whole
// transfer history -> its activity rows. This is the assembly layer over the
// ladder (classify.js) and the quarantine (spam.js); still pure -- the
// orchestrating service owns every database read and write.

const { DEFAULT_CHAIN_ID } = require('../../config/chains');
const { toBigIntLenient, absBigInt, formatUnits } = require('../../utils/units');
const {
  weakestBasis, toCents, fromCents, tokenDecimalsFallbacks, assetOf, resolveCounterparty,
} = require('./legs');
const { classifyActivity } = require('./classify');
const {
  walletInitiated, spamContext, detectSpam, EMPTY_SPAM_INPUTS,
} = require('./spam');

// Pure: one transaction's eth_transfers legs -> one eth_activity row body.
function buildActivityRow(wallet, chainId, txHash, legs, ignoredContracts, decimalsFallbacks = new Map(),
  spamInputs = EMPTY_SPAM_INPUTS, bridgeAddresses = new Set()) {
  const gasLegs = legs.filter((leg) => leg.transfer_type === 'gas');
  const feeWei = gasLegs.reduce((sum, leg) => sum + toBigIntLenient(leg.value_wei), 0n);

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
    if (incoming) entry.raw += toBigIntLenient(leg.value_wei);
    if (outgoing) entry.raw -= toBigIntLenient(leg.value_wei);

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
      amount_raw: absBigInt(entry.raw).toString(),
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

module.exports = {
  buildActivityRows,
};
