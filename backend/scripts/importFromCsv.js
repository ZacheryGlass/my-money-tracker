#!/usr/bin/env node

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { Client } = require('pg');

let client;

async function getClient() {
  if (!client) {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  }
  return client;
}

const pool = { query: async (...args) => (await getClient()).query(...args) };

const ACCOUNT_MAPPING = {
  'Crypto': 1,
  'HSA': 2,
  'Taxable': 3,
  '401k': 4,
  'Roth IRA': 5,
  'Real Estate': 6,
  'Liability': 7
};

const TICKER_NAMES = {
  'BTC': 'Bitcoin',
  'ETH': 'Ether',
  'XMR': 'Monero',
  'EOS': 'EOS',
  'DASH': 'Dash',
  'MIOTA': 'IOTA',
  'SOL': 'Solana',
  'ALGO': 'Algorand',
  'DOT': 'Polkadot',
  'ADA': 'Cardano',
  'ICP': 'Internet Computer',
  'MATIC': 'Polygon',
  'LRC': 'Loopring',
  'USDT': 'Tether',
  'USDC': 'USD Coin',
  'XNO': 'Nano',
  'LINK': 'Chainlink',
  'DOGE': 'Dogecoin',
  'TON': 'Toncoin',
  'PEPE': 'Pepe'
};

const STATIC_ASSETS = [
  {
    name: '702 Antelop St. Scott City, KS',
    manual_value: 25000,
    category: 'Real Estate',
    accountId: 6
  }
];

const STATIC_LIABILITIES = [
  { name: 'Student Loans (Great Lakes)', manual_value: -12512, category: 'Debt', accountId: 7 },
  { name: 'M1 LOC (M1 Borrow)', manual_value: -12500, category: 'Debt', accountId: 7 },
  { name: 'Car Loan (Chevy)', manual_value: -1572, category: 'Debt', accountId: 7 },
  { name: 'Car Loan (Honda)', manual_value: 0, category: 'Debt', accountId: 7 }
];

function log(message) {
  console.log(message);
}

function readCsv(filepath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filepath)
      .pipe(csv())
      .on('data', (row) => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
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
      log(`  SKIP ${filename} - file not found`);
      continue;
    }

    log(`\nProcessing ${filename}...`);
    await importAccountSheet(filepath, accountName);
  }
}

async function importAccountSheet(filepath, accountName) {
  const accountId = ACCOUNT_MAPPING[accountName];
  if (!accountId) {
    log(`  ERROR: Unknown account name: ${accountName}`);
    return;
  }

  const rows = await readCsv(filepath);
  let insertCount = 0;

  for (const row of rows) {
    const ticker = (row['Ticker'] || '').trim().toUpperCase();
    const name = (row['Name'] || '').trim();
    const quantity = row['Quantity'] ? parseFloat(row['Quantity']) : null;

    if (!ticker || !name) continue;
    if (['ETFS', 'MUTUAL FUNDS', 'STOCKS'].includes(ticker)) continue;

    const category = accountName === 'Crypto' ? 'Crypto' : 'Securities';

    try {
      await pool.query(
        `INSERT INTO holdings (account_id, ticker, name, quantity, category)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (account_id, ticker, name) DO UPDATE SET quantity = $4`,
        [accountId, ticker, name, quantity, category]
      );
      insertCount++;
    } catch (err) {
      log(`  Error inserting ${ticker}: ${err.message}`);
    }
  }

  log(`  ${accountName}: inserted/updated ${insertCount} holdings`);
}

async function importTickerHistory() {
  log('\n=== IMPORTING TICKER HISTORY ===');

  const filepath = path.join(__dirname, '../data/exports/Ticker History.csv');
  if (!fs.existsSync(filepath)) {
    log('  SKIP Ticker History - file not found');
    return;
  }

  // Build ticker-to-account_id map from holdings table
  const holdingsResult = await pool.query(
    'SELECT DISTINCT UPPER(ticker) as ticker, account_id FROM holdings WHERE ticker IS NOT NULL'
  );
  const tickerAccountMap = {};
  for (const row of holdingsResult.rows) {
    tickerAccountMap[row.ticker] = row.account_id;
  }

  const rows = await readCsv(filepath);
  let insertCount = 0;
  let skipCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const timestamp = row['Timestamp'];
    if (!timestamp) continue;

    let snapshotDate;
    try {
      snapshotDate = parseTimestamp(timestamp);
    } catch {
      skipCount++;
      continue;
    }

    for (const [ticker, value] of Object.entries(row)) {
      if (ticker === 'Timestamp' || !ticker.trim()) continue;

      const amount = parseFloat(value);
      if (isNaN(amount)) continue;

      const tickerUpper = ticker.toUpperCase();
      const name = TICKER_NAMES[tickerUpper] || tickerUpper;
      const accountId = tickerAccountMap[tickerUpper] || ACCOUNT_MAPPING['Crypto'];

      try {
        await pool.query(
          `INSERT INTO ticker_snapshots (snapshot_date, account_id, ticker, name, value)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (snapshot_date, account_id, ticker) DO NOTHING`,
          [snapshotDate, accountId, tickerUpper, name, amount]
        );
        insertCount++;
      } catch (err) {
        log(`  Error inserting snapshot for ${tickerUpper}: ${err.message}`);
      }
    }

    if ((i + 1) % 200 === 0) {
      log(`  Processed ${i + 1}/${rows.length} rows...`);
    }
  }

  log(`  Ticker History: ${insertCount} snapshots inserted, ${skipCount} rows skipped`);
}

