# my-money-tracker

A modern web application for personal portfolio tracking, replacing the legacy Google Sheets-based system.

## Features

- **Holdings Management**: Track investment holdings across multiple accounts (Crypto, HSA, Taxable, 401k, Roth IRA)
- **Automated Price Updates**: Daily scheduled jobs fetch cryptocurrency prices with automatic fallback between providers
- **Historical Snapshots**: Automatic daily snapshots of holdings and account values
- **Dashboard**: Consolidated view of all assets and liabilities with sorting and filtering
- **Authentication**: JWT-based authentication for secure API access

## Tech Stack

**Backend:**
- Node.js + Express
- PostgreSQL database
- node-cron for scheduled jobs
- JWT authentication with bcrypt

**Frontend:**
- React with Vite
- Tailwind CSS
- React Router
- TanStack Table (React Table v8)

**Deployment:**
- Azure App Service (backend)
- Azure Static Web Apps (frontend)
- Azure Database for PostgreSQL

## Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL 12+
- npm or yarn

### Backend Setup

```bash
cd backend

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your configuration
# Required:
# - DATABASE_URL: PostgreSQL connection string
# - JWT_SECRET: Secret key for JWT tokens
# - CMC_PRO_API_KEY: CoinMarketCap API key (optional)
# - CG_API_KEY: CoinGecko API key (optional)

# Run migrations to create database schema
npm run migrate

# Seed initial user (default: username=zachery, password=changeme123)
npm run seed

# Start development server (with hot reload)
npm run dev
```

Server will be available at `http://localhost:3000`

### Frontend Setup

```bash
cd frontend

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your API URL
# VITE_API_URL=http://localhost:3000

# Start development server
npm run dev
```

Frontend will be available at `http://localhost:5173`

## API Endpoints

### Authentication
- `POST /api/auth/login` - Login with credentials, returns JWT token
- `GET /api/auth/me` - Get current user info (requires auth)

### Holdings (all require authentication)
- `GET /api/holdings` - List all holdings
- `GET /api/holdings/:id` - Get single holding
- `POST /api/holdings` - Create new holding
- `PUT /api/holdings/:id` - Update holding
- `DELETE /api/holdings/:id` - Delete holding

### Health Check
- `GET /health` - Server health check

## Environment Variables

### Backend (.env)
```
PORT=3000
NODE_ENV=development
DATABASE_URL=postgresql://user:password@localhost:5432/my_money
JWT_SECRET=your-secret-key
CMC_PRO_API_KEY=your-coinmarketcap-key
CG_API_KEY=your-coingecko-key
TZ=America/Mexico_City
```

### Frontend (.env)
```
VITE_API_URL=http://localhost:3000
```

## Database

The application uses PostgreSQL with the following main tables:

- **users**: Authentication credentials
- **accounts**: Investment accounts (Crypto, HSA, Taxable, 401k, Roth IRA, Real Estate, Liability)
- **holdings**: Current investment positions
- **price_cache**: Latest prices for tickers
- **ticker_snapshots**: Historical ticker values (daily)
- **account_snapshots**: Historical account totals (daily)

## Development Workflow

1. Create a feature branch: `git checkout -b feature/your-feature`
2. Make your changes
3. Implement on backend first (API endpoints)
4. Then implement on frontend (UI components)
5. Test locally with both services running
6. Commit with conventional commits: `feat:`, `fix:`, `docs:`, etc.
7. Push and create a pull request

## Project Phases

- **Phase 1** (Issues #1-5): Backend foundation ✅ COMPLETE
- **Phase 2** (Issues #6-8): Data migration from Google Sheets
- **Phase 3** (Issues #9-12): Scheduled jobs & automation
- **Phase 4** (Issues #13-17): Frontend foundation
- **Phase 5** (Issues #18-21): Historical charts
- **Phase 6** (Issues #22-25): Azure deployment
- **Phase 7** (Issues #26-30): Polish & refinement

See [GitHub Issues](https://github.com/ZacheryGlass/my-money-tracker/issues) for detailed task breakdown.

## Important Notes

- Single-user system (for personal use)
- All scheduled jobs use America/Mexico_City timezone
- Snapshots are created daily to track portfolio growth over time
- Price updates use a waterfall strategy: Coinbase → CoinGecko → CoinMarketCap
- Passwords should be changed immediately after initial seed

## License

MIT

## Reference Documentation

See [CLAUDE.md](./CLAUDE.md) for detailed architecture and implementation patterns.
