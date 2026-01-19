#!/usr/bin/env node

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../src/config/database');

async function runMigrations() {
  try {
    const migrationsDir = path.join(__dirname, '../migrations');

    // Get all .sql files sorted by name
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.log('No migration files found');
      process.exit(0);
    }

    console.log(`Found ${files.length} migration(s)`);

    for (const file of files) {
      const migrationPath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(migrationPath, 'utf-8');

      console.log(`Running ${file}...`);
      await pool.query(sql);
      console.log(`  Done`);
    }

    console.log('All migrations completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exit(1);
  }
}

runMigrations();
