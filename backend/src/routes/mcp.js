'use strict';

const crypto = require('crypto');
const express = require('express');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const createFinancialMcpServer = require('../mcp/createFinancialMcpServer');
const logger = require('../config/logger');

const router = express.Router();

// MCP clients (AI agents) cannot complete an interactive browser login, so
// this endpoint sits outside Easy Auth and is protected by a static bearer
// key instead. Compare SHA-256 digests so the check is constant-time
// regardless of key length.
function requireMcpKey(req, res, next) {
  const configuredKey = process.env.MCP_API_KEY;

  if (!configuredKey) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('MCP_API_KEY is not set; rejecting MCP request');
      return res.status(401).json({ error: 'MCP endpoint is not configured' });
    }
    // Local development: no key required.
    req.user = { id: 1, username: 'mcp-local' };
    return next();
  }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const digest = (value) => crypto.createHash('sha256').update(value).digest();
  if (!token || !crypto.timingSafeEqual(digest(token), digest(configuredKey))) {
    return res.status(401).json({ error: 'Valid MCP API key required' });
  }

  req.user = { id: 1, username: 'mcp' };
  return next();
}

router.use(requireMcpKey);

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
