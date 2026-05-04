# CLAUDE.md

## Project Overview

**my-money-tracker** — personal portfolio tracker. Node.js/Express backend, React/Vite frontend (JSX, not TypeScript), PostgreSQL, Tailwind CSS 4. Single-user, JWT auth.

## Quick Start

```bash
# First time: bootstrap DB, .env files, deps, migrations, seed user
./scripts/setup-local.sh    # run in Git Bash (not WSL)

# Start both servers (double-click or run from any terminal)
python scripts/dev.py       # backend :3000, frontend :5173

# Login: zachery / password
```

## Architecture

- **Backend**: Express 5, CommonJS, pino logging, pino-http request IDs, express-rate-limit, node-cron scheduled jobs
- **Frontend**: React 19, Vite 7, Tailwind CSS 4, Recharts (all charts), TanStack Table, React.lazy code splitting
- **Design**: "Dark Terminal Luxe" — CSS custom properties in `index.css`, mapped to Tailwind via `tailwind.config.js`. DM Sans (UI) + IBM Plex Mono (financial numbers). Accent: #00D4AA
- **Layout**: Sidebar navigation (not top nav), state-based routing (no React Router in production)

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
                # HoldingsTable, HoldingForm, BulkImportForm, StaticAssetsForm,
                # Login, ErrorBoundary
  pages/        # PortfolioTimeline, AccountHistory, TickerHistory, StaticAssets,
                # ErrorPage, NotFound
  utils/        # api.js (axios), format.js (shared formatters), chartTheme.js
  context/      # AuthContext
  hooks/        # useMediaQuery

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

- **API interceptor** (`frontend/src/utils/api.js`): auto-attaches JWT, retries on 5xx (once, 500ms), clears token on 401 (skips redirect for login endpoint itself)
- **Shared formatters** (`frontend/src/utils/format.js`): `formatCurrency`, `formatPercent`, `formatDateDisplay`, `formatDateAxis`, `formatCompactCurrency` — all components import from here, no local duplicates
- **Chart theme** (`frontend/src/utils/chartTheme.js`): `CHART_COLORS`, `GRID_STYLE`, `AXIS_STYLE`, `TOOLTIP_STYLE`, `areaGradient` — all charts use these
- **Design tokens**: CSS variables in `index.css` (bg-base, bg-surface, text-primary, accent, gain, loss, etc.) consumed by Tailwind config. Component classes: `.card`, `.card-hover`, `.font-money`, `.text-gain`, `.text-loss`
- **Scheduled jobs**: price updates 8 AM, snapshots 9 AM (America/Mexico_City). Controlled by `RUN_SCHEDULED_JOBS` env var

## Database

Tables: `accounts`, `holdings`, `price_cache`, `ticker_snapshots`, `account_snapshots`, `users`. Migrations in `backend/migrations/`.

## Environment Variables

Backend `.env`: `DATABASE_URL`, `JWT_SECRET`, `INITIAL_PASSWORD`, `CMC_PRO_API_KEY`, `CG_API_KEY`, `PORT`, `NODE_ENV`, `TZ`, `RUN_SCHEDULED_JOBS`

Frontend `.env`: `VITE_API_URL`

## Open Work

- **Azure deployment** (GitHub issues #22-25): PostgreSQL, App Service, Static Web Apps, SSL/domain — all deferred
- **Testing**: minimal (6 backend smoke tests, 1 frontend smoke test) — expand coverage
