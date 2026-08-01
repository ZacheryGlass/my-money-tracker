# Remaining work for a fully explained EVM history

Last reviewed: 2026-08-01

## Definition of done

Every confirmed wallet and relevant chain has a provider-backed coverage
boundary; every non-spam event has an evidence-backed explanation; exchange,
bank, and bridge movements appear exactly once; balances, quantities, fees,
and prices reconcile; and every exception has a durable reason and source.

## User-gated work

- [ ] Add or confirm every wallet that is missing from the private inventory.
      For each candidate, choose tracked, owned-but-untracked, exchange,
      external/service, or unresolved. Do not infer ownership from activity.
- [ ] Provide any Coinbase Pro/Exchange statement or other closed-venue export
      that the provider cannot expose through an API. Import it and retain the
      original file outside Git.
- [ ] Add read-only credentials for each remaining exchange, run the complete
      backfill to account inception, and verify the provider balance snapshot.
- [ ] Supply exports for delisted symbols, staking/Earn, internal transfers,
      rewards, or fiat history that an API explicitly omits.
- [ ] Confirm the historical Kraken forwarding/deposit address and any
      legacy Binance.com account/address assignment.
- [ ] Review and confirm/reject every exchange match suggestion and every
      discovered-wallet candidate.
- [ ] Recover Changelly, ShapeShift, EtherDelta, and other historical swap or
      custody evidence where available; approve durable unknowns where it is
      genuinely unobtainable.

## Autonomous engineering and analysis

- [x] Extend the source-backed asset registry for verified native/provider
      identities; unregistered symbols remain unmatched. Further ERC-20
      contract entries still require verified source material.
- [ ] Add protocol-aware decoding/conservation for EtherDelta internal fills,
      OpenSea/Wyvern/Seaport, ENS generations, Uniswap/MetaMask routers,
      Polymarket CTF activity, and legacy distribution contracts.
- [x] Extend discovery across native and ERC-20 feeds with bounded depth,
      per-provider budgets, contract/high-traffic/dust filters, and durable
      complete/failed/truncated receipts. NFT-specific discovery remains open.
- [x] Add exact-amount/business-day Plaid matching and show linked
      bank/exchange evidence in unified ledger details. A review screen for
      unmatched fiat candidates and explicit bank-side adjudication remains.
- [ ] Complete provider coverage for unsupported or failed feeds (Base state
      sync, OP/Gnosis/Base internal traces, zkSync/other explorer gaps) or
      record a durable source/export exception for each.
- [ ] Re-run all wallet activity classification, bridge grouping, exchange
      matching, transaction mirrors, historical prices, valuation, and native/
      token/exchange reconciliation after the final source set is present.
- [ ] Resolve every economically meaningful price gap and verify aliases such
      as ETH/WETH, POL/MATIC, XDAI/DAI, USDC/USDC.e, and pUSD with a source.
- [ ] Review every remaining unmatched, quarantined, unpriced, skipped, and
      mismatched row; preserve evidence and keep a note separate from a
      classification verdict.

## Final evidence package

- [x] Generate a privacy-safe aggregate manifest with code revision, wallet /
      chain / feed boundaries, provider limitations, exchange coverage,
      unavailable accounts, bridge groups, review counts, reconciliation
      statuses, price exclusions, discovery receipts, and optional
      archive-audit results (`npm run audit:history`).
- [ ] Export the unified ledger and manifest with generation time; mechanically
      assert that each completion gate is satisfied.
- [ ] Close GitHub issues only when their acceptance criteria are demonstrated
      by tests, production evidence, or an explicitly approved exception.

## Current implementation baseline

The application now has strict exchange-match v3 policy, durable notes and
labels, exchange fiat links, legacy-record-unavailable annotations, bounded
discovery expansion, EtherDelta custody labeling, source-backed native asset
identity matching, and exact-decimal/idempotent imports. Remaining items above
are intentionally not claimed complete by a successful sync or an empty queue.
