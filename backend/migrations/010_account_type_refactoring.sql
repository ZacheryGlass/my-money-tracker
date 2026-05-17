-- Migrate existing seeded accounts to meaningful types
UPDATE accounts SET type = 'crypto' WHERE name = 'Crypto' AND type = 'investment';
UPDATE accounts SET type = 'loan' WHERE name = 'Liability' AND type = 'static';
UPDATE accounts SET type = 'property' WHERE name = 'Real Estate' AND type = 'static';

-- Plaid-linked 'static' accounts with negative holdings => credit
UPDATE accounts SET type = 'credit'
WHERE type = 'static' AND plaid_account_id IS NOT NULL
AND id IN (
  SELECT account_id FROM holdings
  WHERE manual_value < 0 AND is_plaid_managed = TRUE
);

-- Remaining Plaid-linked 'static' => depository
UPDATE accounts SET type = 'depository'
WHERE type = 'static' AND plaid_account_id IS NOT NULL;

-- Any remaining 'static' without Plaid => other
UPDATE accounts SET type = 'other' WHERE type = 'static';

-- Add CHECK constraint for valid account types
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'accounts_type_check'
      AND conrelid = 'accounts'::regclass
  ) THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_type_check
      CHECK (type IN ('investment', 'depository', 'credit', 'loan', 'crypto', 'property', 'other'));
  END IF;
END $$;
