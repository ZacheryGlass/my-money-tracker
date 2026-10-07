-- 101: a wallet disconnect that keeps data no longer deletes the user's
-- decisions about that wallet's history.
--
-- Disconnecting deletes the eth_wallets row even with removeData=false (the
-- account is what "keep data" keeps), and four decision tables cascaded away
-- with it: activity overrides (038), exchange match verdicts (041),
-- reconciliation adjustments (048) and bridge verdicts (072). Each now records
-- its owner and the wallet ADDRESS, and its wallet foreign key is ON DELETE SET
-- NULL, so a disconnect detaches the decision instead of destroying it.
-- Readers already join on wallet_id, so a detached row is invisible until
-- re-adding the same address re-links it (EthWalletService.addWallet).
-- Disconnecting with removeData=true still deletes them (EthWallet.delete).
--
-- Idempotent: every step is guarded or naturally a no-op on re-run.

-- 1. Owner and address columns.
ALTER TABLE eth_activity_overrides
  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS wallet_address VARCHAR(42);
ALTER TABLE eth_reconciliation_adjustments
  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS wallet_address VARCHAR(42);
ALTER TABLE exchange_match_verdicts
  ADD COLUMN IF NOT EXISTS wallet_address VARCHAR(42);
ALTER TABLE eth_bridge_verdicts
  ADD COLUMN IF NOT EXISTS out_wallet_address VARCHAR(42),
  ADD COLUMN IF NOT EXISTS in_wallet_address VARCHAR(42);

-- 2. Backfill from the wallet each row points at.
UPDATE eth_activity_overrides t
   SET user_id = w.user_id, wallet_address = w.address
  FROM eth_wallets w
 WHERE w.id = t.wallet_id
   AND (t.user_id IS DISTINCT FROM w.user_id OR t.wallet_address IS DISTINCT FROM w.address);
UPDATE eth_reconciliation_adjustments t
   SET user_id = w.user_id, wallet_address = w.address
  FROM eth_wallets w
 WHERE w.id = t.wallet_id
   AND (t.user_id IS DISTINCT FROM w.user_id OR t.wallet_address IS DISTINCT FROM w.address);
UPDATE exchange_match_verdicts t
   SET wallet_address = w.address
  FROM eth_wallets w
 WHERE w.id = t.wallet_id AND t.wallet_address IS DISTINCT FROM w.address;
UPDATE eth_bridge_verdicts t
   SET out_wallet_address = ow.address, in_wallet_address = iw.address
  FROM eth_wallets ow, eth_wallets iw
 WHERE ow.id = t.out_wallet_id AND iw.id = t.in_wallet_id
   AND (t.out_wallet_address IS DISTINCT FROM ow.address
        OR t.in_wallet_address IS DISTINCT FROM iw.address);

-- 3. Keep them populated on every write, whatever path writes the row.
CREATE OR REPLACE FUNCTION fill_decision_wallet_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.wallet_id IS NOT NULL THEN
    IF TG_TABLE_NAME = 'exchange_match_verdicts' THEN
      SELECT address INTO NEW.wallet_address FROM eth_wallets WHERE id = NEW.wallet_id;
    ELSE
      SELECT user_id, address INTO NEW.user_id, NEW.wallet_address
        FROM eth_wallets WHERE id = NEW.wallet_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fill_override_wallet_identity ON eth_activity_overrides;
CREATE TRIGGER trg_fill_override_wallet_identity
BEFORE INSERT OR UPDATE OF wallet_id ON eth_activity_overrides
FOR EACH ROW EXECUTE FUNCTION fill_decision_wallet_identity();

DROP TRIGGER IF EXISTS trg_fill_adjustment_wallet_identity ON eth_reconciliation_adjustments;
CREATE TRIGGER trg_fill_adjustment_wallet_identity
BEFORE INSERT OR UPDATE OF wallet_id ON eth_reconciliation_adjustments
FOR EACH ROW EXECUTE FUNCTION fill_decision_wallet_identity();

DROP TRIGGER IF EXISTS trg_fill_match_verdict_wallet_identity ON exchange_match_verdicts;
CREATE TRIGGER trg_fill_match_verdict_wallet_identity
BEFORE INSERT OR UPDATE OF wallet_id ON exchange_match_verdicts
FOR EACH ROW EXECUTE FUNCTION fill_decision_wallet_identity();

CREATE OR REPLACE FUNCTION fill_bridge_verdict_wallet_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.out_wallet_id IS NOT NULL THEN
    SELECT address INTO NEW.out_wallet_address FROM eth_wallets WHERE id = NEW.out_wallet_id;
  END IF;
  IF NEW.in_wallet_id IS NOT NULL THEN
    SELECT address INTO NEW.in_wallet_address FROM eth_wallets WHERE id = NEW.in_wallet_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fill_bridge_verdict_wallet_identity ON eth_bridge_verdicts;
