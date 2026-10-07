Run tests from the `backend/` directory with `npm test`. Uses Node's built-in `node:test` runner with `supertest` for HTTP assertions — no extra test framework needed. The `pg` Pool is mocked via `require.cache` injection so no database is required; the 401 test additionally swaps the `../config/database` cache entry to return empty rows, simulating a missing user. Any test that requires real database behavior (e.g. verifying actual SQL queries) must set `DATABASE_URL` and connect to a live PostgreSQL instance.

Real-PostgreSQL harnesses (throwaway cluster, never `DATABASE_URL`; CI runs all three):

```bash
npm run verify:ledger       # ledger/fiat/bridge SQL; migrations adopted, then re-run (--rerun-all)
npm run verify:derivation   # the derived pipeline end to end, crash and concurrency cases
npm run verify:migrations   # tracked runner: adoption, zero-file second boot, rollback drill, drift
```
