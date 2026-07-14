# Financial MCP server

The backend exposes a read-only Model Context Protocol endpoint at `POST /mcp`.
It gives AI clients a semantic financial interface: the server handles filtering,
sign normalization, grouping, time bucketing, returns, risk, cash-flow analysis,
and deterministic scenarios while the client composes those primitives to answer
broader questions.

## Authentication and transport

The endpoint uses MCP Streamable HTTP in stateless JSON-response mode and the
same JWT bearer authentication as the REST API:

```http
POST /mcp HTTP/1.1
Authorization: Bearer <jwt>
Accept: application/json, text/event-stream
Content-Type: application/json
```

Obtain a short-lived token from `POST /api/auth/login`. Remote clients should
store the token as a secret and send it only over HTTPS. Set
`MCP_ALLOWED_ORIGINS` to a comma-separated allowlist if browser-based MCP clients
will connect directly. Server-to-server clients usually omit the `Origin` header.

For Azure, host `/mcp` with the existing Express backend in App Service or
Container Apps. No MCP-specific Azure product is required. Keep authentication,
TLS, logging, network restrictions, and scaling policies on the same service.

## Tool catalog

| Tool | Intended use |
| --- | --- |
| `finance_get_context` | Discover accounts, date coverage, definitions, and semantic-data availability. |
| `finance_get_overview` | Current or historical net worth, assets, liabilities, and account balances. |
| `finance_query_positions` | Search, group, and aggregate holdings and liabilities. |
| `finance_query_transactions` | Normalized rows, summaries, groups, series, or recurring-charge candidates. |
| `finance_get_time_series` | Bucketed balances, holdings, income, spending, compensation, and commitments. |
| `finance_compare_periods` | Compare two periods and rank the categories, merchants, or accounts driving change. |
| `finance_analyze_investments` | Returns, XIRR, risk, benchmark comparison, attribution, and tax lots. |
| `finance_analyze_cash_flow` | Income, spending, savings rate, recurrence, anomalies, liquidity, and runway. |
| `finance_run_scenario` | Goal, allocation, expense, income-loss, and debt-versus-invest scenarios. |
| `finance_get_data_health` | Freshness, price, sync, classification, cash-flow, benchmark, and tax-lot coverage. |
| `finance_export_dataset` | Bounded, allowlisted raw exports for questions not covered by semantic tools. |

All tools are annotated read-only and idempotent. There is no arbitrary SQL
tool, and raw exports are limited to curated datasets and at most 1,000 rows per
request.

Scenario assumptions use decimal rates (`0.07` means 7%). Allocation-change
scenarios accept `current_allocation`, `proposed_allocation`, and
`expected_annual_returns` objects keyed by the same asset-class names. Weights
are normalized by the server, and the response states the projection caveats.

## Recommended client workflow

1. Call `finance_get_context` to learn account IDs, coverage, and definitions.
2. Call `finance_get_data_health` before performance, tax, or other high-stakes analysis.
3. Prefer grouped and analytical tools over raw exports.
4. Use `finance_export_dataset` only when the other tools cannot express the question.
5. Surface every warning returned by a tool in the final answer.

For example, an S&P 500 comparison should call `finance_analyze_investments`
with a stored benchmark symbol. The server aligns the portfolio and benchmark,
calculates reproducible statistics, and reports missing cash-flow or benchmark
coverage; the agent explains the result and its limitations.

## Semantic data foundations

Migration `013_financial_semantics.sql` adds the data needed for accurate,
reusable analysis:

- normalized transaction classifications;
- external investment cash flows;
- benchmark adjusted-price or total-return history;
- a security master and trade history;
- tax lots;
- debt terms; and
- recurring-expense history.

The tools remain usable before these tables are populated, but analyses that
depend on missing data return explicit coverage fields and warnings. In
particular, true time-weighted investment performance needs dated external cash
flows, benchmark comparison needs benchmark history, and tax analysis needs
trades and tax lots. `finance_get_data_health` is the authoritative readiness
check.

Apply the schema with:

```bash
cd backend
npm run migrate
```

## Local protocol check

After starting the backend and obtaining a JWT, initialize the endpoint:

```bash
curl http://localhost:3000/mcp \
  -H "Authorization: Bearer $JWT" \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"local-check","version":"1.0.0"}}}'
```

Automated protocol and tool-catalog coverage lives in `tests/mcp.test.js`.
