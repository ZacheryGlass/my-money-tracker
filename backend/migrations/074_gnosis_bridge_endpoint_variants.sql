-- Gnosis xDAI bridge decoder variants for bridge-match-v1.
--
-- Migration 072 seeded the chain-scoped endpoint rows, but the first decoder
-- only used the endpoint address as a routing hint. Keep the endpoint table as
-- the single runtime registry and add the deployment/ABI/asset policy needed
-- by the Gnosis adapter. The official USDS migration transactions provide the
-- activation boundaries for the post-migration endpoint family:
--   Ethereum: block 23748179
--   Gnosis:   block 43027713
--
-- The legacy rows intentionally have an open lower bound. Their exact proxy
-- deployment block is not needed to distinguish the reviewed pre-migration
-- path, while the upper bound prevents post-migration receipts from being
-- decoded with the old message semantics.

UPDATE eth_bridge_endpoints
   SET valid_to_block = 23748178,
       metadata = metadata || '{
         "deployment_key": "gnosis-xdai-legacy-pre-usds",
         "finality_policy": {
           "method": "eth_getBlockByNumber",
           "tag": "finalized"
         },
         "abi_variants": {
           "legacy_source": {
             "supported": true,
             "direction": "out",
             "source_chain_id": 1,
             "destination_chain_id": 100,
             "canonical_asset": "XDAI",
             "reference_type": "source_transaction_hash"
           },
           "relayed_message_destination": {
             "supported": true,
             "direction": "in",
             "source_chain_id": 100,
             "destination_chain_id": 1,
             "canonical_asset": "XDAI",
             "reference_type": "source_transaction_hash"
           }
         }
       }'::jsonb
 WHERE protocol = 'gnosis'
   AND family_version = 'legacy-xdai'
   AND chain_id = 1
   AND address = '0x4aa42145aa6ebf72e164c9bbc74fbd3788045016';

UPDATE eth_bridge_endpoints
   SET valid_to_block = 43027712,
       metadata = metadata || '{
         "deployment_key": "gnosis-xdai-legacy-pre-usds",
         "finality_policy": {
           "method": "eth_getBlockByNumber",
           "tag": "finalized"
         },
         "abi_variants": {
           "affirmation_completed_destination": {
             "supported": true,
             "direction": "in",
             "source_chain_id": 1,
             "destination_chain_id": 100,
             "canonical_asset": "XDAI",
             "reference_type": "source_transaction_hash",
             "required_identity_fields": [
               "protocol_asset",
               "source_chain_id",
               "destination_chain_id",
               "deployment_key",
               "reference_type"
             ]
           },
           "erc20_transfer_source": {
             "supported": true,
             "direction": "out",
             "source_chain_id": 100,
             "destination_chain_id": 1,
             "canonical_asset": "XDAI",
             "source_asset_contracts": [
               "0xe91d153e0b41518a2ce8dd3d7944fa863463a97d"
             ],
             "required_identity_fields": [
               "protocol_asset",
               "source_chain_id",
               "destination_chain_id",
               "deployment_key",
               "reference_type"
             ],
             "reference_type": "source_transaction_hash"
           }
         }
       }'::jsonb
 WHERE protocol = 'gnosis'
   AND family_version = 'legacy-xdai'
   AND chain_id = 100
   AND address = '0x7301cfa0e1756b71869e93d4e4dca5c7d0eb0aa6';

UPDATE eth_bridge_endpoints
   SET valid_from_block = 23748179,
       metadata = metadata || '{
         "deployment_key": "gnosis-xdai-usds-router-post-migration",
         "finality_policy": {
           "method": "eth_getBlockByNumber",
           "tag": "finalized"
         },
         "abi_variants": {
           "router_v2": {
             "supported": false,
             "direction": "out",
             "source_chain_id": 1,
             "destination_chain_id": 100,
             "canonical_asset": "XDAI",
             "source_asset_contracts": [
               "0x6b175474e89094c44da98b954eedeac495271d0f",
               "0xdc035d45d973e3ec169d2276ddab16f1e407384f"
             ],
             "unsupported_reason": "router_message_identity_not_decoded"
           }
         }
       }'::jsonb
 WHERE protocol = 'gnosis'
   AND family_version = 'usds-router'
   AND chain_id = 1
   AND address = '0x9a873656c19efecbfb4f9fab5b7acdeab466a0b0';

UPDATE eth_bridge_endpoints
   SET valid_from_block = 43027713,
       metadata = metadata || '{
         "deployment_key": "gnosis-xdai-usds-router-post-migration",
         "finality_policy": {
           "method": "eth_getBlockByNumber",
           "tag": "finalized"
         },
         "abi_variants": {
           "deposit_contract_v1": {
             "supported": false,
             "direction": "out",
             "source_chain_id": 100,
             "destination_chain_id": 1,
             "canonical_asset": "XDAI",
             "unsupported_reason": "router_message_identity_not_decoded"
           }
         }
       }'::jsonb
 WHERE protocol = 'gnosis'
   AND family_version = 'usds-router'
   AND chain_id = 100
   AND address = '0x5c183c8a49aba6e31049997a56d75600e27ff8c9';

UPDATE eth_bridge_endpoints
   SET metadata = metadata || '{
     "finality_policy": {
       "method": "eth_getBlockByNumber",
       "tag": "finalized"
     },
     "abi_variants": {
       "block_reward_credit": {
         "supported": false,
         "direction": "in",
         "unsupported_reason": "consensus_credit_is_not_the_source_execution_identity"
       }
     }
   }'::jsonb
 WHERE protocol = 'gnosis'
   AND family_version = 'legacy-xdai'
   AND chain_id = 100
   AND address = '0x481c034c6d9441db23ea48de68bcae812c5d39ba';
