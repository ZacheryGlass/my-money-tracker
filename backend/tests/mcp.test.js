'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const app = require('../src/server');
const token = jwt.sign({ id: 1, username: 'test' }, process.env.JWT_SECRET);

function mcpRequest(body) {
  return request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .send(body);
}

test('POST /mcp requires authentication', async () => {
  const response = await request(app)
    .post('/mcp')
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

  assert.equal(response.status, 401);
  assert.equal(response.body.error, 'Access token required');
});

test('POST /mcp initializes a streamable HTTP MCP connection', async () => {
  const response = await mcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'backend-test', version: '1.0.0' },
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.result.protocolVersion, '2025-06-18');
  assert.equal(response.body.result.serverInfo.name, 'my-money-tracker');
});

test('POST /mcp advertises the complete read-only financial toolset', async () => {
  const response = await mcpRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });

  assert.equal(response.status, 200);
  const names = response.body.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    'finance_get_context',
    'finance_get_overview',
    'finance_query_positions',
    'finance_query_transactions',
    'finance_get_time_series',
    'finance_compare_periods',
    'finance_analyze_investments',
    'finance_analyze_cash_flow',
    'finance_run_scenario',
    'finance_get_data_health',
    'finance_export_dataset',
  ]);

  for (const tool of response.body.result.tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
  }
});
