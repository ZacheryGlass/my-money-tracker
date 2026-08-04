# Remaining work for a fully explained EVM history

Last reviewed: 2026-08-03 (evidence-first bridge implementation and read-only production dry run)

## Repository and deployment state

- Production is still running `1efcefc`.
- Local `main` has three prior unpushed commits; this pass adds a fourth local
  commit. Nothing from this pass has been pushed or deployed.
- The protocol-interpretation and bridge migrations/UI are therefore
  local-only. Production audit counts below describe deployed schema and
  evidence, not post-deployment interpretation or bridge-movement rows.

## Definition of done

Every confirmed wallet and relevant chain has a provider-backed coverage
boundary; every non-spam event has an evidence-backed explanation; exchange,
bank, and bridge movements appear exactly once; balances, quantities, fees,
and prices reconcile; and every exception has a durable reason and source.
Nothing is complete merely because a provider returned an empty page, an
address has a label, or a transaction has a note.

## Current evidence snapshot

- Production covers 21 configured wallet addresses over 9 chains (189
  wallet-chain scopes), 12,814 activity rows, and 3,963 exchange rows.
- The unified activity build has 459 derived review rows, including quarantined
  or overridden rows. The actionable private review index has 218 non-spam
  rows without a category override: 156 retain review despite a note, 48 need
  an ownership or intent decision, 11 have a named counterparty without enough
  category evidence, and 3 have only a display-only selector.
- Strict exchange matching has 0 automatic matches, 0 verdicts, and 43
  suggestions: 4 address-and-amount, 15 amount-and-time, and 24 ambiguous.
  There are 704 unmatched deposit/withdrawal records (241 deposits and 463
  withdrawals). This is correct under match-v3 until stronger evidence or a
  user verdict exists.
- Production still has 8 legacy amount/time bridge links and 3 unmatched legs.
  A read-only receipt dry run fetched complete public transaction envelopes for
  all 16 EVM candidates (plus 2 zkSync Lite archive candidates), but none of
  the 8 old links had a complete protocol-defined identity under bridge-match
  v1. All 8 therefore remain inconclusive and will migrate to ambiguous
  suggestions, not automatic folds. One legacy Gnosis destination and one
  zkSync Lite initiation decoded as pending halves without an exact opposite
  half. Of the 16 EVM receipt envelopes, 1 had a provider-proven finalized
  boundary and 15 had an explicit unknown-finality boundary; none was silently
  approximated from confirmation depth. Fiat evidence has 2 links and 2
  unmatched fiat records.
- ETH/token reconciliation has 195 matches, 13 mismatches, and 55 skipped
  rows. Exchange reconciliation has 10 open exceptions: Coinbase and Kraken
  remain mismatched, Coinbase Pro has no complete provider balance snapshot,
  and Binance.US reports a balance mismatch while its authoritative snapshot
  audit remains stale.
- Price coverage has 296 explicitly unpriced transfer legs: 69 are outside the
  stored price range, 213 belong to user-ignored assets, and 14 are quarantined
  spam evidence. None is represented as a zero price.
- Coinbase Pro fill and account statements were already imported. Exact
  cross-account replays were merged with provenance. Do **not** re-import those
  files and do not describe Coinbase Pro history as missing.

## Completed in this autonomous pass

- [x] Ran privacy-safe baseline and final production audits for user 1. Detailed
      hashes, addresses, quantities, and candidate identities remain only in
      permission-restricted files outside Git.
- [x] Ran the existing production wallet refresh using stored read-only
      credentials. Its derived pipeline refreshed holdings, stored-price
      valuation, mirrors, activity, strict exchange suggestions, bridge links,
      fiat links, and reconciliation while preserving notes, overrides,
      verdicts, provenance, quarantines, and user scoping.
- [x] Retried Polygon: all configured normal, internal, token, NFT, ERC-1155,
      and state-sync coverage slots are now complete.
- [x] Ran the existing production exchange refresh. All three connected API
      accounts completed without errors and imported no new rows; Coinbase and
      Kraken still reported balance mismatches. A second bounded pass advanced
      Binance.US to its provider boundary (`backfillPending=false`) without
      re-importing CSVs or adding duplicate rows; it now reports a balance
      mismatch, while the immutable reconciliation snapshot remains stale.
- [x] Added a private, user-scoped EVM evidence report covering every actionable
      review row, unmatched bridge leg, non-match reconciliation row, unpriced
      leg, open exchange exception, and flagged duplicate row.
- [x] Produced a fail-closed duplicate dry run. It found 484 exact same-account
      API/CSV pairs eligible under the existing resolver's strict preconditions.
      No row was deleted or merged because destructive data changes require
      explicit authorization. All ambiguous and same-source groups remain.
