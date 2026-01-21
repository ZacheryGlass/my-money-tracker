# Dashboard Implementation Guide

## Overview
This document describes the dashboard view implementation for the Money Tracker application, including all components, features, and usage instructions.

## Implementation Summary

### Architecture
The dashboard follows a modern React architecture with:
- **React 19** with Vite for fast development and builds
- **Tailwind CSS v3** for responsive, utility-first styling
- **React Router v7** for client-side routing
- **TanStack Table v8** for advanced table features
- **Axios** for HTTP requests
- **JWT authentication** for secure API access

### File Structure
```
frontend/
├── src/
│   ├── components/
│   │   ├── DashboardTable.jsx    # Main table component with sorting
│   │   └── PrivateRoute.jsx      # Protected route wrapper
│   ├── contexts/
│   │   └── AuthContext.jsx       # Authentication state management
│   ├── pages/
│   │   ├── Dashboard.jsx         # Main dashboard page
│   │   └── Login.jsx             # Login page
│   ├── services/
│   │   └── api.js                # Axios instance with interceptors
│   ├── utils/
│   │   └── formatters.js         # Currency and date formatting utilities
│   ├── App.jsx                   # Root app with routing
│   ├── main.jsx                  # Entry point
│   └── index.css                 # Tailwind imports
├── .env                          # Environment variables (gitignored)
├── .env.example                  # Environment template
├── package.json                  # Dependencies
├── tailwind.config.js            # Tailwind configuration
├── postcss.config.js             # PostCSS configuration
└── vite.config.js                # Vite configuration
```

## Features Implemented

### 1. Dashboard Page (`Dashboard.jsx`)
**Features:**
- Fetches portfolio data from `GET /api/dashboard`
- Displays loading spinner during data fetch
- Shows error state with retry button
- Header with user info and logout button
- Manual refresh button with loading indicator
- Two summary cards:
  - Total Portfolio Value (color-coded: green for positive, red for negative)
  - Last Updated timestamp (formatted)
- Integrated DashboardTable component
- Responsive layout with Tailwind CSS

### 2. Dashboard Table (`DashboardTable.jsx`)
**Features:**
- Displays holdings in a sortable table with columns:
  - **Name**: Holding name
  - **Ticker**: Ticker symbol (shows "-" if not available)
  - **Value**: Currency formatted (red for liabilities, green for assets)
  - **Account**: Account name
  - **Category**: Category name
  - **Type**: Badge showing Asset/Liability (color-coded)
- Default sorting by value (highest first)
- Clickable column headers for sorting
- Account Subtotals section:
  - Grid layout showing total per account
  - Color-coded values (red for negative, green for positive)
- Category Breakdown section:
  - List of categories sorted by absolute value
  - Shows total per category with color coding

### 3. Authentication System
**Components:**
- **AuthContext**: Provides authentication state and methods
- **Login Page**: Simple login form with username/password
- **PrivateRoute**: Protects dashboard route from unauthorized access
- **API Service**: Axios interceptors for:
  - Adding JWT token to requests
  - Handling 401 errors (auto-redirect to login)

### 4. Formatting Utilities
**Functions:**
- `formatCurrency(value)`: Formats numbers as USD with $ symbol and commas
- `formatDate(dateString)`: Formats ISO dates to readable format

## Display Logic

### Sorting
- Default: Sorted by value (descending)
- All columns are sortable via TanStack Table
- Click column header to toggle sort direction

### Color Coding
- **Green**: Assets (positive values)
- **Red**: Liabilities (negative values or Liability type)
- Applied to:
  - Value column text
  - Type badges
  - Summary cards
  - Account subtotals
  - Category breakdown

### Filtering
- Backend filters holdings with absolute value < $100
- Implemented in `DashboardService.getCurrentPortfolio()`

### Responsive Design
- Mobile-first approach with Tailwind
- Grid layouts adapt to screen size
- Tables scroll horizontally on small screens
- Summary cards stack on mobile

## API Integration

### Endpoint
```
GET /api/dashboard
```

### Authentication
Requires JWT token in Authorization header:
```
Authorization: Bearer <token>
```

### Response Format
```json
{
  "items": [
    {
      "name": "Bitcoin",
      "ticker": "BTC",
      "value": 50000.00,
      "account": "Crypto",
      "category": "Cryptocurrency",
      "type": "Asset"
    }
  ],
  "total": 150000.00,
  "lastUpdated": "2026-01-21T00:00:00.000Z"
}
```

## Setup Instructions

### Prerequisites
- Node.js 18+
- Backend server running on port 3000 (or configured port)

### Installation
```bash
cd frontend

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env if needed (default: http://localhost:3000)
# VITE_API_URL=http://localhost:3000
```

### Development
```bash
# Start development server
npm run dev

# Frontend will be available at http://localhost:5173
```

### Production Build
```bash
# Build for production
npm run build

# Preview production build
npm run preview
```

### Linting
```bash
# Run ESLint
npm run lint
```

## Usage Flow

1. **Login**: 
   - Navigate to `/login`
   - Enter credentials (default: username=zachery, password=changeme123)
   - JWT token stored in localStorage
   - Redirected to dashboard

2. **Dashboard View**:
   - Auto-fetches portfolio data on mount
   - Shows loading spinner while fetching
   - Displays portfolio summary and detailed table
   - View account subtotals and category breakdown

3. **Interactions**:
   - Click column headers to sort
   - Click "Refresh" to reload data
   - Click "Logout" to clear session

4. **Protected Routes**:
   - Accessing `/` without login redirects to `/login`
   - Invalid/expired token auto-redirects to login

## Acceptance Criteria Verification

✅ **Dashboard loads and displays correctly**
- Loading states, error handling, and data display all working

✅ **Sorting and totals accurate**
- Default sort by value descending
- All columns sortable
- Account and category totals calculated correctly

✅ **Currency formatting correct**
- All values formatted with $ and commas
- Uses Intl.NumberFormat for proper localization

✅ **Responsive layout**
- Tailwind CSS ensures mobile-friendly design
- Grid layouts adapt to screen size
- Tables scroll on small screens

✅ **Last updated time shown**
- Displayed in summary card
- Formatted for readability

## Technical Notes

### State Management
- React hooks (useState, useEffect, useMemo)
- Context API for authentication
- No external state management library needed

### Performance
- useMemo for expensive calculations (subtotals, breakdowns)
- TanStack Table handles efficient rendering
- Vite provides fast HMR during development

### Accessibility
- Semantic HTML elements
- Proper button and form labels
- Keyboard navigation support (via TanStack Table)

### Browser Support
- Modern browsers (Chrome, Firefox, Safari, Edge)
- ES2020+ features used
- No IE11 support

## Future Enhancements (Out of Scope)
- Real-time updates via WebSocket
- Export to CSV/Excel
- Advanced filtering options
- Historical charts (Phase 5)
- Edit holdings inline
- Batch operations

## Troubleshooting

### Build Errors
- Ensure all dependencies installed: `npm install`
- Clear node_modules and reinstall if issues persist
- Check Node.js version (18+)

### API Connection Issues
- Verify backend is running on correct port
- Check VITE_API_URL in .env matches backend
- Check browser console for CORS errors
- Verify JWT token is valid

### Styling Issues
- Ensure Tailwind CSS is properly configured
- Run `npm run build` to see if CSS compiles
- Check browser DevTools for CSS errors

## Related Files in Backend
- `backend/src/routes/dashboard.js` - API endpoint
- `backend/src/services/DashboardService.js` - Business logic
- `backend/src/models/Holding.js` - Holdings data model
- `backend/src/models/PriceCache.js` - Price data model
