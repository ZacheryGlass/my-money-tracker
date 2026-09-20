BEGIN;

-- Older writers named Blockscout's V2 base URL for every feed whenever a
-- chain exposed one, even though only explicitly flagged normal/internal
-- feeds used V2. Correct the provenance metadata to the endpoint that actually
-- served these rows. The economic rows and proven boundaries are unchanged.
UPDATE eth_feed_coverage
   SET provider = 'Blockscout (https://arbitrum-nova.blockscout.com/api)',
       updated_at = CURRENT_TIMESTAMP
 WHERE chain_id = 42170
   AND feed IN ('internal', 'token', 'nft', 'nft1155', 'statesync')
   AND provider = 'Blockscout (https://arbitrum-nova.blockscout.com/api/v2/)';

UPDATE eth_feed_coverage
   SET provider = 'Blockscout (https://gnosisscan.io/api)',
       updated_at = CURRENT_TIMESTAMP
 WHERE chain_id = 100
   AND feed IN ('token', 'nft', 'nft1155', 'statesync')
   AND provider = 'Blockscout (https://gnosisscan.io/api/v2/)';

UPDATE eth_feed_coverage
   SET provider = 'Blockscout (https://explorer.optimism.io/api)',
       updated_at = CURRENT_TIMESTAMP
 WHERE chain_id = 10
   AND feed IN ('internal', 'token', 'nft', 'nft1155', 'statesync')
   AND provider = 'Blockscout (https://explorer.optimism.io/api/v2/)';

COMMIT;
