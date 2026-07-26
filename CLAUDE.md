# CLAUDE.md

## Project Overview

**my-money-tracker** — personal portfolio tracker. Node.js/Express backend, React/Vite frontend (JSX, not TypeScript), PostgreSQL, Tailwind CSS 4. Multi-user with fully isolated data: production auth is Azure App Service Easy Auth with Google sign-in (identity read from `x-ms-client-principal-*` headers, gated by `ALLOWED_PRINCIPALS`); an allowlisted email's first sign-in auto-provisions a user via `user_identities` (one person can map several emails to one user — both of the original owner's emails point at user 1). Local dev stubs identity (`DEV_AUTH_USER_ID`/`DEV_AUTH_USERNAME`; the stub ensures the users row exists, so `DEV_AUTH_USER_ID=2` simulates a second user). `/mcp` is protected by an `MCP_API_KEY` bearer token that maps to user 1; `FinancialQueryService` methods all REQUIRE a userId and throw without one.

## Quick Start

```bash
# First time: bootstrap DB, .env files, deps, migrations (migrations seed user 1)
./scripts/setup-local.sh    # run in Git Bash (not WSL)

# Start both servers (double-click or run from any terminal)
python scripts/dev.py       # backend :3000, frontend :5173/private/

# No login locally; dev identity is stubbed in backend/src/middleware/auth.js
```

## Architecture

- **Backend**: Express 5, CommonJS, pino logging, pino-http request IDs, express-rate-limit, node-cron scheduled jobs
- **Frontend**: React 19, Vite 7, Tailwind CSS 4, Recharts (all charts), TanStack Table, React.lazy code splitting
- **Design**: "AVE Workbench" — VSCode-inspired dark workbench. CSS custom properties in `index.css`, mapped to Tailwind via `tailwind.config.js`. System fonts (UI) + Consolas (financial numbers). Primary: #297AA0, canvas: #191A1B, editor: #121314. Dense 13px UI, 1px borders, square panels. See `DESIGN.md` for full spec.
- **Layout**: Sidebar navigation (not top nav), state-based routing (no React Router in production)
- **Serving**: backend serves `backend/public/` (public landing) at `/` and the built React app at `/private` (Vite `base: '/private/'`). Azure Easy Auth gates `/private` and `/api` in production; `/` and `/mcp` are excluded.

## Project Structure

```
backend/src/
  config/       # database.js, logger.js (pino)
  models/       # DB query functions
  services/     # business logic (prices, snapshots)
  routes/       # Express route handlers
  jobs/         # Scheduled tasks (cron)
  middleware/   # auth, error handling
  server.js     # entry point

frontend/src/
  components/   # Sidebar, Dashboard, DashboardTable, DashboardNetWorthChart,
                # MetricCard, AllocationDonut, SparkLine, ChartTooltip,
                # AccountHistoryChart, TickerHistoryChart, HoldingForm,
                # BulkImportForm, ErrorBoundary, FilterTabs, FilterDisclosure,
                # LoadingState, SummaryStats, ResponsiveContainer
  pages/        # BalancesPage (Assets/Cash/Liabilities tabs), AccountsPage,
                # Settings, Spending, HoldingsAnalysis, PortfolioTimeline,
                # AccountHistory, TickerHistory, SalaryHistory, MonthlyExpenses,
                # ErrorPage, NotFound
  hooks/        # useAppearancePreferences, useMediaQuery, useTransientMessage
  utils/        # api.js (axios), format.js (shared formatters), dataLabels.js,
                # accountDisplay.js, chartTheme.js

scripts/
  setup-local.sh  # one-time local env bootstrap
  dev.py          # start both servers, kills children on exit
```

## Commands

```bash
# Backend
cd backend && npm run dev       # dev server (nodemon)
cd backend && npm run migrate   # run migrations
cd backend && npm test          # node:test + supertest
cd backend && npm run lint      # eslint

# Frontend
cd frontend && npm run dev      # vite dev server
cd frontend && npm run build    # production build
cd frontend && npm test         # vitest
cd frontend && npm run lint     # eslint
```

## Key Patterns