- [x] Added evidence-backed protocol interpretations for EtherDelta custody,
      OpenSea/Wyvern/Seaport NFT consideration, ENS name-token minting,
      Uniswap/MetaMask router swaps, Polymarket CTF ERC-1155 movement, and
      legacy fungible mints. Interpretations require both a source-bearing
      label and compatible normalized transfer evidence; they do not change
      category, review, spam, ownership, or intent.
- [x] Added bounded progressive backoff for chain-explorer HTTP 429 and
      rate-limit envelopes. Retries preserve cursors and cannot turn a failed
      or empty response into a completeness claim.
- [x] Preserved match-v3: only compatible transaction-hash identity or a prior
      confirmed verdict can become automatic. Address/amount and amount/time
      evidence remain suggestions, and ambiguous candidates match nothing.
- [x] Used only stored prices. No ledger-derived asset, address, or date was
      sent to a public price provider.
- [x] Researched and specified bridge-match v1 from first-party protocol
      contracts/docs for OP Stack, Arbitrum Classic/Nitro, Polygon PoS/Plasma,
      Gnosis xDAI/USDS, zkSync Era/Lite, Linea, and Across V2/V3. The evidence
      matrix, finality/reorg behavior, upgrade/version boundaries, API/UI
      states, and fail-closed rules are in `docs/bridge-matching-v1.md`.
- [x] Replaced automatic bridge amount/time pairing in local code. Automatic
      folding now requires a protocol-defined identity or a durable user
      confirmation. Address/asset/amount and amount/time evidence create only
      suggestions; every plausible alternative is retained and ambiguity
      matches none.
- [x] Added durable bridge endpoints, receipt envelopes and attempts,
      movements/members, suggestions, verdicts, lifecycle states, and database
      projection guards. Migration 072 converts old heuristic links to
      ambiguous suggestions before removing their folds. The database also
      rejects cross-user projections and rows that are not members of the
      verified movement.
- [x] Added exact v1 decoders where the researched evidence permits: OP Stack,
      Arbitrum Nitro, Linea, legacy Gnosis, zkSync Era deposits, zkSync Lite
      deposits, and Across V3. Polygon PoS/Plasma, Gnosis USDS Router, zkSync
      withdrawals, and Across V2 intentionally remain suggestion-only until
      stronger proof/calldata or deployment-version evidence is implemented.
- [x] Added bridge audit/verdict UI and atomic derived rebuild behavior. Pending,
      refunded, failed, unsupported, suggested, ambiguous, protocol-verified,
      and user-confirmed states remain distinct and visible.
- [x] Added a fail-closed finality gate. Protocol identity can fold only after
      both EVM receipt blocks are at or below provider-reported `finalized`
      heads. No confirmation-count approximation is used; providers without
      the standard tag leave exact pairs pending. Official committed zkSync
      Lite archive records carry an explicit archive-finality boundary.

## Local implementation awaiting authorization to publish

- [ ] Push/deploy the local protocol-interpretation and evidence-first bridge
      migrations, UI, private gap reporter, and explorer backoff. The local
      commit must remain unpushed until the user explicitly authorizes it.
- [ ] After deployment, run one wallet rebuild so stored activity rows receive
      the new protocol interpretations and bridge receipt scan, then retry Base
      with the new backoff and regenerate the private audit. A code-only local
      audit cannot make undeployed derived tables appear in production data.
- [ ] After migration, review the 8 imported legacy bridge suggestions. The
      receipt dry run proved none eligible for automatic v1 folding; they need
      stronger protocol evidence or an explicit confirm/reject verdict.

## Evidence-gated or user-gated residuals

- [ ] Confirm the wallet inventory. Any missing wallet must be supplied or
      classified as tracked, owned-but-untracked, exchange, external/service,
      or unresolved; ownership cannot be inferred from activity.
- [ ] Confirm or reject the 43 exchange suggestions and any future discovered-
      wallet candidates. Proximity alone is not a match.
- [ ] Review the 218 actionable on-chain rows. A note explains context but does
      not constitute a category verdict.
- [ ] Decide whether to authorize the exact 484-group duplicate merge after
      reviewing the private dry run. The resolver will re-check ownership,
      fingerprints, source identity, conflicts, and dependencies under a
      transaction before deleting anything.
- [ ] Supply provider exports only for genuine API omissions: delisted symbols,
      staking/Earn, internal transfers, rewards, old Binance.US fiat history,
      legacy Binance address assignment, Kraken forwarding/deposit evidence,
      and closed historical services. Original exports stay outside Git.
- [ ] Recover transaction receipts or exports for Changelly, ShapeShift,
      EtherDelta fills, and other historical custody/swap activity where they
      exist; otherwise explicitly accept a durable unknown.
- [ ] Explicitly authorize private asset/date egress before any public
      historical-price lookup. Until then, only stored prices may be applied.

