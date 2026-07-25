-- Splits "labeled" from "is an exchange". Before this, the mere existence of an
-- eth_address_labels row meant "this counterparty is an exchange", so there was
-- no way to record "I looked at this address and it is genuinely a third party"
-- or "this address is mine". That gap is what made a rotated exchange hot wallet
-- indistinguishable from an unreviewed stranger: both are silently CRYPTO_EXTERNAL.
--
--   'exchange' -> counterparty_exchange is set; mirrors as CRYPTO_EXCHANGE_DEPOSIT
--                 /_WITHDRAWAL -> direction 'internal_transfer'.
--   'external' -> reviewed, but NOT an exchange. counterparty_exchange stays NULL
--                 and the transfer keeps mirroring as CRYPTO_EXTERNAL. The row
--                 exists only to take the address out of the triage queue -- and,
--                 for a user row shadowing a builtin, to neutralize a wrong builtin.
--   'own'      -> the user's own address, but not tracked as a wallet. Joins the
--                 own set in EthTransfer.reclassifyCounterparties' FIRST statement,
--                 so it mirrors as CRYPTO_SELF_TRANSFER without creating an account
--                 or syncing. Strictly user-scoped: a global "this address is
--                 yours" row would be nonsense, unlike the builtin exchange labels.
--
-- Re-runs every boot. Every statement below is idempotent and converges from any
-- starting state -- which is why the column, its default, its NOT NULL and its
-- CHECK are four separate statements rather than one ADD COLUMN IF NOT EXISTS:
-- the combined form skips ALL of them once the column exists, so a half-applied
-- deploy would leave the constraint permanently uncreated.
ALTER TABLE eth_address_labels ADD COLUMN IF NOT EXISTS kind VARCHAR(10);

-- Every row that predates this column meant "exchange".
UPDATE eth_address_labels SET kind = 'exchange' WHERE kind IS NULL;

-- The DEFAULT is load-bearing, not cosmetic: 029's builtin exchange seed re-runs
-- every boot and does not name `kind`, and it runs BEFORE this file (so it cannot
-- reference the column at all on a fresh database). Any builtin address added to
-- 029 later must therefore land as 'exchange' without 029 knowing this exists.
ALTER TABLE eth_address_labels ALTER COLUMN kind SET DEFAULT 'exchange';
ALTER TABLE eth_address_labels ALTER COLUMN kind SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_address_labels'::regclass
                   AND conname = 'eth_address_labels_kind_check') THEN
    ALTER TABLE eth_address_labels
      ADD CONSTRAINT eth_address_labels_kind_check
      CHECK (kind IN ('exchange', 'external', 'own'));
  END IF;
END $$;

-- The two partial unique indexes from 029 are deliberately untouched.
-- uq_eth_address_labels_user_address (user_id, address) WHERE user_id IS NOT NULL
-- is what makes `kind` a DECISION rather than a tag -- one verdict per user per
-- address, so an address can never be both exchange and own -- and it is
-- EthAddressLabel.upsert's ON CONFLICT inference target.