async function importAccountHistory() {
  log('\n=== IMPORTING ACCOUNT HISTORY ===');

  const filepath = path.join(__dirname, '../data/exports/Account History.csv');
  if (!fs.existsSync(filepath)) {
    log('  SKIP Account History - file not found');
    return;
  }

  const rows = await readCsv(filepath);
  let insertCount = 0;
  let skipCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const timestamp = row['Timestamp'];
    if (!timestamp) continue;

    let snapshotDate;
    try {
      snapshotDate = parseTimestamp(timestamp);
    } catch {
      skipCount++;
      continue;
    }

    for (const [accountName, value] of Object.entries(row)) {
      if (accountName === 'Timestamp' || !accountName.trim()) continue;

      const amount = parseFloat(value);
      if (isNaN(amount)) continue;

      const accountId = ACCOUNT_MAPPING[accountName];
      if (!accountId) continue;

      try {
        await pool.query(
          `INSERT INTO account_snapshots (snapshot_date, account_id, total_value)
           VALUES ($1, $2, $3)
           ON CONFLICT (snapshot_date, account_id) DO NOTHING`,
          [snapshotDate, accountId, amount]
        );
        insertCount++;
      } catch (err) {
        log(`  Error inserting account snapshot: ${err.message}`);
      }
    }

    if ((i + 1) % 200 === 0) {
      log(`  Processed ${i + 1}/${rows.length} rows...`);
    }
  }

  log(`  Account History: ${insertCount} snapshots inserted, ${skipCount} rows skipped`);
}

async function importStaticAssets() {
  log('\n=== IMPORTING STATIC ASSETS ===');

  const allStatic = [...STATIC_ASSETS, ...STATIC_LIABILITIES];

  for (const asset of allStatic) {
    try {
      const existing = await pool.query(
        'SELECT id FROM holdings WHERE account_id = $1 AND ticker IS NULL AND name = $2',
        [asset.accountId, asset.name]
      );
      if (existing.rows.length > 0) {
        log(`  Skipped (exists): ${asset.name}`);
        continue;
      }
      await pool.query(
        `INSERT INTO holdings (account_id, name, manual_value, category)
         VALUES ($1, $2, $3, $4)`,
        [asset.accountId, asset.name, asset.manual_value, asset.category]
      );
      log(`  Imported: ${asset.name}`);
    } catch (err) {
      log(`  Error importing ${asset.name}: ${err.message}`);
    }
  }
}

async function seedPriceCache() {
  log('\n=== SEEDING PRICE CACHE FROM CSV VALUES ===');

  const exportsDir = path.join(__dirname, '../data/exports');
  const accountSheets = [
    'Crypto Shares.csv',
    'HSA Shares.csv',
    'Taxable Shares.csv',
    '401k Shares.csv',
    'Roth IRA Shares.csv'
  ];

  const priceMap = {};

  for (const filename of accountSheets) {
    const filepath = path.join(exportsDir, filename);
    if (!fs.existsSync(filepath)) continue;

    const rows = await readCsv(filepath);
    for (const row of rows) {
      const ticker = (row['Ticker'] || '').trim().toUpperCase();
      const quantity = parseFloat(row['Quantity']);
      const value = parseFloat(row['Value']);

      if (!ticker || isNaN(quantity) || isNaN(value)) continue;
      if (['ETFS', 'MUTUAL FUNDS', 'STOCKS'].includes(ticker)) continue;

      if (quantity > 0 && value > 0) {
        const pricePerUnit = value / quantity;
        if (!priceMap[ticker] || pricePerUnit > 0) {
          priceMap[ticker] = pricePerUnit;
        }
      }
    }
  }

  let insertCount = 0;
  for (const [ticker, priceUsd] of Object.entries(priceMap)) {
    try {
      await pool.query(
        `INSERT INTO price_cache (ticker, price_usd, source, fetched_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (ticker) DO UPDATE SET price_usd = $2, source = $3, fetched_at = CURRENT_TIMESTAMP`,
        [ticker, priceUsd, 'csv-import']
      );
      insertCount++;
    } catch (err) {
      log(`  Error seeding price for ${ticker}: ${err.message}`);
    }
  }

  log(`  Seeded ${insertCount} prices from CSV data`);
}

function parseTimestamp(timestamp) {
  const match = timestamp.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) throw new Error(`Invalid timestamp: ${timestamp}`);

  const [, month, day, year] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

async function main() {
  log('Starting CSV import...\n');

  try {
    await importAccountSheets();
    await importStaticAssets();
    await seedPriceCache();
    await importTickerHistory();
    await importAccountHistory();

    log('\n=== IMPORT COMPLETE ===');
    if (client) await client.end();
    process.exit(0);
  } catch (err) {
    log(`\nIMPORT FAILED: ${err.message}`);
    console.error(err);
    if (client) await client.end();
    process.exit(1);
  }
}

main();
