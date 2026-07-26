-- Historical USD valuation: a dated price series, so a 2017 transfer is worth
-- 2017 dollars.
--
-- Before this, every USD figure on the on-chain side came from a CURRENT price
-- (price_cache for ETH, CoinGecko simple/token_price for tokens), so the ledger
-- valued a mid-2017 half-ETH send at today's ~$1,800 instead of the ~$150 it
-- actually was -- an order of magnitude, on the exact rows a tax or audit
-- reconciliation reads.
--
-- Shape follows benchmark_prices (013): a shared/global dated series with no
-- user column, filled by a scheduled job, joined by date at read time.
-- Valuations still flow through user-scoped reads -- prices are market data,
-- like price_cache and security_master.
--
-- PRICE SOURCES (probed live 2026-07-26, not taken from docs alone):
--
--   * CoinGecko /coins/{id}/market_chart/range
--     https://docs.coingecko.com/reference/coins-id-market-chart-range
--     Daily granularity above a 90-day span; one call covers a whole backfill
--     window. THE PUBLIC/DEMO TIER REFUSES ANYTHING OLDER THAN 365 DAYS --
--     verified, not assumed:
--       GET .../coins/ethereum/market_chart/range?vs_currency=usd
--           &from=1483228800&to=1485907200   (January 2017)
--       -> {"error":{"status":{"error_code":10012,"error_message":
--          "Your request exceeds the allowed time range. Public API users are
--           limited to querying historical data within the past 365 days..."}}}
--     A paid key lifts that and serves the full history from this one endpoint.
--
--   * Coinbase Exchange GET /products/{product_id}/candles
--     https://docs.cdp.coinbase.com/exchange/reference/exchangerestapi_getproductcandles
--     Keyless, public, granularity 86400 = one daily candle, max 300 candles
--     per request (the over-cap error was confirmed live), ~10 req/s. ETH-USD
--     goes back to 2016-05-18, which is what actually makes 2017 dollars
--     reachable on a free deployment. Used for the native asset only: it is a
--     fiat-pair venue and has no notion of an ERC-20 contract address.
--
--   * Tokens have exactly one option -- CoinGecko
--     /coins/{platform}/contract/{contract}/market_chart/range, keyed by the
--     CHAIN's asset platform (config/chains.js coingeckoPlatform). Anything the
--     provider will not serve stays ABSENT from this table rather than being
--     stored as 0: a missing row reads as `unpriced`, which is the whole point.
--
-- Re-runs on every boot, so every statement below is idempotent.

-- One USD close per (asset, day). The asset key is a string rather than a
-- ticker because a token's identity is its (chain, contract) pair, never its
-- symbol -- symbols collide constantly on chain and the same address is a
-- different asset on Arbitrum than on mainnet (039). See utils/assetPriceKey.js
-- for the two forms: 'ETH' and 'erc20:<chain_id>:<contract>'.
--
-- price_usd is NUMERIC, never a float: a token priced at 3.2e-13 and a
-- 78-digit wei quantity multiply out to a number that binary floating point
-- cannot represent, and the product is a dollar figure the user reconciles
-- against a tax record.
CREATE TABLE IF NOT EXISTS asset_price_history (
  asset_key VARCHAR(120) NOT NULL,
  price_date DATE NOT NULL,
  price_usd NUMERIC(38, 18) NOT NULL CHECK (price_usd >= 0),
  source VARCHAR(40) NOT NULL,
  fetched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (asset_key, price_date)
);

-- The valuation join is always "the newest close at or before this date", so
-- the PK's (asset_key, price_date) order already serves it. This second index
-- serves the job's cross-asset gap scan ("what is stale everywhere?").
CREATE INDEX IF NOT EXISTS idx_asset_price_history_date
  ON asset_price_history(price_date);

-- Why an asset has no series, remembered.
--
-- Two jobs at once. (1) The acceptance criterion "unpriced tokens ... are
-- enumerated (not silently zero)" needs a list that can be shown to the user
-- without re-probing five providers to rebuild it. (2) The nightly job must not
-- re-request a dead EtherDelta-era token every single night forever; a stored
-- 'unlisted' verdict is what bounds the request count to the assets that can
-- actually answer.
--
-- Global, like the series itself: whether CoinGecko lists a contract is a fact
-- about the contract, not about the user who happens to hold it.
CREATE TABLE IF NOT EXISTS asset_price_coverage (
  asset_key VARCHAR(120) PRIMARY KEY,
  asset_symbol VARCHAR(64),
  chain_id INT,
  contract_address VARCHAR(42),
  -- covered      -- a series exists and is being extended
  -- unlisted     -- the provider has no series for this asset, ever
  -- range_limited-- a series exists but the plan will not serve dates this old
  -- error        -- transient; retried on the next run
  status VARCHAR(20) NOT NULL DEFAULT 'error',
  provider VARCHAR(40),
  earliest_date DATE,
  latest_date DATE,
  detail VARCHAR(300),
  checked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Guarded on the constraint's DEFINITION, not just its name, exactly like
-- 038's category check: a name-only guard is satisfied by the constraint that
-- already exists, so a later widening would be skipped forever on every
-- deployed database while looking applied on a fresh one. BUMP THE SENTINEL
-- ('range_limited', the newest value) when adding a status.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'asset_price_coverage'::regclass
                   AND conname = 'asset_price_coverage_status_check'
                   AND pg_get_constraintdef(oid) LIKE '%range_limited%') THEN
    ALTER TABLE asset_price_coverage DROP CONSTRAINT IF EXISTS asset_price_coverage_status_check;
    ALTER TABLE asset_price_coverage
      ADD CONSTRAINT asset_price_coverage_status_check
      CHECK (status IN ('covered', 'unlisted', 'range_limited', 'error'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_asset_price_coverage_status
  ON asset_price_coverage(status);

-- The valuation itself, denormalized onto the leg it values.
--
-- Same idiom as counterparty_is_own / counterparty_exchange (026) and
-- method_name (034): derived wholesale by a single SQL pass and rewritten on
-- every sync, so there is exactly ONE implementation of "what was this worth"
-- and it lives in SQL with exact NUMERIC arithmetic. The mirror and the
-- activity layer READ these columns rather than each recomputing a price, which
-- is what makes re-running classification produce byte-identical valuations.
--
-- NULL usd_at_time is UNPRICED, never zero. usd_basis says why:
--   exact          -- a close exists for the leg's own date
--   carried        -- no close that day; the newest close within the carry
--                     window was used (a 24/7 market with a one-day gap is a
--                     provider hiccup, not a repricing). NEVER carried
--                     BACKWARD, and never from today: that is the exact bug
--                     this migration exists to remove.
--   unpriced       -- no close reachable; the row is excluded from USD sums
--   not_applicable -- the leg has no USD meaning: an NFT leg's value_wei is a
--                     COUNT OF UNITS (033), and a reverted transfer moved
--                     nothing. NFT valuation is explicitly out of scope -- the
--                     ETH leg of a purchase already carries what was paid.
ALTER TABLE eth_transfers ADD COLUMN IF NOT EXISTS usd_at_time NUMERIC(20, 2);
ALTER TABLE eth_transfers ADD COLUMN IF NOT EXISTS usd_basis VARCHAR(16);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_transfers'::regclass
                   AND conname = 'eth_transfers_usd_basis_check'
                   AND pg_get_constraintdef(oid) LIKE '%not_applicable%') THEN
    ALTER TABLE eth_transfers DROP CONSTRAINT IF EXISTS eth_transfers_usd_basis_check;
    ALTER TABLE eth_transfers
      ADD CONSTRAINT eth_transfers_usd_basis_check
      CHECK (usd_basis IS NULL
             OR usd_basis IN ('exact', 'carried', 'unpriced', 'not_applicable'));
  END IF;
END $$;

-- The transaction-level rollup, summed from the legs above.
--
--   usd_value -- what the transaction MOVED, at the time: the outbound side
--                when there is one, else the inbound side. A swap of 1 ETH for
--                3,000 USDC is one $3,000 event, not a $6,000 one.
--   usd_fee   -- gas, at the time. Separate because a fee is a cost whichever
--                way the value went, and because a reverted transaction has a
--                real fee and no value.
--   usd_basis -- the WEAKEST basis among the legs that fed usd_value:
--                one unpriced leg makes the total unpriced, because a partial
--                sum presented as a total is the silent-zero failure wearing a
--                different hat.
ALTER TABLE eth_activity ADD COLUMN IF NOT EXISTS usd_value NUMERIC(20, 2);
ALTER TABLE eth_activity ADD COLUMN IF NOT EXISTS usd_fee NUMERIC(20, 2);
ALTER TABLE eth_activity ADD COLUMN IF NOT EXISTS usd_basis VARCHAR(16);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'eth_activity'::regclass
                   AND conname = 'eth_activity_usd_basis_check'
                   AND pg_get_constraintdef(oid) LIKE '%not_applicable%') THEN
    ALTER TABLE eth_activity DROP CONSTRAINT IF EXISTS eth_activity_usd_basis_check;
    ALTER TABLE eth_activity
      ADD CONSTRAINT eth_activity_usd_basis_check
      CHECK (usd_basis IS NULL
             OR usd_basis IN ('exact', 'carried', 'unpriced', 'not_applicable'));
  END IF;
END $$;

-- The nightly job's work list is "every (asset, date) the ledger references",
-- which scans eth_transfers by chain + contract. Partial: gas, native and
-- internal legs carry no contract and are all one asset key.
CREATE INDEX IF NOT EXISTS idx_eth_transfers_token_asset
  ON eth_transfers(chain_id, token_contract)
  WHERE token_contract IS NOT NULL;

-- Rows valued before a price landed have to be findable again once the backfill
-- reaches their dates, without rescanning a full history every night.
CREATE INDEX IF NOT EXISTS idx_eth_transfers_unpriced
  ON eth_transfers(wallet_id)
  WHERE usd_basis IS NULL OR usd_basis = 'unpriced';
