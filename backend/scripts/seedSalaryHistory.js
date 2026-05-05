#!/usr/bin/env node

require('dotenv').config();
const pool = require('../src/config/database');

const SALARY_DATA = [
  { date: '2025-12-21', title: 'Senior Software Engineer', salary: 126459.00, psu: 8000, rsu: 8000, total: 142459, change: 10157.60, pct: 0.08305 },
  { date: '2024-12-22', title: 'Senior Software Engineer', salary: 122301.40, psu: 5000, rsu: 5000, total: 132301.40, change: 7728.76, pct: 0.06746 },
  { date: '2023-12-24', title: 'Senior Software Engineer', salary: 114572.64, psu: 5000, rsu: 5000, total: 124572.64, change: 13337.29, pct: 0.11990 },
  { date: '2022-12-25', title: 'Senior Software Engineer', salary: 111235.35, psu: 0, rsu: 0, total: 111235.35, change: 4900, pct: 0.04608 },
  { date: '2022-06-26', title: 'Senior Software Engineer', salary: 106335.35, psu: 0, rsu: 0, total: 106335.35, change: 12500, pct: 0.13321 },
  { date: '2021-12-26', title: 'Senior Software Engineer', salary: 93835.35, psu: 0, rsu: 0, total: 93835.35, change: 7288.77, pct: 0.08422 },
  { date: '2021-06-27', title: 'Senior Software Engineer', salary: 86546.58, psu: 0, rsu: 0, total: 86546.58, change: 5400, pct: 0.06655 },
  { date: '2020-12-27', title: 'Software Engineer II', salary: 81146.58, psu: 0, rsu: 0, total: 81146.58, change: 2766.81, pct: 0.03530 },
  { date: '2019-12-29', title: 'Software Engineer II', salary: 78379.77, psu: 0, rsu: 0, total: 78379.77, change: 7309.77, pct: 0.10285 },
  { date: '2018-12-30', title: 'Software Engineer', salary: 71070.00, psu: 0, rsu: 0, total: 71070, change: 2070, pct: 0.03000 },
  { date: '2018-07-08', title: 'Software Engineer', salary: 69000.00, psu: 0, rsu: 0, total: 69000, change: 23240, pct: 0.50787 },
  { date: '2017-05-22', title: 'Software Engineer Intern', salary: 45760.00, psu: 0, rsu: 0, total: 45760, change: null, pct: null },
];

async function main() {
  console.log('Seeding salary history...');

  for (const row of SALARY_DATA) {
    try {
      await pool.query(
        `INSERT INTO salary_history (effective_date, title, salary_amount, psu, rsu, total_comp, change_amount, change_percent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (effective_date) DO NOTHING`,
        [row.date, row.title, row.salary, row.psu, row.rsu, row.total, row.change, row.pct]
      );
      console.log(`  ${row.date}: ${row.title} - $${row.salary}`);
    } catch (err) {
      console.error(`  Error: ${err.message}`);
    }
  }

  console.log('Done.');
  process.exit(0);
}

main();
