const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const EXCEL_FILE = path.join(__dirname, '../../Everything Financial.xlsx');
const OUTPUT_DIR = path.join(__dirname, '../data/exports');

// Account sheets to export with their quantity column name
const ACCOUNT_SHEETS = [
  { name: 'Crypto Shares', quantityCol: 'Coins Owned' },
  { name: 'HSA Shares', quantityCol: 'Shares Owned' },
  { name: 'Taxable Shares', quantityCol: 'Shares Owned' },
  { name: '401k Shares', quantityCol: null }, // No quantity col, needs aggregation
  { name: 'Roth IRA Shares', quantityCol: 'Shares Owned' },
];

const HISTORY_SHEETS = ['Ticker History', 'Account History'];

function formatDate(excelDate) {
  if (!excelDate) return '';

  let date;
  if (typeof excelDate === 'number') {
    // Excel serial date number
    date = XLSX.SSF.parse_date_code(excelDate);
    const d = new Date(date.y, date.m - 1, date.d, date.H || 0, date.M || 0, date.S || 0);
    return formatDateObject(d);
  } else if (excelDate instanceof Date) {
    return formatDateObject(excelDate);
  } else {
    // Try parsing as string
    date = new Date(excelDate);
    if (!isNaN(date.getTime())) {
      return formatDateObject(date);
    }
    return excelDate; // Return as-is if can't parse
  }
}

function formatDateObject(d) {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  return `${month}/${day}/${year} ${hours}:${minutes}:${seconds}`;
}

function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCSV(rows, headers) {
  const headerLine = headers.map(escapeCSV).join(',');
  const dataLines = rows.map(row =>
    headers.map(h => escapeCSV(row[h])).join(',')
  );
  return [headerLine, ...dataLines].join('\n');
}

function exportAccountSheet(workbook, sheetConfig) {
  const { name, quantityCol } = sheetConfig;
  const sheet = workbook.Sheets[name];

  if (!sheet) {
    console.log(`  Sheet "${name}" not found, skipping.`);
    return null;
  }

  const data = XLSX.utils.sheet_to_json(sheet);

  // Filter rows with valid Symbol
  let validRows = data.filter(row => row['Symbol'] && String(row['Symbol']).trim());

  // Handle 401k aggregation (sum by Symbol since there's no quantity column)
  if (name === '401k Shares') {
    const aggregated = {};
    for (const row of validRows) {
      const symbol = row['Symbol'];
      if (!aggregated[symbol]) {
        aggregated[symbol] = {
          Ticker: symbol,
          Name: row['Name'] || '',
          Quantity: 0,
          Value: 0
        };
      }
      // 401k uses Current Balance for value, aggregate by summing values
      const value = parseFloat(row['Current Balance'] || row['Current Ballance'] || 0);
      aggregated[symbol].Value += value;
      // For 401k, quantity will stay 0 since it's value-based
    }
    validRows = Object.values(aggregated);
  } else {
    // Standard mapping for other sheets
    validRows = validRows.map(row => ({
      Ticker: row['Symbol'],
      Name: row['Name'] || '',
      Quantity: row[quantityCol] || 0,
      Value: row['Current Balance'] || row['Current Ballance'] || 0
    }));
  }

  const headers = ['Ticker', 'Name', 'Quantity', 'Value'];
  const csv = toCSV(validRows, headers);

  const outputPath = path.join(OUTPUT_DIR, `${name}.csv`);
  fs.writeFileSync(outputPath, csv);

  console.log(`  ${name}: ${validRows.length} rows exported`);
  return validRows.length;
}

function exportHistorySheet(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];

  if (!sheet) {
    console.log(`  Sheet "${sheetName}" not found, skipping.`);
    return null;
  }

  const data = XLSX.utils.sheet_to_json(sheet);

  if (data.length === 0) {
    console.log(`  ${sheetName}: 0 rows (empty)`);
    return 0;
  }

  // Get headers, renaming Date to Timestamp
  const originalHeaders = Object.keys(data[0]);
  const headers = originalHeaders.map(h => h === 'Date' ? 'Timestamp' : h);

  // Transform rows
  const transformedRows = data.map(row => {
    const newRow = {};
    for (const h of originalHeaders) {
      const newKey = h === 'Date' ? 'Timestamp' : h;
      if (h === 'Date') {
        newRow[newKey] = formatDate(row[h]);
      } else {
        newRow[newKey] = row[h];
      }
    }
    return newRow;
  });

  const csv = toCSV(transformedRows, headers);

  const outputPath = path.join(OUTPUT_DIR, `${sheetName}.csv`);
  fs.writeFileSync(outputPath, csv);

  console.log(`  ${sheetName}: ${transformedRows.length} rows, ${headers.length} columns exported`);
  return transformedRows.length;
}

function main() {
  console.log('Excel to CSV Export');
  console.log('===================\n');

  // Check if Excel file exists
  if (!fs.existsSync(EXCEL_FILE)) {
    console.error(`Error: Excel file not found at ${EXCEL_FILE}`);
    process.exit(1);
  }

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log(`Reading: ${EXCEL_FILE}\n`);
  const workbook = XLSX.readFile(EXCEL_FILE);

  console.log('Available sheets:', workbook.SheetNames.join(', '), '\n');

  // Export account sheets
  console.log('Exporting Account Sheets:');
  for (const config of ACCOUNT_SHEETS) {
    exportAccountSheet(workbook, config);
  }

  // Export history sheets
  console.log('\nExporting History Sheets:');
  for (const sheetName of HISTORY_SHEETS) {
    exportHistorySheet(workbook, sheetName);
  }

  console.log(`\nExport complete. Files saved to: ${OUTPUT_DIR}`);
}

main();
