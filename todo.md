# Remaining work for a fully explained EVM history

Last reviewed: 2026-08-03 (autonomous completion pass)

## Definition of done

Every confirmed wallet and relevant chain has a provider-backed coverage
boundary; every non-spam event has an evidence-backed explanation; exchange,
bank, and bridge movements appear exactly once; balances, quantities, fees,
and prices reconcile; and every exception has a durable reason and source.
Nothing below is marked complete merely because a provider returned an empty
page or because a row has a note.

## Completed in the autonomous pass

- [x] Ran a read-only baseline and final audit for the configured account
      scope. The detailed manifest and unified-ledger export remain local,
      permission-restricted artifacts outside Git.
- [x] Retried the Polygon provider gaps. The provider timeout slots are now
      complete across the configured Polygon wallet scope.
- [x] Made the Base state-sync scanner ignore only well-formed, in-contract
      logs whose receiver is outside the requested wallet set. Malformed or
      wrong-contract logs still freeze the cursor and preserve the gap.
      Coverage now reports the actual Blockscout provider name for Base.
      Focused regression tests cover both paths.
- [x] Added a private, user-scoped exchange evidence report for every
      suggestion and unmatched deposit/withdrawal. Artifact:
      `/private/tmp/my-money-exchange-match-gaps.json` (0600, outside Git).
- [x] Re-ran the database-only derived pipeline (classification, holdings,
      mirrors, activity, exchange matching, bridges, fiat links, and existing
      stored-price valuation) without weakening match-v3 semantics.
- [x] Preserved all suggestions, unmatched exchange movements, and duplicate
      candidates. No ambiguous or merely amount/time/address-based row was
      auto-matched; no destructive duplicate merge was attempted.
- [x] Added an evidence-backed OpenSea Seaport 1.5 protocol label migration;
      existing built-in packs already cover EtherDelta, OpenSea/Wyvern, ENS,
      Uniswap/MetaMask, Polymarket CTF, bridge contracts, and legacy venue
      labels. Labels remain counterparty evidence only and never assert a sale
      or personal intent.

## User-gated work

- [ ] Add or confirm every wallet that is missing from the private inventory.
      Choose tracked, owned-but-untracked, exchange, external/service, or
      unresolved; ownership cannot be inferred from activity.
- [ ] Deploy the pending migrations/code changes, then rerun the connected
      syncs in the app. This is intentionally not done in this pass because
      the user requested no push or deploy.
- [ ] Provide Coinbase Pro/closed-venue statements and any other export that
      the provider cannot expose through an API. Retain originals outside Git.
- [ ] Add read-only credentials for remaining venues, sync to account
      inception, and verify an authoritative provider balance snapshot.
- [ ] Supply exports for delisted symbols, staking/Earn, internal transfers,
      rewards, legacy fiat, Kraken forwarding/deposit history, and legacy
      Binance account/address assignment where APIs omit them.
- [ ] Confirm or reject all exchange suggestions and any discovered-wallet
      candidates. Only a transaction-hash identity or an explicit confirmed
      verdict can become an automatic match.
- [ ] Recover Changelly, ShapeShift, EtherDelta, custody, and other historical
      swap evidence where it exists; otherwise approve durable unknowns.
- [ ] Explicitly authorize sending ledger-derived asset/date queries to public
      price providers before running the historical price backfill. Existing
      stored prices were revalued; no new private-data egress was performed.

## Autonomous residuals with durable evidence

- [ ] Base state-sync still has failed wallet/feed cursors from block 0.
      The public Base log walk is bounded and fail-closed, but its current
      provider throughput makes the full historical scan impractical in one
      run; the failure receipt and unchanged cursor remain in
      `eth_feed_coverage`. A supported archive/RPC or a user-supplied export is
      required before this can be certified complete.
- [ ] OP Mainnet, Gnosis, and Base internal traces are explicitly
      `unsupported` by their public Blockscout feeds.
      Normal/token/NFT/ERC-1155/state-sync feeds remain separately reported;
      unsupported internal traces are never presented as complete.
- [ ] The final audit still contains explicit on-chain review rows, unmatched
      bridge legs, and quarantined spam rows. Notes and protocol labels do not
      clear a review verdict.
- [ ] Exchange deposit/withdrawal records and fallback suggestions remain
      unmatched under strict match-v3 semantics. The detailed private report
      is the evidence index; no match is inferred from proximity alone.
- [ ] Exchange balance exceptions and provider-limited account states remain
      open. Missing provider rows, dust, and closed-venue exports are the
      durable reasons; no balance was silently accepted.
- [ ] ETH reconciliation still has mismatch, skipped, and unavailable rows.
      Those rows are tied to provider receipts and must not be treated as
      zero.
- [ ] Some transfer legs remain unpriced. Most are malformed/spoofed symbols,
      spam assets, or assets unavailable from configured price sources; no
      symbol-only alias or zero price is invented. Contract-verified aliases
      and prices can be added after source evidence is supplied.
- [ ] Protocol-specific conservation/decoding for historical EtherDelta fills,
      OpenSea/Wyvern/Seaport consideration, ENS generations, router-level
      Uniswap/MetaMask swaps, Polymarket CTF outcomes, and legacy distributions
      remains review-only unless the transaction calldata/events provide the
      required evidence. The generic selector decoder is display-only.

## Verification and evidence package

- [x] Aggregate audit manifest generated with code revision, provider
      boundaries, exchange coverage, match/suggestion counts, bridge links,
      reconciliation statuses, price exclusions, and discovery receipts.
- [x] Private unified-ledger export generated alongside the final manifest;
      both are permission-restricted and excluded from Git.
- [x] Run the complete backend/frontend test, lint, build, and SQL verifier
      suite after the final code changes, then commit with a Conventional
      Commit. Backend: 1,007 tests passed; frontend: 189 tests passed; the SQL
      verifier passed all 88 checks. Do not push or deploy without explicit
      authorization.
- [ ] Close GitHub issues only when acceptance criteria are demonstrated by
      tests, production evidence, or an explicitly approved exception.
