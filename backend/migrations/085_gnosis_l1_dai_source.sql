-- The legacy Ethereum -> Gnosis deposit calls DAI.transfer(bridge, amount).
-- Add that exact, asset-bounded receipt shape to the Ethereum endpoint. The
-- destination bridge event carries the source transaction hash, so this path
-- has protocol identity on both sides and does not need an amount/time guess.

UPDATE eth_bridge_endpoints
   SET metadata = jsonb_set(
         metadata,
         '{abi_variants,erc20_transfer_source}',
         '{
           "supported": true,
           "direction": "out",
           "source_chain_id": 1,
           "destination_chain_id": 100,
           "canonical_asset": "XDAI",
           "canonical_decimals": 18,
           "source_asset_contracts": [
             "0x6b175474e89094c44da98b954eedeac495271d0f"
           ],
           "required_identity_fields": [
             "protocol_asset",
             "source_chain_id",
             "destination_chain_id",
             "deployment_key",
             "reference_type"
           ],
           "reference_type": "source_transaction_hash"
         }'::jsonb,
         true
       )
 WHERE protocol = 'gnosis'
   AND family_version = 'legacy-xdai'
   AND chain_id = 1
   AND address = '0x4aa42145aa6ebf72e164c9bbc74fbd3788045016';
