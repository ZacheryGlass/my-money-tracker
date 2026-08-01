'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const statements = [];

const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      async connect() {
        return {
          async query(text) {
            const sql = String(text).replace(/\s+/g, ' ').trim();
            statements.push(sql);
            if (/^INSERT INTO exchange_fiat_matches/.test(sql)
                || /^WITH candidates AS/.test(sql)) {
              return { rows: [], rowCount: 0 };
            }
            return { rows: [], rowCount: 0 };
          },
          release() {},
        };
      }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const ExchangeFiatMatch = require('../src/models/ExchangeFiatMatch');

test('rebuilding derived fiat links does not rewrite the importer review queue', async () => {
  statements.length = 0;

  const result = await ExchangeFiatMatch.rebuildForUser(1);

  assert.deepEqual(result, { matched: 0 });
  assert.ok(statements.some((sql) => /^DELETE FROM exchange_fiat_matches/.test(sql)));
  assert.ok(statements.some((sql) => /^WITH candidates AS/.test(sql)));
  assert.ok(!statements.some((sql) => /^UPDATE exchange_records/.test(sql)));
});
