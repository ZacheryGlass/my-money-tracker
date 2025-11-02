#!/usr/bin/env node

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../src/config/database');

async function runMigrations() {
  try {
    // Read migration file
    const migrationPath = path.join(__dirname, '../migrations/001_initial_schema.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    // Execute migration
    await pool.query(sql);
    console.log('✓ Migration completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('✗ Migration failed:', error.message);
    process.exit(1);
  }
}

runMigrations();
