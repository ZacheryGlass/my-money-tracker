-- Complete the pre-USDS Gnosis bridge registry for native xDAI exits.
--
-- On Gnosis, the legacy bridge accepted native xDAI through a direct value
-- transfer to the bridge contract. The bridge decoder already supports this
-- exact transaction shape, but migration 074 populated the endpoint metadata
-- without opting the production row into its `legacy_source` variant. That
-- made valid source receipts visible as bridge activity yet undecodable.
--
-- The source transaction hash is the protocol's correlation key and appears
-- verbatim in Ethereum's RelayedMessage event, so no address, amount, or time
-- heuristic is used to join the two sides.
UPDATE eth_bridge_endpoints
   SET metadata = jsonb_set(
         metadata,
         '{abi_variants,legacy_source}',
         '{
           "supported": true,
           "direction": "out",
           "source_chain_id": 100,
           "destination_chain_id": 1,
           "canonical_asset": "XDAI",
           "canonical_decimals": 18,
           "reference_type": "source_transaction_hash",
           "required_identity_fields": [
             "protocol_asset",
             "source_chain_id",
             "destination_chain_id",
             "deployment_key",
             "reference_type"
           ]
         }'::jsonb,
         true
       )
 WHERE protocol = 'gnosis'
   AND family_version = 'legacy-xdai'
   AND chain_id = 100
   AND address = '0x7301cfa0e1756b71869e93d4e4dca5c7d0eb0aa6';
