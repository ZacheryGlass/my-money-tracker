-- Per-user ownership columns on the ownership ROOT tables only. Children
-- (holdings, transactions, snapshots, trades, tax_lots, debt_terms,
-- investment_cash_flows, eth_transfers, recurring_expense_history) inherit
-- scope through their account / wallet / recurring-expense foreign keys.
--
-- Purely additive: columns stay nullable and old constraints stay in place
-- until migration 029 enforces them, so intermediate deploys keep working.

ALTER TABLE accounts           ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id);
ALTER TABLE plaid_items        ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id);
ALTER TABLE eth_wallets        ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id);
ALTER TABLE salary_history     ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id);
ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id);
ALTER TABLE ignored_merchants  ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id);
ALTER TABLE eth_ignored_tokens ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id);
ALTER TABLE eth_address_labels ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id);

-- Everything that exists today belongs to the original user. Builtin address
-- labels stay NULL: they are global rows shared by every user.
UPDATE accounts           SET user_id = 1 WHERE user_id IS NULL;
UPDATE plaid_items        SET user_id = 1 WHERE user_id IS NULL;
UPDATE eth_wallets        SET user_id = 1 WHERE user_id IS NULL;
UPDATE salary_history     SET user_id = 1 WHERE user_id IS NULL;
UPDATE recurring_expenses SET user_id = 1 WHERE user_id IS NULL;
UPDATE ignored_merchants  SET user_id = 1 WHERE user_id IS NULL;
UPDATE eth_ignored_tokens SET user_id = 1 WHERE user_id IS NULL;
UPDATE eth_address_labels SET user_id = 1 WHERE user_id IS NULL AND source = 'user';

CREATE INDEX IF NOT EXISTS idx_accounts_user    ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_plaid_items_user ON plaid_items(user_id);
CREATE INDEX IF NOT EXISTS idx_eth_wallets_user ON eth_wallets(user_id);
