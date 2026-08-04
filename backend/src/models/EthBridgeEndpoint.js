'use strict';

const pool = require('../config/database');

class EthBridgeEndpoint {
  static async findForChains(chainIds, client = pool) {
    const ids = [...new Set((chainIds || []).map(Number).filter(Number.isInteger))];
    if (!ids.length) return [];
    const { rows } = await client.query(
      `SELECT id, protocol, family_version, chain_id, address, name, role,
              direction, valid_from_block, valid_to_block, source_url, metadata
         FROM eth_bridge_endpoints
        WHERE enabled AND chain_id = ANY($1::int[])
        ORDER BY protocol, family_version, chain_id, address, role`,
      [ids]
    );
    return rows;
  }

  static async findForTransactions(coordinates, client = pool) {
    const chains = [...new Set((coordinates || []).map((row) => Number(row.chain_id)))];
    return this.findForChains(chains, client);
  }
}

module.exports = EthBridgeEndpoint;
