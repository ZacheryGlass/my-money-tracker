#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const readline = require('readline');
require('dotenv').config();

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const TOKEN_PATH = path.join(__dirname, '../token.json');
const CREDENTIALS_PATH = path.join(__dirname, '../credentials.json');
const EXPORTS_DIR = path.join(__dirname, '../data/exports');

const SHEETS_TO_EXPORT = [
  'Crypto Shares',
  'HSA Shares',
  'Taxable Shares',
  '401k Shares',
  'Roth IRA Shares',
  'Ticker History',
  'Account History'
];

let exportLog = [];

function log(message) {
  console.log(message);
  exportLog.push(message);
}

async function authenticate() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    log('❌ ERROR: credentials.json not found');
    log('\nSetup Instructions:');
    log('1. Visit: https://console.cloud.google.com');
    log('2. Create new project or select existing');
    log('3. Enable Google Sheets API');
    log('4. Create OAuth2 credentials (Desktop application)');
    log('5. Download credentials.json to backend/ directory');
    log('6. Run this script again');
    process.exit(1);
  }

  const credentialsContent = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_id, client_secret, redirect_uris } = credentialsContent.installed;

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  // Check if token exists
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oauth2Client.setCredentials(token);
    return oauth2Client;
  }

  // Generate new token
  return generateNewToken(oauth2Client);
}

function generateNewToken(oauth2Client) {
  return new Promise((resolve, reject) => {
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES
    });

    log('\n🔐 Authentication Required');
    log('Opening browser to authorize access to Google Sheets...\n');

    // Try to open browser automatically
    const { exec } = require('child_process');
    const platform = process.platform;
    if (platform === 'win32') {
      exec(`start "${authUrl}"`);
    } else if (platform === 'darwin') {
      exec(`open "${authUrl}"`);
    } else {
      exec(`xdg-open "${authUrl}"`);
    }

    // Also show link for manual access
    log(`If browser doesn't open, visit this URL manually:\n${authUrl}\n`);

    // Prompt for code
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('Enter the code from the page above: ', (code) => {
      rl.close();

      oauth2Client.getToken(code, (err, token) => {
        if (err) {
          log('❌ Error retrieving access token');
          reject(err);
        }

        oauth2Client.setCredentials(token);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
        log('✅ Authorization successful! Token saved.\n');
        resolve(oauth2Client);
      });
    });
  });
}

function csvEscape(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const str = String(value);

  // Escape quotes and wrap in quotes if contains special characters
  if (str.includes('"') || str.includes(',') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }

  return str;
}

function convertToCsv(data) {
  if (!data || data.length === 0) {
    return '';
  }

  // Get headers from first row
  const headers = data[0];

  // Build CSV rows
  const csvRows = data.map(row => {
    return row.map(cell => csvEscape(cell)).join(',');
  });

  return csvRows.join('\n') + '\n';
}

async function exportSheet(sheets, spreadsheetId, sheetName) {
  try {
    log(`Exporting ${sheetName}...`);

    // Get sheet data
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: sheetName
    });

    const values = response.data.values || [];

    if (values.length === 0) {
      log(`⚠️  ${sheetName}: No data found`);
      return false;
    }

    // Convert to CSV
    const csv = convertToCsv(values);

    // Save to file
    const filename = `${sheetName}.csv`;
    const filepath = path.join(EXPORTS_DIR, filename);

    fs.writeFileSync(filepath, csv);

    const rowCount = values.length;
    log(`✅ ${sheetName}: Exported ${rowCount} rows`);

    return true;
  } catch (err) {
    log(`❌ ERROR exporting ${sheetName}: ${err.message}`);
    return false;
  }
}

async function main() {
  log('Starting Google Sheets export...\n');

  try {
    // Validate environment
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    if (!spreadsheetId) {
      log('❌ ERROR: GOOGLE_SHEETS_ID not set in .env');
      log('\nSetup Instructions:');
      log('1. Open your Google Sheets document');
      log('2. Copy the spreadsheet ID from the URL: https://docs.google.com/spreadsheets/d/{ID}/edit');
      log('3. Add to backend/.env: GOOGLE_SHEETS_ID=your_id_here');
      log('4. Run this script again');
      process.exit(1);
    }

    // Create exports directory if needed
    if (!fs.existsSync(EXPORTS_DIR)) {
      fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    }

    // Authenticate
    const auth = await authenticate();
    const sheets = google.sheets({ version: 'v4', auth });

    log(`\n=== EXPORTING SHEETS ===\n`);

    // Export each sheet
    let successCount = 0;
    for (const sheetName of SHEETS_TO_EXPORT) {
      const success = await exportSheet(sheets, spreadsheetId, sheetName);
      if (success) successCount++;
    }

    log(`\n=== EXPORT COMPLETE ===`);
    log(`\n✅ Successfully exported ${successCount}/${SHEETS_TO_EXPORT.length} sheets`);
    log(`\nNext step: npm run import`);

    process.exit(0);
  } catch (err) {
    log(`\n❌ EXPORT FAILED: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

main();
