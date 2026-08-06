'use strict';

const pool = require('../config/database');

class EthHopBridgeRoute {
  static async findForChains(chainIds, client = pool) {
    const ids = [...new Set((chainIds || []).map(Number).filter(Number.isInteger))];
    if (!ids.length) return [];
    const { rows } = await client.query(
      `SELECT id, deployment_key, family_version, route_key, asset_key,
              source_chain_id, destination_chain_id,
              source_bridge_address, source_wrapper_address,
              destination_bridge_address, destination_wrapper_address,
              source_asset_addresses, destination_asset_addresses,
              source_token_indices, destination_token_indices,
              source_valid_from_block, source_valid_to_block,
              destination_valid_from_block, destination_valid_to_block,
              abi_variant, finality_policy, source_url, source_commit, metadata
         FROM eth_hop_bridge_routes
        WHERE enabled
          AND (source_chain_id = ANY($1::int[]) OR destination_chain_id = ANY($1::int[]))
        ORDER BY asset_key, source_chain_id, destination_chain_id, route_key`,
      [ids]
    );
    return rows;
  }

  static async findForTransactions(coordinates, client = pool) {
    return this.findForChains(
      [...new Set((coordinates || []).map((row) => Number(row.chain_id)))],
      client
    );
  }
}

module.exports = EthHopBridgeRoute;
