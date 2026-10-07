-- 067 seeds the curated EtherDelta custody label with ON CONFLICT DO NOTHING,
-- but 036's scraped pack inserts the same address first on every database
-- ('EtherDelta 2', source 'eth-labels'), so the curated row never landed and
-- everything keyed on source = 'builtin-etherdelta' (the custody rung, the
-- mirror's custody mapping) never fired. Promote the scraped row in place.
--
-- Idempotent: once promoted the WHERE matches nothing. A user's own row for
-- the address is a separate row (user_id NOT NULL) and is untouched.
UPDATE eth_address_labels
   SET name = 'EtherDelta',
       source = 'builtin-etherdelta',
       kind = 'external',
       confidence = 'high',
       note = 'Historical EtherDelta custody/order-book contract. Deposits and withdrawals are visible on chain; internal fills may be absent from standard transfer feeds. Source: https://etherscan.io/address/0x8d12a197cb00d4747a1fe03395095ce2a5cc6819'
 WHERE user_id IS NULL
   AND address = '0x8d12a197cb00d4747a1fe03395095ce2a5cc6819'
   AND source = 'eth-labels';