## Provider and reconciliation boundaries

- [ ] Base is not complete. The latest public explorer attempt returned HTTP
      429 for 19 of 21 wallets on normal/internal/token/NFT/ERC-1155 feeds and
      for all 21 state-sync slots. Stored rows and cursors were preserved and
      failure receipts remain authoritative. Two wallets retained complete
      account-feed boundaries. The local retry improvement is not deployed.
- [ ] OP Mainnet internal traces are complete for 16 wallets and explicitly
      unsupported for 5; Gnosis internal traces are complete for 9 and
      unsupported for 12. The remaining public feeds are separately complete.
      Trace/debug availability depends on the provider or node configuration;
      archive/trace access or a user export is still required where the public
      explorer does not expose the feed.
- [ ] Resolve 13 ETH/token reconciliation mismatches and 55 skipped rows only
      after their failed/feed-gap/lookup-budget receipts are closed. They must
      not be treated as zero balances.
- [ ] Resolve the 10 exchange balance exceptions with complete provider
      snapshots or source exports. Documented dust and opening-balance evidence
      remains an exception, not a silently accepted match.
- [ ] Resolve the 3 currently unmatched bridge legs and the 8 legacy-link
      suggestions only with a protocol identity, missing compatible opposite
      evidence, or an explicit user verdict. Amount/time proximity is not
      enough. The current dry run also leaves one decoded Gnosis destination
      and one zkSync Lite initiation pending because their exact opposite
      evidence is absent from the tracked history.
- [ ] Extend automatic bridge support only when exact evidence is available:
      Polygon PoS/Plasma proof/state-sync identity, Gnosis USDS Router,
      zkSync Era/Lite withdrawals, and Across V2's block-bounded ABI/partial-
      fill model. Until then those paths must remain suggestions or unsupported.
- [ ] Add a finality-capable read-only provider for Ethereum, Polygon,
      Arbitrum, and Linea if protocol-exact pairs on those chains should fold
      automatically. Their configured Etherscan proxy returns no standard
      `finalized` block, so exact pairs remain pending unless the user confirms
      them. OP Mainnet, Base, Gnosis, and zkSync Era public RPCs expose the
      finalized tag.
- [ ] Keep the 296 unpriced legs explicit. Contract-verified aliases and stored
      prices may be added when reliable local evidence exists; malformed,
      spoofed, ignored, spam, NFT, and unavailable assets remain marked as such.

## GitHub issue closure review

No crypto issue currently demonstrates all of its acceptance criteria, so the
closure list is empty. Do not close issues automatically.

- [ ] #66 OpenSea: keep open until all relevant eras are decoded and remaining
      review rows are evidence-resolved.
- [ ] #67 ENS: keep open until all generations and remaining unexplained rows
      are covered.
- [ ] #68 EtherDelta: keep open until internal venue fills reconcile, not only
      custody deposits and withdrawals.
- [ ] #70 legacy Binance: keep open until source history and address assignment
      are complete or an explicit unavailable verdict is accepted.
- [ ] #72 wallet discovery: keep open until production evidence surfaces or
      explicitly clears real candidates; code and synthetic tests alone are
      insufficient.
- [ ] #75 fiat matching: keep open while 2 fiat records remain unmatched.
- [ ] #76 provider/state-sync reliability: keep open until Base coverage is
      proved after deployment and repeated full-suite runs remain green.

## Verification and private evidence

- [x] Backend tests: 1,014 passed in a serialized full run. The first parallel
      run had one transient localhost test-port collision and its isolated
      rerun passed 73/73.
- [x] Backend lint: passed.
- [x] Frontend tests: 193 passed (existing React `act(...)` warnings only).
- [x] Frontend lint: passed with 12 existing TanStack/React Compiler warnings
      and no errors.
- [x] Frontend production build: passed.
- [x] Ledger SQL verifier: both migration passes and all 92 checks passed.
- [x] Final aggregate audit and detailed evidence manifests were written under
      `/private/tmp` with mode 0600:
      `my-money-evm-final-2026-08-03.json`,
      `my-money-evm-gaps-final-2026-08-03.json`,
      `my-money-exchange-match-final-2026-08-03.json`,
      `my-money-exchange-duplicates-final-2026-08-03.json`, and
      `my-money-exchange-duplicate-resolution-dry-run-final-2026-08-03.json`.
- [x] Bridge-specific private artifacts were written with mode 0600:
      `/private/tmp/my-money-bridge-baseline-2026-08-03.json`,
      `/private/tmp/my-money-bridge-final-2026-08-03.json`, and
      `/private/tmp/my-money-bridge-legacy-evidence-2026-08-03.json`.
      The final aggregate audit explicitly reports
      `evidence_model_available=false` because production is undeployed.
