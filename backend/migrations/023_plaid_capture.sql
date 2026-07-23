-- Capture the Plaid fields the sync was discarding: account subtypes/balances,
-- institution cost basis, transaction enrichment detail, security sectors, and
-- the liability terms that debt_terms was designed for but never received.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS subtype VARCHAR(50);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS mask VARCHAR(10);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tax_treatment VARCHAR(20);
-- Raw Plaid convention: credit and loan balances are positive amounts owed.
-- Deliberately NOT the negated convention used by the pseudo-holdings.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS balance_available DECIMAL(15, 2);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS balance_current DECIMAL(15, 2);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS balance_limit DECIMAL(15, 2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'accounts_tax_treatment_check'
      AND conrelid = 'accounts'::regclass
  ) THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_tax_treatment_check
      CHECK (tax_treatment IS NULL OR tax_treatment IN ('taxable', 'traditional', 'roth', 'hsa'));
  END IF;
END $$;

ALTER TABLE holdings ADD COLUMN IF NOT EXISTS institution_cost_basis DECIMAL(18, 2);
ALTER TABLE holdings ADD COLUMN IF NOT EXISTS institution_price DECIMAL(20, 8);
ALTER TABLE holdings ADD COLUMN IF NOT EXISTS institution_price_as_of DATE;

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS detailed_category VARCHAR(200);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category_confidence VARCHAR(20);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS authorized_date DATE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_channel VARCHAR(50);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS pending_transaction_id VARCHAR(100);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS merchant_entity_id VARCHAR(100);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS website VARCHAR(255);

ALTER TABLE security_master ADD COLUMN IF NOT EXISTS sector VARCHAR(100);
ALTER TABLE security_master ADD COLUMN IF NOT EXISTS industry VARCHAR(100);
ALTER TABLE security_master ADD COLUMN IF NOT EXISTS is_cash_equivalent BOOLEAN;

ALTER TABLE debt_terms ADD COLUMN IF NOT EXISTS next_payment_due_date DATE;
ALTER TABLE debt_terms ADD COLUMN IF NOT EXISTS last_statement_balance DECIMAL(15, 2);
ALTER TABLE debt_terms ADD COLUMN IF NOT EXISTS last_statement_date DATE;
ALTER TABLE debt_terms ADD COLUMN IF NOT EXISTS last_payment_amount DECIMAL(15, 2);
ALTER TABLE debt_terms ADD COLUMN IF NOT EXISTS last_payment_date DATE;
ALTER TABLE debt_terms ADD COLUMN IF NOT EXISTS is_overdue BOOLEAN;

-- Manual (non-Plaid) investment accounts have no subtype to derive from.
-- Matched on `name` because renames are stored in display_name. Migrations
-- re-run on every boot, so a NULL tax_treatment re-seeds here -- which is why
-- PATCH /api/accounts/:id/tax-treatment refuses to set it back to NULL.
UPDATE accounts SET tax_treatment = 'taxable' WHERE name = 'Taxable' AND tax_treatment IS NULL;
UPDATE accounts SET tax_treatment = 'hsa' WHERE name = 'HSA' AND tax_treatment IS NULL;
UPDATE accounts SET tax_treatment = 'traditional' WHERE name = '401k' AND tax_treatment IS NULL;
UPDATE accounts SET tax_treatment = 'roth' WHERE name = 'Roth IRA' AND tax_treatment IS NULL;
