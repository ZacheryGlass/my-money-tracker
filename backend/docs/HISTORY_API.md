# History API Endpoints

This document describes the history API endpoints for retrieving historical snapshot data.

## Endpoints

### GET /api/history/tickers

List all ticker snapshots with optional filtering and pagination.

**Query Parameters:**
- `ticker` (optional): Filter by specific ticker symbol (e.g., "BTC", "ETH")
- `account_id` (optional): Filter by account ID (integer)
- `startDate` (optional): Start date for range filter (YYYY-MM-DD format)
- `endDate` (optional): End date for range filter (YYYY-MM-DD format)
- `limit` (optional): Number of results per page (1-100, default: 30)
- `offset` (optional): Number of results to skip (default: 0)

**Response:**
```json
{
  "data": [
    {
      "snapshot_date": "2024-01-15",
      "account_id": 1,
      "ticker": "BTC",
      "name": "Bitcoin",
      "value": "45000.00"
    }
  ],
  "pagination": {
    "total": 100,
    "limit": 30,
    "offset": 0
  }
}
```

**Example Requests:**
```bash
# Get all ticker snapshots
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/history/tickers

# Filter by ticker
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/history/tickers?ticker=BTC

# Filter by date range
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/history/tickers?startDate=2024-01-01&endDate=2024-12-31

# With pagination
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/history/tickers?limit=10&offset=20
```

### GET /api/history/accounts

List account snapshots with optional filtering and pagination.

**Query Parameters:**
- `account_id` (optional): Filter by account ID (integer)
- `startDate` (optional): Start date for range filter (YYYY-MM-DD format)
- `endDate` (optional): End date for range filter (YYYY-MM-DD format)
- `limit` (optional): Number of results per page (1-100, default: 30)
- `offset` (optional): Number of results to skip (default: 0)

**Response:**
```json
{
  "data": [
    {
      "snapshot_date": "2024-01-15",
      "account_id": 1,
      "total_value": "50000.00"
    }
  ],
  "pagination": {
    "total": 50,
    "limit": 30,
    "offset": 0
  }
}
```

**Example Requests:**
```bash
# Get all account snapshots
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/history/accounts

# Filter by account
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/history/accounts?account_id=1

# Filter by date range
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/history/accounts?startDate=2024-01-01&endDate=2024-12-31
```

### GET /api/history/portfolio

Get aggregated total portfolio value over time.

**Query Parameters:**
- `startDate` (optional): Start date for range filter (YYYY-MM-DD format)
- `endDate` (optional): End date for range filter (YYYY-MM-DD format)
- `limit` (optional): Number of results per page (1-100, default: 30)
- `offset` (optional): Number of results to skip (default: 0)

**Response:**
```json
{
  "data": [
    {
      "snapshot_date": "2024-01-15",
      "total_value": "150000.00"
    }
  ],
  "pagination": {
    "total": 365,
    "limit": 30,
    "offset": 0
  }
}
```

**Example Requests:**
```bash
# Get all portfolio snapshots
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/history/portfolio

# Filter by date range
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/history/portfolio?startDate=2024-01-01&endDate=2024-12-31

# Get recent 7 days
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/history/portfolio?limit=7
```

## Error Responses

All endpoints return validation errors with a 400 status code:

```json
{
  "error": "Invalid limit parameter. Must be between 1 and 100."
}
```

Possible error messages:
- "Invalid limit parameter. Must be between 1 and 100."
- "Invalid offset parameter. Must be a non-negative number."
- "Invalid account_id parameter. Must be a number."
- "Invalid startDate format. Must be YYYY-MM-DD."
- "Invalid endDate format. Must be YYYY-MM-DD."

## Authentication

All endpoints require a valid JWT token in the Authorization header:

```bash
Authorization: Bearer <your_jwt_token>
```

## Data Ordering

All endpoints return data sorted by `snapshot_date` in ascending order (oldest first).

## Implementation Notes

- Pagination uses `limit` and `offset` parameters
- Date parameters use PostgreSQL DATE type comparison
- All numeric IDs are validated before database queries
- SQL injection is prevented through parameterized queries
