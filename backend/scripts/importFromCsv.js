#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const pool = require('../src/config/database');

// Account name to account ID mapping
const ACCOUNT_MAPPING = {
  'Crypto': 1,
  'HSA': 2,
  'Taxable': 3,
  '401k': 4,
  'Roth IRA': 5,
  'Real Estate': 6,
  'Liability': 7
};

// Static assets to import
const STATIC_ASSETS = [
  {
    name: '702 Antelop St. Scott City, KS',
    ticker: '',
    quantity: 1,
    category: 'Real Estate',
    accountId: 6  // Real Estate
  }
];

const STATIC_LIABILITIES = [
  {
    name: 'Student Loans (Great Lakes)',
    ticker: '',
    quantity: -1,
    category: 'Debt',
    accountId: 7  // Liability
  },
  {
    name: 'M1 LOC (M1 Borrow)',
    ticker: '',
    quantity: -1,
    category: 'Debt',
    accountId: 7  // Liability
  },
  {
    name: 'Car Loan (Chevy)',
    ticker: '',
    quantity: -1,
    category: 'Debt',
    accountId: 7  // Liability
  },
  {
    name: 'Car Loan (Honda)',
    ticker: '',
    quantity: -1,
    category: 'Debt',
    accountId: 7  // Liability
  }
];

let importLog = [];

function log(message) {
  console.log(message);
  importLog.push(message);
}

async function importAccountSheets() {
  log('\n=== IMPORTING ACCOUNT SHEETS ===');

  const exportsDir = path.join(__dirname, '../data/exports');
  const accountSheets = [
    'Crypto Shares.csv',
    'HSA Shares.csv',
    'Taxable Shares.csv',
    '401k Shares.csv',
    'Roth IRA Shares.csv'
  ];

  for (const filename of accountSheets) {
    const filepath = path.join(exportsDir, filename);
    const accountName = filename.replace(' Shares.csv', '');

    if (!fs.existsSync(filepath)) {
      log(`⚠️  SKIPPING ${filename} - file not found`);
      continue;
    }

    log(`\nProcessing ${filename}...`);
    await importAccountSheet(filepath, accountName);
  }
}

async function importAccountSheet(filepath, accountName) {
  return new Promise((resolve, reject) => {
    const accountId = ACCOUNT_MAPPING[accountName];
    if (!accountId) {
      log(`❌ ERROR: Unknown account name: ${accountName}`);
      return reject(new Error(`Unknown account: ${accountName}`));
    }

    let rowCount = 0;
    let insertCount = 0;

    fs.createReadStream(filepath)
      .pipe(csv())
      .on('data', async (row) => {
        rowCount++;

        // Column A = Ticker, Column B = Name, Column K = Value
        const ticker = (row['Ticker'] || '').trim().toUpperCase();
        const name = (row['Name'] || '').trim();
        const value = parseFloat(row['Value'] || 0);

        // Skip rows without ticker
        if (!ticker) {
          return;
        }

        // Skip section headers
        if (['ETFS', 'MUTUAL FUNDS', 'STOCKS'].includes(ticker)) {
          return;
        }

        // Skip very small values (< $1)
        if (value < 1 && value > -1) {
          return;
        }

        // Calculate quantity from value (will be stored, price fetched later)
        const quantity = 1;  // Placeholder, actual quantity unknown from value alone

        // Insert into holdings table
        try {
          const query = `
            INSERT INTO holdings (account_id, ticker, name, quantity, category)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (account_id, ticker) DO NOTHING
          `;

          const category = accountName === 'Crypto' ? 'Crypto' : 'Securities';
          await pool.query(query, [accountId, ticker, name, quantity, category]);

          insertCount++;
          if (rowCount % 10 === 0) {
            log(`  Processed ${rowCount} rows, inserted ${insertCount}...`);
          }
        } catch (err) {
          log(`  ⚠️  Error inserting ${ticker}: ${err.message}`);
        }
      })
      .on('end', () => {
        log(`✅ ${accountName}: Processed ${rowCount} rows, inserted ${insertCount} holdings`);
        resolve();
      })
      .on('error', (err) => {
        log(`❌ ERROR reading ${filepath}: ${err.message}`);
        reject(err);
      });
  });
}

