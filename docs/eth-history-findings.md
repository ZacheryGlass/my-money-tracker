# ETH ledger history findings

The ETH ledger's **Coverage and balance limitations** section combines existing
wallet feed/audit evidence with dated, account-specific history assessments.
Assessments are saved observations, not live checks or completeness verdicts.
Counts cover the full selected account history, regardless of ledger pagination.
Categories can overlap. Unmatched recorded transfers are not missing transactions.

Migration `096_eth_history_findings.sql` adds nullable JSONB assessments to
`exchange_accounts` and `eth_wallet_chains`. Ownership is inherited from those
accounts and wallets. `EthLedger` exposes them as `scopes[].history_findings`;
ledger entries, running balance arithmetic and audit adjustments are unchanged.
Normal imports, syncs and derived rebuilds do not overwrite these assessments.

## Import reviewed evidence

Keep the source report and prepared manifest outside version control, mode 0600.
No personal evidence belongs in migrations, source code or test fixtures. After
running the normal migrations, run from `backend/`:

```sh
node scripts/import-eth-history-findings.js --user 9001 --file /absolute/private/findings.json
node scripts/import-eth-history-findings.js --user 9001 --file /absolute/private/findings.json --apply
```

The first command is a dry run. The example user ID is synthetic; select the
actual owner explicitly and verify account identities against the source report
before importing. Every scope must exist and belong to that owner. A foreign or
missing scope rolls back the entire import. Older evidence cannot replace a newer
assessment. Imports make no provider calls and update only the assessment columns.
Reimporting the same manifest is safe. Preserve earlier manifests privately when
replacing an assessment so the evidence remains recoverable.

Manifest structure (synthetic):

```json
{
  "user_id": 9001,
  "scopes": [{
    "scope": "exchange:42",
    "observed_at": "2025-01-01T00:00:00Z",
    "issues": [{
      "kind": "missing_history",
      "count": 1,
      "from": "2024-01-01T00:00:00Z",
      "through": "2024-02-01T00:00:00Z",
      "summary": "The retained statement has a discontinuity.",
      "evidence_needed": "An original statement spanning both boundaries."
    }]
  }]
}
```

Wallet scope syntax is `wallet:<wallet_id>:<chain_id>` for an existing ETH-native
network coordinate. Other kinds are `unmatched_transfer`, `fee_evidence`,
`balance_comparison`, `balance_evidence`, and `source_conflict`. Counts are positive
integers; unknown date boundaries are null. Event-group date spans are not claims
that everything between them is missing. Use the actual evidence observation time,
not the import time. An absent assessment or empty issue list never means history
has been verified. There is no inferred verified-period or automatic retry feature.

Validation: backend/frontend tests, lint and frontend build, plus
`npm run verify:ledger` in `backend/`. The SQL verification exercises both owner
boundaries, atomic rollback, dry runs, replay, and unchanged ETH arithmetic in an
isolated PostgreSQL cluster.
