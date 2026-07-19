-- Liability holdings and snapshots must carry negative values.
-- Plaid loan balances were previously stored positive (only credit was
-- negated), which inflated historical net worth by 2x the loan balance
-- relative to the dashboard's current-value convention.

UPDATE holdings h
SET manual_value = -ABS(h.manual_value)
FROM accounts a
WHERE h.account_id = a.id
  AND a.type IN ('loan', 'credit')
  AND h.manual_value > 0;

UPDATE ticker_snapshots ts
SET value = -ABS(ts.value)
FROM accounts a
WHERE ts.account_id = a.id
  AND a.type IN ('loan', 'credit')
  AND ts.value > 0;

UPDATE account_snapshots acs
SET total_value = -ABS(acs.total_value)
FROM accounts a
WHERE acs.account_id = a.id
  AND a.type IN ('loan', 'credit')
  AND acs.total_value > 0;
