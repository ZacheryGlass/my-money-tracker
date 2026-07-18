'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const app = require('../src/server');

function mcpRequest(body, key) {
  const req = request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream');
  if (key) req.set('Authorization', `Bearer ${key}`);
  return req.send(body);
}

const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'backend-test', version: '1.0.0' },
  },
};

test('POST /mcp without a configured key is open outside production', async () => {
  const response = await mcpRequest(initializeBody);

  assert.equal(response.status, 200);
  assert.equal(response.body.result.protocolVersion, '2025-06-18');
  assert.equal(response.body.result.serverInfo.name, 'my-money-tracker');
});

test('POST /mcp without a configured key is rejected in production', async () => {
  process.env.NODE_ENV = 'production';
  try {
    const response = await mcpRequest(initializeBody);

    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'MCP endpoint is not configured');
  } finally {
    process.env.NODE_ENV = 'test';
  }
});

test('POST /mcp with a configured key rejects missing or wrong keys', async () => {
  process.env.MCP_API_KEY = 'test-mcp-key';
  try {
    const missing = await mcpRequest(initializeBody);
    assert.equal(missing.status, 401);
    assert.equal(missing.body.error, 'Valid MCP API key required');

    const wrong = await mcpRequest(initializeBody, 'wrong-key');
    assert.equal(wrong.status, 401);
  } finally {
    delete process.env.MCP_API_KEY;
  }
});

test('POST /mcp with the correct key initializes a connection', async () => {
  process.env.MCP_API_KEY = 'test-mcp-key';
  try {
    const response = await mcpRequest(initializeBody, 'test-mcp-key');

    assert.equal(response.status, 200);
    assert.equal(response.body.result.serverInfo.name, 'my-money-tracker');
  } finally {
    delete process.env.MCP_API_KEY;
  }
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