- **API interceptor** (`frontend/src/utils/api.js`): same-origin requests (Easy Auth session cookie), retries on 5xx (once, 500ms), reloads page on 401 so Easy Auth re-authenticates
- **Shared formatters** (`frontend/src/utils/format.js`): `formatCurrency`, `formatPercent`, `formatDateDisplay`, `formatDateAxis`, `formatCompactCurrency`, `formatRelativeTime` — all components import from here, no local duplicates. Category labels in `utils/dataLabels.js`.
- **Shared UI**: `FilterTabs` (single-choice control — tab strip on desktop, dropdown on mobile; used by Balances, Settings, Accounts, Spending), `DataTable`/`DataTablePagination` (TanStack table shell — used by Balances, Accounts), `LoadingState` (all loading spinners), `useTransientMessage` (auto-clearing success messages)
- **Chart theme** (`frontend/src/utils/chartTheme.js`): `CHART_COLORS`, `GRID_STYLE`, `AXIS_STYLE`, `TOOLTIP_STYLE`, `areaGradient` — all charts use these
- **Design tokens**: CSS variables in `index.css` (canvas/surface hierarchy, ink/body/muted text, primary action blue, gain/loss semantics, hairline borders) consumed by Tailwind config. Component classes: `.card`, `.font-money`. Square panels with 1px borders, 4px radius on buttons/inputs only.
- **Multi-user scoping**: ownership lives on root tables only (`accounts`, `plaid_items`, `eth_wallets`, `salary_history`, `recurring_expenses`, `ignored_merchants`, `eth_ignored_tokens`, `eth_address_labels` — nullable there, NULL = shared builtin). Children (holdings, transactions, snapshots, trades, tax lots, eth_transfers, …) inherit via `JOIN accounts a … AND a.user_id = $n`. Mutations use `WHERE id = $1 AND user_id = $2` → foreign ids 404. Scoped model reads are fail-closed (a missing userId throws); cross-user reads use the explicit `findAllForJobs` entry points (`Holding`, `EthWallet`, `PlaidItem`) and belong only to jobs. Shared/global by design: `price_cache`, `benchmark_prices`, `security_master`, `job_logs`, `eth_method_signatures`. Auth resolves users through `user_identities` with a 5-min in-process cache and auto-provisions allowlisted emails.
- **API keys** (Settings → API Keys, `routes/keys.js` + `services/SecretsService.js`): per-user Plaid client ID/secret and Etherscan key in `user_api_keys`; shared CoinGecko/CMC keys in `app_settings` (admin-only, managed from the Server tab). AES-256-GCM encrypted with `SECRETS_ENCRYPTION_KEY` (32-byte base64); resolution is DB value → env var → null; masked statuses only ever reach the client (stored `last4`). Without `SECRETS_ENCRYPTION_KEY` the app is env-only and key writes 503. Plaid clients come from `config/plaid.js` `getPlaidClientForUser`; Etherscan keys are threaded through `EtherscanService` per request.
- **Admin panel** (Settings → Server tab, `routes/admin.js`, gated by `requireUser.requireAdmin`): user 1 is the sole admin (`users.is_admin`, seeded by migration 030, no grant UI). Shows shared market-data keys, an env overview (secrets as masked last-4 only — full values never leave the server, and `SECRETS_ENCRYPTION_KEY` reports set/valid with no last-4 at all), a view-only users list, job schedules with Run Now buttons, and health. Tab visibility comes from `/api/me`'s `isAdmin`, not from probing the admin API. Non-admins never see the tab and get 403 from `/api/admin/*` and from shared-key writes.
- **Scheduled jobs**: Plaid sync 7:30, expense sync 7:45, ETH wallet sync 7:50, price updates 8:00, benchmark prices (SPY/QQQ) 8:30, snapshots 9:00 (all UTC). Controlled by `RUN_SCHEDULED_JOBS`. Plaid/eth syncs resolve each item/wallet OWNER's credentials and skip-and-log unconfigured owners; expense sync iterates users; price/benchmark/snapshot jobs stay global. `POST /api/jobs/trigger/*` is admin-only (these jobs touch every user's data with each owner's credentials) except `price-update`, which any user may run because `price_cache` is shared and the Dashboard refresh calls it.
- **Ethereum wallets**: Etherscan V2 integration mirrors the Plaid shape (`services/EthWalletService.js`, `routes/eth.js`, `jobs/ethSyncJob.js`). Raw transfers land in `eth_transfers` (counterparty classified self/exchange/external — both sets scoped to the wallet OWNER: self from the owner's wallets UNION their `kind='own'` labels, exchange from the owner's `kind='exchange'` labels plus shared builtins seeded in migration 029, user label shadows builtin, own beats exchange), balances become a `crypto` account with an ETH holding + NULL-ticker token holdings, and activity is mirrored into `transactions` via `eth_transfer_id` with `CRYPTO_*` categories (`CRYPTO_EXCHANGE_DEPOSIT`/`_WITHDRAWAL` classify as internal transfers). Token symbols never enter `price_cache`. A txlist row's `methodId`/`functionName` ride on exactly one leg per tx: the native leg when ETH moved, else the gas leg (zero-value calls -- approve, token swaps -- emit no native leg but their calldata still originated from the wallet). Selectors Etherscan cannot name are decoded during sync (never at request time, bounded by a lookup cap and a 30s deadline) via Sourcify's signature database, then 4byte.directory, cached in the global `eth_method_signatures` including MISSES so each selector is fetched at most once ever -- but an off-shape 200 counts as a transport failure, never a cached miss. A decoded name is a low-confidence display hint (selector collisions are mined deliberately) and must never feed classification. Method capture is FORWARD-ONLY: rows ingested before migration 034 keep NULL method columns (the decode pass names stored selectors, it cannot invent them); a full re-capture requires removing and re-adding the wallet, which restarts ingest from block 0. Disconnecting with `removeData=false` detaches the account but keeps its row and name, so `addWallet` re-attaches (and un-hides) that account instead of inserting a duplicate — the account name is unique per user, and re-attaching is what preserves the history "keep data" was for.
- **Counterparty triage** (Settings → Ethereum → Needs Review, `GET /api/eth/counterparties/unreviewed`): `eth_address_labels.kind` (migration 032) makes a label mean "reviewed, with a verdict" rather than "is an exchange" — `exchange` | `external` (reviewed third party, changes nothing) | `own` (the user's untracked address; strictly user-scoped, no builtin fallback). The queue is every counterparty with no label row of any kind, minus gas rows, failed transfers, own counterparties, ignored-token transfers and contract creations — so it drains monotonically; a static hot-wallet seed can't keep up with exchanges rotating addresses, and an unlabeled one silently reads as real spending. `EthWalletService.refreshClassificationsForUser()` re-derives that owner's rows, so labeling heals all history retroactively. Badge counts material rows only (`usd_volume >= min_usd OR sent_count > 0`) — a badge that can't reach zero gets ignored. **Traps**: (1) in `reclassifyCounterparties`' second UPDATE, `kind` is tested in the projection CASE, never the WHERE — filtering there lets a builtin `exchange` outrank a user's `external` override; (2) `upsert` takes a NULL `kind` as "keep the current verdict" (defaulting to `exchange` only on insert), because a rename sends no kind and must not silently re-vote; (3) the queue orders `material DESC` before `usd_volume DESC`, or an unpriced outbound counterparty sorts below every one-cent airdrop and pages out from under its own badge.
- **Migrations re-run on every boot** (no tracking table): every statement must be idempotent, constraint swaps need catalog-guarded DO blocks, and seeds live where their conflict targets exist (001's account seed and 026's builtin-label seed moved to 029).

## Database

Tables: `accounts`, `holdings`, `price_cache`, `ticker_snapshots`, `account_snapshots`, `users`, `user_identities`, `user_api_keys`, `app_settings`, `eth_wallets`, `eth_transfers`, `eth_ignored_tokens`, `eth_address_labels`, `eth_method_signatures`. Migrations in `backend/migrations/`.

## Environment Variables

Backend `.env`: `DATABASE_URL`, `ALLOWED_PRINCIPALS` (prod only), `MCP_API_KEY`, `SECRETS_ENCRYPTION_KEY` (enables DB-stored API keys), `CMC_PRO_API_KEY`, `CG_API_KEY`, `ETHERSCAN_API_KEY`, `PLAID_CLIENT_ID`/`PLAID_SECRET`/`PLAID_ENV` (env values are fallbacks below DB-stored keys), `PORT`, `NODE_ENV`, `RUN_SCHEDULED_JOBS`, `DEV_AUTH_USER_ID`/`DEV_AUTH_USERNAME` (dev identity)

Frontend `.env`: `VITE_API_URL` (empty = same origin)

## Open Work

- **Azure deployment** (GitHub issues #22-25): PostgreSQL, App Service, Static Web Apps, SSL/domain — all deferred
- **Testing**: 246 backend (node:test + supertest, fake pg Pool via require.cache) and 24 frontend (vitest) — broad on scoping/secrets/admin, thin on charts and analytics
