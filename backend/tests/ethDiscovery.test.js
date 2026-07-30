'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const calls = [];
const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      async query(text, params) {
        calls.push({ text: String(text), params });
        const sql = String(text).replace(/\s+/g, ' ').trim();
        if (sql.startsWith('WITH known AS')) {
          return { rows: [{ id: 9, address: '0x1111111111111111111111111111111111111111', status: 'pending' }] };
        }
        if (sql.includes('COUNT(*) OVER()')) {
          return { rows: [{ id: 9, address: '0x2222222222222222222222222222222222222222', status: 'pending', total_count: '1' }] };
        }
        if (sql.startsWith('SELECT * FROM eth_discovery_candidates WHERE id')) {
          return { rows: [{ id: 9, user_id: 1, address: '0x2222222222222222222222222222222222222222', status: 'pending' }] };
        }
        if (sql.startsWith('UPDATE eth_discovery_candidates')) {
          return { rows: [{ id: 9, user_id: 1, address: '0x2222222222222222222222222222222222222222', status: params[2] }] };
        }
        return { rows: [] };
      }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const EthDiscoveryCandidate = require('../src/models/EthDiscoveryCandidate');

beforeEach(() => calls.splice(0));

test('discovery seed is user-scoped and returns proof-backed candidates', async () => {
  const rows = await EthDiscoveryCandidate.seed(1);
  assert.equal(rows.length, 1);
  assert.equal(calls[0].params[0], 1);
  assert.match(calls[0].text, /exchange_withdrawal/);
  assert.match(calls[0].text, /30 days/);
  assert.match(calls[0].text, /NOT EXISTS/);
});

test('discovery list uses a bounded, status-aware query', async () => {
  const result = await EthDiscoveryCandidate.findForUser(1, { status: 'pending', limit: 25, offset: 10 });
  assert.equal(result.total, 1);
  assert.equal(result.candidates.length, 1);
  const call = calls[0];
  assert.deepEqual(call.params, [1, 'pending', 25, 10]);
  assert.match(call.text, /LIMIT \$3 OFFSET \$4/);
});

test('discovery decisions cannot be written outside the caller scope', async () => {
  const candidate = await EthDiscoveryCandidate.findByIdForUser(1, 9);
  assert.equal(candidate.user_id, 1);
  const decided = await EthDiscoveryCandidate.decide(1, 9, 'confirmed_own');
  assert.equal(decided.status, 'confirmed_own');
  assert.deepEqual(calls.at(-1).params, [9, 1, 'confirmed_own']);
});

test('invalid discovery status and ids fail closed before a query', async () => {
  await assert.rejects(() => EthDiscoveryCandidate.findForUser(1, { status: 'unknown' }), /Invalid discovery status/);
  assert.equal(await EthDiscoveryCandidate.findByIdForUser(1, 0), null);
  assert.equal(await EthDiscoveryCandidate.decide(1, 0, 'dismissed'), null);
  assert.equal(calls.length, 0);
});
