# Bulk Import/Export Feature

## Overview
The bulk import/export feature allows you to manage your holdings in bulk using CSV files.

## CSV Import Format

### Required Columns
- `account`: Account name (must match existing account in the system)
- `name`: Holding name (required)

### Optional Columns
- `ticker`: Ticker symbol (e.g., BTC, AAPL)
- `quantity`: Number of units held
- `category`: Category for organization (e.g., Crypto, Stock, Real Estate)

### Sample CSV
```csv
account,ticker,name,quantity,category
Crypto,BTC,Bitcoin,0.5,Crypto
HSA,VTSAX,Vanguard Total Stock,10,Stock
Taxable,AAPL,Apple Inc,5.25,Stock
401k,VFIAX,Vanguard 500 Index,20,Stock
```

## How to Use

### Importing Holdings

1. Navigate to the **Holdings** page
2. Click the **Bulk Import** button
3. Select your CSV file
4. Click **Preview** to validate the data
5. Review the preview showing:
   - Valid rows that will be imported
   - Duplicates (if any)
   - Errors (if any)
6. Optionally check "Skip duplicates during import" if you want to ignore duplicate entries
7. Click **Import X Holdings** to confirm

### Import Validation
The system will validate:
- Account names must exist in the database
- Name field is required for each holding
- Numeric fields (quantity) must be valid numbers
- Duplicates are detected based on account, ticker, and name combination

### Exporting Data

#### Export Holdings
Click the **Export CSV** button on the Holdings page to download all current holdings as a CSV file.

#### Export History
To export historical data:
- Use the API endpoint `/api/export/history?type=<type>&format=<format>`
- Types: `tickers`, `accounts`, `portfolio`
- Formats: `csv`, `json`

## API Endpoints

### POST /api/holdings/bulk-import
Upload CSV data for preview and validation.

**Request:**
- Content-Type: text/csv
- Body: CSV file content

**Response:**
```json
{
  "preview": {
    "total": 4,
    "valid": 4,
    "duplicates": 0,
    "errors": 0
  },
  "validRows": [...],
  "duplicates": [],
  "errors": []
}
```

### POST /api/holdings/bulk-import/confirm
Confirm and execute the import.

**Request:**
```json
{
  "rows": [...],
  "skipDuplicates": false
}
```

**Response:**
```json
{
  "summary": {
    "imported": 4,
    "failed": 0
  },
  "imported": [...],
  "failed": []
}
```

### GET /api/export/holdings
Export all holdings as CSV.

**Response:** CSV file download

### GET /api/export/history
Export historical data.

**Query Parameters:**
- `type`: `tickers`, `accounts`, or `portfolio` (default: `tickers`)
- `format`: `csv` or `json` (default: `csv`)

**Response:** CSV or JSON file download

## Error Handling

### Common Errors
- **Account not found**: The account name in the CSV doesn't match any existing account
- **Missing required fields**: Name field is empty
- **Invalid quantity**: Quantity value is not a valid number
- **Duplicate entry**: A holding with the same account, ticker, and name already exists

### Handling Duplicates
When duplicates are detected:
1. They are shown in the preview with the existing holding ID
2. You can choose to skip them during import by checking the "Skip duplicates" option
3. Duplicates will not cause the import to fail
