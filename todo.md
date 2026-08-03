# Remaining work for a fully explained EVM history

Last reviewed: 2026-08-03 (autonomous production refresh and local completion pass)

## Repository and deployment state

- Production is still running `1efcefc`.
- Local `main` contains `6b1b033` and the implementation commit `2a59bf1`;
  it is two commits ahead of `origin/main` and has not been pushed or deployed.
- The protocol-interpretation migration and UI are therefore local-only. The
  production audit counts below describe the deployed schema and existing
  evidence, not post-deployment protocol-interpretation rows.

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
- Bridge evidence has 8 links and 3 unmatched legs. Fiat evidence has 2 links
  and 2 unmatched fiat records.
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

## Local implementation awaiting authorization to publish

- [ ] Push/deploy the local protocol-interpretation migration, UI, private gap
      reporter, and explorer backoff. The local commit must remain unpushed
      until the user explicitly authorizes publication.
- [ ] After deployment, run one wallet rebuild so stored activity rows receive
      the new protocol interpretations, then retry Base with the new backoff
      and regenerate the private audit. A code-only local audit cannot make an
      undeployed derived column appear in production data.

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
- [ ] Resolve the 3 unmatched bridge legs only with a compatible opposite leg,
      bridge receipt, or explicit user evidence.
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

- [x] Backend tests: 1,017 passed.
- [x] Backend lint: passed.
- [x] Frontend tests: 190 passed (existing React `act(...)` warnings only).
- [x] Frontend lint: passed with 12 existing TanStack/React Compiler warnings
      and no errors.
- [x] Frontend production build: passed.
- [x] Ledger SQL verifier: both migration passes and all 88 checks passed.
- [x] Final aggregate audit and detailed evidence manifests were written under
      `/private/tmp` with mode 0600:
      `my-money-evm-final-2026-08-03.json`,
      `my-money-evm-gaps-final-2026-08-03.json`,
      `my-money-exchange-match-final-2026-08-03.json`,
      `my-money-exchange-duplicates-final-2026-08-03.json`, and
      `my-money-exchange-duplicate-resolution-dry-run-final-2026-08-03.json`.