async function importTickerHistory() {
  log('\n=== IMPORTING TICKER HISTORY ===');

  const filepath = path.join(__dirname, '../data/exports/Ticker History.csv');

  if (!fs.existsSync(filepath)) {
    log(`⚠️  SKIPPING Ticker History - file not found`);
    return;
  }

  return new Promise((resolve, reject) => {
    let rowCount = 0;
    let insertCount = 0;

    fs.createReadStream(filepath)
      .pipe(csv())
      .on('data', async (row) => {
        rowCount++;

        const timestamp = row['Timestamp'];
        if (!timestamp) {
          log(`⚠️  Skipping row ${rowCount}: missing timestamp`);
          return;
        }

        // Convert MM/DD/YYYY HH:MM:SS to ISO timestamp
        let snapshotDate;
        try {
          snapshotDate = parseTimestamp(timestamp);
        } catch (err) {
          log(`⚠️  Skipping row ${rowCount}: invalid timestamp format`);
          return;
        }

        // Process each ticker column (skip Timestamp column)
        for (const [ticker, value] of Object.entries(row)) {
          if (ticker === 'Timestamp' || !ticker.trim()) {
            continue;
          }

          const amount = parseFloat(value);
          if (!amount || isNaN(amount)) {
            continue;
          }

          try {
            const query = `
              INSERT INTO ticker_snapshots (ticker, snapshot_date, value_usd)
              VALUES ($1, $2, $3)
              ON CONFLICT (ticker, snapshot_date) DO NOTHING
            `;

            await pool.query(query, [ticker.toUpperCase(), snapshotDate, amount]);
            insertCount++;
          } catch (err) {
            log(`  ⚠️  Error inserting snapshot for ${ticker}: ${err.message}`);
          }
        }

        if (rowCount % 50 === 0) {
          log(`  Processed ${rowCount} rows, inserted ${insertCount} snapshots...`);
        }
      })
      .on('end', () => {
        log(`✅ Ticker History: Processed ${rowCount} rows, inserted ${insertCount} snapshots`);
        resolve();
      })
      .on('error', (err) => {
        log(`❌ ERROR reading Ticker History: ${err.message}`);
        reject(err);
      });
  });
}

async function importAccountHistory() {
  log('\n=== IMPORTING ACCOUNT HISTORY ===');

  const filepath = path.join(__dirname, '../data/exports/Account History.csv');

  if (!fs.existsSync(filepath)) {
    log(`⚠️  SKIPPING Account History - file not found`);
    return;
  }

  return new Promise((resolve, reject) => {
    let rowCount = 0;
    let insertCount = 0;

    fs.createReadStream(filepath)
      .pipe(csv())
      .on('data', async (row) => {
        rowCount++;

        const timestamp = row['Timestamp'];
        if (!timestamp) {
          log(`⚠️  Skipping row ${rowCount}: missing timestamp`);
          return;
        }

        // Convert timestamp format
        let snapshotDate;
        try {
          snapshotDate = parseTimestamp(timestamp);
        } catch (err) {
          log(`⚠️  Skipping row ${rowCount}: invalid timestamp format`);
          return;
        }

        // Process each account column
        for (const [accountName, value] of Object.entries(row)) {
          if (accountName === 'Timestamp' || !accountName.trim()) {
            continue;
          }

          const amount = parseFloat(value);
          if (!amount || isNaN(amount)) {
            continue;
          }

          const accountId = ACCOUNT_MAPPING[accountName];
          if (!accountId) {
            continue;  // Skip unknown accounts
          }

          try {
            const query = `
              INSERT INTO account_snapshots (account_id, snapshot_date, value_usd)
              VALUES ($1, $2, $3)
              ON CONFLICT (account_id, snapshot_date) DO NOTHING
            `;

            await pool.query(query, [accountId, snapshotDate, amount]);
            insertCount++;
          } catch (err) {
            log(`  ⚠️  Error inserting account snapshot: ${err.message}`);
          }
        }

        if (rowCount % 50 === 0) {
          log(`  Processed ${rowCount} rows, inserted ${insertCount} snapshots...`);
        }
      })
      .on('end', () => {
        log(`✅ Account History: Processed ${rowCount} rows, inserted ${insertCount} snapshots`);
        resolve();
      })
      .on('error', (err) => {
        log(`❌ ERROR reading Account History: ${err.message}`);
        reject(err);
      });
  });
}

async function importStaticAssets() {
  log('\n=== IMPORTING STATIC ASSETS ===');

  const allStatic = [...STATIC_ASSETS, ...STATIC_LIABILITIES];

  for (const asset of allStatic) {
    try {
      const query = `
        INSERT INTO holdings (account_id, ticker, name, quantity, category)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (account_id, ticker) DO NOTHING
      `;

      await pool.query(query, [
        asset.accountId,
        asset.ticker || null,
        asset.name,
        asset.quantity,
        asset.category
      ]);

      log(`✅ Imported: ${asset.name}`);
    } catch (err) {
      log(`⚠️  Error importing ${asset.name}: ${err.message}`);
    }
  }
}

function parseTimestamp(timestamp) {
  // Expected format: MM/DD/YYYY HH:MM:SS
  const match = timestamp.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);

  if (!match) {
    throw new Error(`Invalid timestamp format: ${timestamp}`);
  }

  const [, month, day, year, hour, minute, second] = match;
  const date = new Date(
    parseInt(year),
    parseInt(month) - 1,
    parseInt(day),
    parseInt(hour),
    parseInt(minute),
    parseInt(second)
  );

  return date.toISOString();
}

async function main() {
  log('Starting CSV import...\n');

  try {
    // Import in order
    await importAccountSheets();
    await importStaticAssets();
    await importTickerHistory();
    await importAccountHistory();

    log('\n=== IMPORT COMPLETE ===');
    log('\nTo verify the import, run: npm run verify');

    process.exit(0);
  } catch (err) {
    log(`\n❌ IMPORT FAILED: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

main();
