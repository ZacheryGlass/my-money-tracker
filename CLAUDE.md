# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**my-money-tracker** is a web application for personal portfolio tracking, replacing the legacy Google Sheets-based system. It provides a modern interface for managing investment holdings across multiple accounts, automatically fetching cryptocurrency prices, maintaining historical snapshots, and visualizing portfolio performance over time.

**Architecture**: Node.js/Express backend, React/TypeScript frontend, PostgreSQL database, deployed to Azure.

## Core Functionality

### Holdings Management
Users manually enter investment holdings in a simple web interface. Each holding has:
- **Ticker** (optional, for securities and crypto only)
- **Name** (e.g., "Bitcoin", "Vanguard Total Stock")
- **Account** (Crypto, HSA, Taxable, 401k, Roth IRA)
- **Quantity** (number of shares/coins)
- **Category** (Crypto, Securities, Real Estate, Debt)

**Static Assets**: Real estate and liabilities are managed separately (no ticker, just manual values).

### Automated Price Updates
Daily scheduled job (8 AM) fetches crypto prices using waterfall strategy:
1. Try Coinbase API
2. Fall back to CoinGecko API (with 6-hour cached ID mapping)
3. Fall back to CoinMarketCap API

Prices stored in `price_cache` table, used to calculate current holding values.

### Daily Snapshots
Automated job (9 AM) creates time-series snapshots:
- **Ticker snapshots**: Current value of each holding (quantity × latest price)
- **Account snapshots**: Total value of each account
- Used to build historical charts and portfolio performance tracking

### Dashboard View
Consolidated summary of all assets and liabilities:
- All holdings sorted by value (descending)
- Filters out holdings < $100
- Shows portfolio total
- Color-coded by type (assets green, liabilities red)
- Last updated timestamp

## Database Schema

Core tables (see migrations for full schema):
- **accounts**: Crypto, HSA, Taxable, 401k, Roth IRA (plus Real Estate, Liability for static assets)
- **holdings**: Current position in each account (ticker, name, quantity, category)
- **price_cache**: Latest prices for each ticker symbol
- **ticker_snapshots**: Daily historical values by ticker/account
- **account_snapshots**: Daily total values by account
- **users**: Single-user authentication (you)

## Project Structure

```
my-money-tracker/
├── backend/                    # Node.js/Express API server
│   ├── src/
│   │   ├── config/            # Database & app configuration
│   │   ├── models/            # Database query functions
│   │   ├── services/          # Business logic (price fetching, snapshots, etc.)
│   │   ├── routes/            # Express route handlers
│   │   ├── jobs/              # Scheduled tasks (cron jobs)
│   │   ├── middleware/        # Auth, error handling, logging
│   │   └── server.js          # Express app entry point
│   ├── migrations/            # Database schema migrations
│   ├── scripts/               # One-off scripts (data migration, etc.)
│   ├── package.json
│   ├── .env                   # Environment variables (git-ignored)
│   └── .env.example           # Template for .env
│
├── frontend/                   # React/Vite application
│   ├── src/
│   │   ├── components/        # Reusable UI components
│   │   ├── pages/             # Full-page components (Login, Dashboard, etc.)
│   │   ├── services/          # API communication layer
│   │   ├── hooks/             # Custom React hooks (useAuth, useData, etc.)
│   │   ├── App.jsx            # Main app component with routing
│   │   └── main.jsx           # Entry point
│   ├── public/                # Static assets
│   ├── package.json
│   ├── vite.config.js
│   └── tailwind.config.js
│
└── docs/                      # Documentation
    ├── API.md                 # API endpoint documentation
    └── DEPLOYMENT.md          # Azure deployment guide
```

## Development Commands

### Backend Setup & Development
```bash
cd backend

# Install dependencies
npm install

# Setup environment
cp .env.example .env
# Edit .env with your API keys and database URL

# Run migrations
npm run migrate

# Start development server (auto-reload with nodemon)
npm run dev

# Run production build
npm start
```

