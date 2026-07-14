'use strict';

const express = require('express');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const authenticateToken = require('../middleware/auth');
const createFinancialMcpServer = require('../mcp/createFinancialMcpServer');
const logger = require('../config/logger');

const router = express.Router();

router.use(authenticateToken);

router.use((req, res, next) => {
  const allowedOrigins = (process.env.MCP_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const origin = req.headers.origin;
  if (origin && allowedOrigins.length && !allowedOrigins.includes(origin)) {
    return res.status(403).json({ error: 'Origin is not allowed for MCP requests.' });
  }
  return next();
});

router.post('/', async (req, res) => {
  const server = createFinancialMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  let closed = false;
  const closeResources = () => {
    if (closed) return;
    closed = true;
    Promise.allSettled([transport.close(), server.close()]).catch(() => {});
  };
  res.once('close', closeResources);

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    logger.error({ err: error }, 'MCP request failed');
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal MCP server error' },
        id: req.body?.id ?? null,
      });
    }
  } finally {
    if (res.writableFinished) closeResources();
  }
});

router.get('/', (req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Standalone MCP event streams are not enabled.' },
    id: null,
  });
});

router.delete('/', (req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'This MCP server uses stateless sessions.' },
    id: null,
  });
});

module.exports = router;