CREATE TRIGGER trg_fill_bridge_verdict_wallet_identity
BEFORE INSERT OR UPDATE OF out_wallet_id, in_wallet_id ON eth_bridge_verdicts
FOR EACH ROW EXECUTE FUNCTION fill_bridge_verdict_wallet_identity();

-- 4. A detached row has no wallet. 072's ownership trigger (re-created by 072
-- on every boot, so restated here, after it) checks a side only when it names
-- a wallet AND is being set: ON DELETE SET NULL fires it as an UPDATE of one
-- column while the wallet row is already gone, so re-checking the untouched
-- side would refuse the disconnect.
CREATE OR REPLACE FUNCTION validate_eth_bridge_pair_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  out_owner INTEGER;
  in_owner INTEGER;
BEGIN
  IF NEW.out_wallet_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.out_wallet_id IS DISTINCT FROM OLD.out_wallet_id
          OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    SELECT user_id INTO out_owner FROM eth_wallets WHERE id = NEW.out_wallet_id;
    IF out_owner IS NULL OR out_owner <> NEW.user_id THEN
      RAISE EXCEPTION 'bridge pair wallets must belong to the row owner';
    END IF;
  END IF;
  IF NEW.in_wallet_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.in_wallet_id IS DISTINCT FROM OLD.in_wallet_id
          OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    SELECT user_id INTO in_owner FROM eth_wallets WHERE id = NEW.in_wallet_id;
    IF in_owner IS NULL OR in_owner <> NEW.user_id THEN
      RAISE EXCEPTION 'bridge pair wallets must belong to the row owner';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE eth_activity_overrides ALTER COLUMN wallet_id DROP NOT NULL;
ALTER TABLE eth_reconciliation_adjustments ALTER COLUMN wallet_id DROP NOT NULL;
ALTER TABLE eth_bridge_verdicts ALTER COLUMN out_wallet_id DROP NOT NULL;
ALTER TABLE eth_bridge_verdicts ALTER COLUMN in_wallet_id DROP NOT NULL;

-- 041's one-shape CHECK required a wallet id on every on-chain verdict; a
-- detached on-chain verdict keeps its address instead.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'exchange_match_verdicts'::regclass
                   AND conname = 'exchange_match_verdicts_one_shape_check'
                   AND pg_get_constraintdef(oid) LIKE '%wallet_address%') THEN
    ALTER TABLE exchange_match_verdicts DROP CONSTRAINT IF EXISTS exchange_match_verdicts_one_shape_check;
    ALTER TABLE exchange_match_verdicts
      ADD CONSTRAINT exchange_match_verdicts_one_shape_check
      CHECK (
        (counter_record_id IS NULL
          AND (wallet_id IS NOT NULL OR wallet_address IS NOT NULL)
          AND chain_id IS NOT NULL AND tx_hash IS NOT NULL)
        OR
        (counter_record_id IS NOT NULL
          AND wallet_id IS NULL AND chain_id IS NULL AND tx_hash IS NULL)
      );
  END IF;
END $$;

-- 5. Swap each wallet foreign key from CASCADE to SET NULL.
DO $$
DECLARE
  target RECORD;
  fk RECORD;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('eth_activity_overrides', 'wallet_id'),
      ('eth_reconciliation_adjustments', 'wallet_id'),
      ('exchange_match_verdicts', 'wallet_id'),
      ('eth_bridge_verdicts', 'out_wallet_id'),
      ('eth_bridge_verdicts', 'in_wallet_id')
    ) AS t(table_name, column_name)
  LOOP
    FOR fk IN
      SELECT c.conname, c.confdeltype
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f'
         AND c.conrelid = target.table_name::regclass
         AND c.confrelid = 'eth_wallets'::regclass
         AND array_length(c.conkey, 1) = 1
         AND a.attname = target.column_name
    LOOP
      IF fk.confdeltype <> 'n' THEN
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', target.table_name, fk.conname);
        EXECUTE format(
          'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES eth_wallets(id) ON DELETE SET NULL',
          target.table_name, fk.conname, target.column_name
        );
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- 6. Re-linking looks rows up by owner and address.
CREATE INDEX IF NOT EXISTS idx_eth_activity_overrides_detached
  ON eth_activity_overrides (user_id, wallet_address) WHERE wallet_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_eth_reconciliation_adjustments_detached
  ON eth_reconciliation_adjustments (user_id, wallet_address) WHERE wallet_id IS NULL;