### Frontend Setup & Development
```bash
cd frontend

# Install dependencies
npm install

# Setup environment
cp .env.example .env
# Set VITE_API_URL to backend URL

# Start development server (Vite)
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

### Database Management
```bash
# Connect to PostgreSQL
psql -h localhost -U user -d my_money

# Run all pending migrations
npm run migrate

# Rollback migration
npm run migrate:rollback
```

### Testing & Validation
```bash
# Backend: Run tests (when implemented)
npm run test

# Frontend: Run tests (when implemented)
npm run test

# Backend: Lint code
npm run lint
```

## Key Implementation Patterns

### Backend API Pattern
```javascript
// Route: /api/holdings
// Model: queries database
// Service: business logic (filtering, calculations)
// All routes protected by JWT authentication middleware
```

### Frontend State Management
- **AuthContext**: Global auth state (logged in, user info, token)
- **React Hooks**: Component-level state with useState/useReducer
- **Axios Interceptor**: Auto-attach JWT token to all API requests
- **React Query** (future): Data fetching and caching layer

### Scheduled Jobs
- **node-cron**: Schedule jobs with cron expressions
- **Price updates**: 0 8 * * * (8 AM daily, America/Mexico_City timezone)
- **Snapshots**: 0 9 * * * (9 AM daily, runs after prices)
- Jobs log execution to database and console

## API Keys & Secrets

All stored in `.env` file (never commit):
- **DATABASE_URL**: PostgreSQL connection string
- **JWT_SECRET**: For signing authentication tokens
- **CMC_PRO_API_KEY**: CoinMarketCap API key (already have)
- **CG_API_KEY**: CoinGecko API key (optional, uses free tier if not set)
- **NODE_ENV**: "development" or "production"

## Deployment Checklist (Phase 6)

**Backend to Azure App Service:**
- [ ] Create PostgreSQL Flexible Server on Azure
- [ ] Set all environment variables in App Service config
- [ ] Run migrations: `npm run migrate`
- [ ] Enable auto-deploy from GitHub (CI/CD)
- [ ] Monitor Application Insights

**Frontend to Azure Static Web Apps:**
- [ ] Set `VITE_API_URL` to backend URL
- [ ] Auto-deploy from GitHub
- [ ] Configure custom domain if desired

## Common Workflows

### Adding a New Feature
1. Create GitHub issue (check existing issues first)
2. Create feature branch: `git checkout -b feature/name`
3. Implement on backend (API endpoints) first
4. Implement on frontend (UI components)
5. Test locally (both services running)
6. Commit with conventional commit message: `feat: add feature name`
7. Push and create pull request

### Investigating Issues
1. Check backend logs: `npm logs` in Azure portal (or console in dev)
2. Check frontend console: DevTools Network/Console tabs
3. Check database: Query history tables if data-related
4. Check scheduled jobs: Look at database job_logs table

### Data Export/Import
- **Export**: Use endpoints `GET /api/export/holdings`, `GET /api/export/history`
- **Import**: Use `POST /api/holdings/bulk-import` with CSV
- Always backup database before large imports

## Testing Credentials

Single-user system. Credentials set up during Phase 2 (data migration).

## Phase Reference

See GitHub issues (https://github.com/ZacheryGlass/my-money-tracker/issues) for implementation phases:
- **Phase 1** (#1-5): Backend foundation
- **Phase 2** (#6-8): Data migration from Google Sheets
- **Phase 3** (#9-12): Scheduled jobs & automation
- **Phase 4** (#13-17): Frontend foundation
- **Phase 5** (#18-21): Historical charts
- **Phase 6** (#22-25): Azure deployment
- **Phase 7** (#26-30): Polish & refinement

## Important Notes

- **Timezone**: All scheduled jobs use America/Mexico_City timezone
- **Single-user**: No multi-user support (just for you)
- **Authentication**: JWT-based, can migrate to Azure AD later
- **Snapshots**: Created daily at 9 AM (after 8 AM price update)
- **History**: Ticker and account snapshots accumulate forever (design for long-term trending)
- **Price fallback**: Always tries multiple providers in order
- **Database backups**: Set up automated backups in Azure PostgreSQL
