# CLAUDE.md

## Project Overview

**my-money-tracker** — personal portfolio tracker. Node.js/Express backend, React/Vite frontend (JSX, not TypeScript), PostgreSQL, Tailwind CSS 4. Single-user. No in-app login: production auth is Azure App Service Easy Auth (identity read from `x-ms-client-principal-*` headers); local dev uses a stub identity. `/mcp` is protected by an `MCP_API_KEY` bearer token instead.

## Quick Start

```bash
# First time: bootstrap DB, .env files, deps, migrations, seed user
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
  components/   # Sidebar, Dashboard, DashboardTable, MetricCard, AllocationDonut,
                # SparkLine, ChartTooltip, AccountHistoryChart, TickerHistoryChart,
                # HoldingForm, BulkImportForm, StaticAssetsForm, ErrorBoundary
  pages/        # BalancesPage (Assets/Cash/Liabilities tabs), AccountsPage,
                # PortfolioTimeline, AccountHistory, TickerHistory, StaticAssets,
                # ErrorPage, NotFound
  utils/        # api.js (axios), format.js (shared formatters), chartTheme.js

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
- **Shared formatters** (`frontend/src/utils/format.js`): `formatCurrency`, `formatPercent`, `formatDateDisplay`, `formatDateAxis`, `formatCompactCurrency` — all components import from here, no local duplicates
- **Chart theme** (`frontend/src/utils/chartTheme.js`): `CHART_COLORS`, `GRID_STYLE`, `AXIS_STYLE`, `TOOLTIP_STYLE`, `areaGradient` — all charts use these
- **Design tokens**: CSS variables in `index.css` (canvas/surface hierarchy, ink/body/muted text, primary action blue, gain/loss semantics, hairline borders) consumed by Tailwind config. Component classes: `.card`, `.font-money`. Square panels with 1px borders, 4px radius on buttons/inputs only.
- **Scheduled jobs**: Plaid sync 7:30, price updates 8:00, benchmark prices (SPY/QQQ) 8:30, snapshots 9:00 (all UTC). Controlled by `RUN_SCHEDULED_JOBS` env var

## Database

Tables: `accounts`, `holdings`, `price_cache`, `ticker_snapshots`, `account_snapshots`, `users`. Migrations in `backend/migrations/`.

## Environment Variables

Backend `.env`: `DATABASE_URL`, `MCP_API_KEY`, `CMC_PRO_API_KEY`, `CG_API_KEY`, `PORT`, `NODE_ENV`, `RUN_SCHEDULED_JOBS`

Frontend `.env`: `VITE_API_URL` (empty = same origin)

## Open Work

- **Azure deployment** (GitHub issues #22-25): PostgreSQL, App Service, Static Web Apps, SSL/domain — all deferred
- **Testing**: minimal (6 backend smoke tests, 1 frontend smoke test) — expand coverage
