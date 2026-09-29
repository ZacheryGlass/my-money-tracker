'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { eligibleGroups, resolveGroup } = require('../scripts/resolve-exchange-duplicates');

function group(overrides = {}) {
  return {
    ambiguous: false,
    conflicts: [],
    fingerprint: 'fingerprint',
    suggested_survivor_id: 1,
    records: [{ id: 1, source: 'csv' }, { id: 2, source: 'api' }],
    ...overrides,
  };
}

test('duplicate resolver accepts only exact API and CSV decisions', () => {
  assert.deepEqual(eligibleGroups({ groups: [group()] }).map((item) => item.fingerprint), ['fingerprint']);
  assert.equal(eligibleGroups({ groups: [group({ ambiguous: true })] }).length, 0);
  assert.equal(eligibleGroups({ groups: [group({ conflicts: ['occurred_at'] })] }).length, 0);
  assert.equal(eligibleGroups({ groups: [group({ records: [{ id: 1, source: 'csv' }, { id: 2, source: 'csv' }] })] }).length, 0);
  assert.equal(eligibleGroups({ groups: [group({ suggested_survivor_id: 99 })] }).length, 0);
});

test('duplicate resolver refuses to discard a manual rounding disclosure', async () => {
  for (const annotatedId of [1, 2]) {
    let queries = 0;
    const client = { query: async () => {
      queries++;
      return { rows: [1, 2].map(id => ({ id,
        eth_rounding_adjustment_wei: id === annotatedId ? '-37' : null })) };
    } };
    await assert.rejects(resolveGroup(client, group(), 1), /Manual rounding disclosures/);
    assert.equal(queries, 1);
  }
});
