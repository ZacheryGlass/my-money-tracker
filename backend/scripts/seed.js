#!/usr/bin/env node

require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('../src/config/database');

async function seedDatabase() {
  try {
    // Seed default user
    const username = 'zachery';
    const password = process.env.INITIAL_PASSWORD || 'changeme123';
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING RETURNING id',
      [username, passwordHash]
    );

    if (result.rows.length > 0) {
      console.log('✓ Seed user created successfully');
      console.log(`  Username: ${username}`);
      console.log(`  Password: ${password}`);
      console.log('\nIMPORTANT: Change this password immediately in production!');
    } else {
      console.log('✓ User already exists, skipping seed');
    }

    process.exit(0);
  } catch (error) {
    console.error('✗ Seed failed:', error.message);
    process.exit(1);
  }
}

seedDatabase();
