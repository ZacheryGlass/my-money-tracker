#!/usr/bin/env node

require('dotenv').config();
const pool = require('../src/config/database');

const EXPENSES = [
  { type: 'bill', name: 'Rent', cost: 2200, is_fixed_rate: true, is_autopay: true, pay_account: null, company: null },
  { type: 'bill', name: 'Electric', cost: 200, is_fixed_rate: false, is_autopay: true, pay_account: 'Chase Sapphire', company: 'Evergy' },
  { type: 'bill', name: 'Trash/Water', cost: 90, is_fixed_rate: false, is_autopay: true, pay_account: 'Chase Sapphire', company: 'City of Olathe' },
  { type: 'bill', name: 'Gas', cost: 33, is_fixed_rate: false, is_autopay: true, pay_account: 'Chase Sapphire', company: 'Atmos' },
  { type: 'bill', name: 'Car Insurance', cost: 90, is_fixed_rate: true, is_autopay: true, pay_account: 'Chase Sapphire', company: 'State Farm' },
  { type: 'bill', name: 'Internet', cost: 55, is_fixed_rate: true, is_autopay: true, pay_account: 'Chase Sapphire', company: 'Google Fiber' },
  { type: 'bill', name: 'Student Loans', cost: 0, is_fixed_rate: true, is_autopay: true, pay_account: 'Ally', company: 'NelNet' },
  { type: 'bill', name: 'Food', cost: 200, is_fixed_rate: false, is_autopay: false, pay_account: null, company: null },
  { type: 'bill', name: 'Bullshit', cost: 400, is_fixed_rate: false, is_autopay: false, pay_account: null, company: null },
  { type: 'bill', name: 'Car Gas', cost: 50, is_fixed_rate: false, is_autopay: false, pay_account: null, company: null },
  { type: 'bill', name: 'Mowing', cost: 100, is_fixed_rate: false, is_autopay: false, pay_account: null, company: null },
  { type: 'subscription', name: 'YouTube Premium', cost: 15, is_fixed_rate: true, is_autopay: true, pay_account: 'Chase Sapphire', company: null },
  { type: 'subscription', name: 'Amazon Prime', cost: 15, is_fixed_rate: true, is_autopay: true, pay_account: 'Prime Visa', company: null },
  { type: 'subscription', name: 'Google Storage', cost: 2, is_fixed_rate: true, is_autopay: true, pay_account: null, company: null },
];

async function main() {
  console.log('Seeding recurring expenses...');

  for (const exp of EXPENSES) {
    try {
      const existing = await pool.query(
        'SELECT id FROM recurring_expenses WHERE type = $1 AND name = $2',
        [exp.type, exp.name]
      );
      if (existing.rows.length > 0) {
        console.log(`  Skipped (exists): ${exp.name}`);
        continue;
      }
      await pool.query(
        `INSERT INTO recurring_expenses (type, name, cost, is_fixed_rate, is_autopay, pay_account, company)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [exp.type, exp.name, exp.cost, exp.is_fixed_rate, exp.is_autopay, exp.pay_account, exp.company]
      );
      console.log(`  ${exp.type}: ${exp.name} - $${exp.cost}`);
    } catch (err) {
      console.error(`  Error: ${err.message}`);
    }
  }

  console.log('Done.');
  process.exit(0);
}

main();
