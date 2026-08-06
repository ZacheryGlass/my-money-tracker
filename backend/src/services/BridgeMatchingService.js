'use strict';

const pool = require('../config/database');
const chains = require('../config/chains');
const logger = require('../config/logger');
const SecretsService = require('./SecretsService');
const EtherscanService = require('./EtherscanService');
const EthBridgeEndpoint = require('../models/EthBridgeEndpoint');
const EthBridgeReceipt = require('../models/EthBridgeReceipt');
const EthBridgeMovement = require('../models/EthBridgeMovement');
const EthActivityLink = require('../models/EthActivityLink');
const EthHopBridgeRoute = require('../models/EthHopBridgeRoute');
const EthFeedCoverage = require('../models/EthFeedCoverage');
const { REVIEW_REASONS } = require('../utils/ethActivityVocabulary');
const { decodeEnvelope, RULE_VERSION } = require('./bridge/adapters');
const {
  buildProtocolMovements, resolveProtocolCoordinateConflicts,
  suggestBridgeLegs, suggestionPairKey, verdictMovement,
} = require('./bridge/matcher');

const MAX_RECEIPTS_PER_REBUILD = 250;
const BRIDGE_LOCK_NAMESPACE = 1112688964; // ASCII-ish "BRID", signed int32-safe.
const lower = (value) => String(value || '').toLowerCase();

function endpointApplies(endpoint, activity) {
  if (Number(endpoint.chain_id) !== Number(activity.chain_id)) return false;
  const hasBounds = endpoint.valid_from_block != null || endpoint.valid_to_block != null;
  const block = Number(activity.block_number);
  if (hasBounds && (!Number.isSafeInteger(block) || block < 0)) return false;
  if (endpoint.valid_from_block != null && block < Number(endpoint.valid_from_block)) return false;
  if (endpoint.valid_to_block != null && block > Number(endpoint.valid_to_block)) return false;
  return true;
}

function unsupportedMovement(envelope, decodedCoordinates) {
  const key = `${Number(envelope.wallet_id)}:${Number(envelope.chain_id)}:${lower(envelope.tx_hash)}`;
  if (decodedCoordinates.has(key)) return null;
  const addresses = new Set([
    lower(envelope.counterparty_address), lower(envelope.transaction?.to), lower(envelope.receipt?.to),
    ...(envelope.receipt?.logs || []).map((log) => lower(log.address)),
  ]);
  const families = new Map((envelope.endpoints || [])
    .filter((endpoint) => addresses.has(lower(endpoint.address)))
    .map((endpoint) => [
      `${endpoint.protocol}:${endpoint.family_version}`,
      { protocol: endpoint.protocol, family_version: endpoint.family_version },
    ]));
  if (families.size !== 1) return null;
  const family = [...families.values()][0];
  return {
    ...family,
    correlation_key: `unsupported:${key}`,
    verification_method: 'protocol_identity',
    status: 'unsupported',
    rule_version: RULE_VERSION,
    evidence: {
      reason: 'known_endpoint_without_decodable_protocol_identity',
      receipt_id: envelope.receipt_id || null,
    },
    members: [{
      wallet_id: Number(envelope.wallet_id),
      chain_id: Number(envelope.chain_id),
      tx_hash: lower(envelope.tx_hash),
      role: envelope.category === 'bridge_out' ? 'initiation' : 'destination_execution',
      receipt_id: envelope.receipt_id || null,
      evidence: { reason: 'protocol_identity_not_decodable' },
    }],
  };
}

function pairKeyFromMovement(movement) {
  const out = (movement.members || []).find((member) => member.role === 'initiation');
  const incoming = (movement.members || []).find(
    (member) => ['destination_execution', 'fill', 'finalization'].includes(member.role)
  );
  return out && incoming ? suggestionPairKey(out, incoming) : null;
}

function pairKeyFromVerdict(verdict) {
  return `${verdict.out_wallet_id}:${verdict.out_chain_id}:${lower(verdict.out_tx_hash)}>`
    + `${verdict.in_wallet_id}:${verdict.in_chain_id}:${lower(verdict.in_tx_hash)}`;
}

class BridgeMatchingService {
  static async _activitiesForUser(userId, client = pool) {
    const { rows } = await client.query(
      `SELECT a.id, a.wallet_id, w.address AS wallet_address, a.chain_id, a.tx_hash, a.block_number,
              a.block_time, a.counterparty_address, a.method_name, a.legs,
              COALESCE(o.category, a.category) AS category
         FROM eth_activity a
         JOIN eth_wallets w ON w.id = a.wallet_id
         LEFT JOIN eth_activity_overrides o
           ON o.wallet_id = a.wallet_id AND o.chain_id = a.chain_id AND o.tx_hash = a.tx_hash
        WHERE w.user_id = $1
          AND COALESCE(o.category, a.category) IN ('bridge_out', 'bridge_in')
        ORDER BY a.block_time, a.chain_id, a.id`,
      [userId]
    );
    if (rows.length > MAX_RECEIPTS_PER_REBUILD) {
      const error = new Error(`Bridge evidence rebuild exceeded ${MAX_RECEIPTS_PER_REBUILD} candidate transactions`);
      error.code = 'BRIDGE_EVIDENCE_BOUND_EXCEEDED';
      throw error;
    }
    return rows;
  }

  static _withEndpointMetadata(activities, endpoints, coverageByCoordinate = null) {
    const byCoordinate = new Map();
    for (const endpoint of endpoints) {
      const key = `${Number(endpoint.chain_id)}:${lower(endpoint.address)}`;
      if (!byCoordinate.has(key)) byCoordinate.set(key, []);
      byCoordinate.get(key).push(endpoint);
    }
    return activities.map((activity) => {
      const matches = byCoordinate.get(
        `${Number(activity.chain_id)}:${lower(activity.counterparty_address)}`
      )?.filter((endpoint) => endpointApplies(endpoint, activity)) || [];
      const endpoint = matches.length === 1 ? matches[0] : null;
      const coverageKey = `${Number(activity.wallet_id)}:${Number(activity.chain_id)}`;
      return {
        ...activity,
        endpoint_protocol: endpoint?.protocol || null,
        endpoint_family_version: endpoint?.family_version || null,
        ...(coverageByCoordinate ? {
          feed_coverage: coverageByCoordinate.get(coverageKey) || [],
        } : {}),
      };
    });
  }

  static async _acquire(userId, activities, endpoints, {
    acquireReceipts = true, client = pool, hopRoutes = [],
  } = {}) {
    const stored = new Map((await EthBridgeReceipt.findForUser(userId, client)).map((receipt) => [
      `${receipt.wallet_id}:${receipt.chain_id}:${receipt.tx_hash}`,
      receipt,
    ]));
    const apiKey = acquireReceipts
      ? await SecretsService.getUserKey(userId, 'etherscan')
      : null;
    const envelopes = [];

    for (const activity of activities) {
      const key = `${activity.wallet_id}:${activity.chain_id}:${lower(activity.tx_hash)}`;
      const chainEndpoints = endpoints.filter(
        (endpoint) => endpointApplies(endpoint, activity)
      );
      if (Number(activity.chain_id) === 32401) {
        envelopes.push({
          ...activity,
          endpoints: chainEndpoints,
          hop_routes: hopRoutes,
          transaction: null,
          receipt: null,
          provider_boundary: {
            finality: { status: 'finalized', method: 'official_archive_committed_record' },
          },
        });
        continue;
      }

      let record = stored.get(key) || null;
      if (acquireReceipts) {
        try {
          const fetched = await EtherscanService.getTransactionEvidence(
            activity.tx_hash, apiKey, Number(activity.chain_id)
          );
          const result = await EthBridgeReceipt.upsertComplete({
            walletId: activity.wallet_id,
            chainId: Number(activity.chain_id),
            txHash: activity.tx_hash,
            provider: fetched.provider,
            providerBoundary: fetched.providerBoundary,
            transaction: fetched.transaction,
            receipt: fetched.receipt,
          });
          record = result.receipt;
        } catch (error) {
          const chain = chains.getChain(Number(activity.chain_id));
          const provider = chain?.rpcUrl ? 'json-rpc' : 'chain-explorer';
          await EthBridgeReceipt.upsertFailure({
            walletId: activity.wallet_id,
            chainId: Number(activity.chain_id),
            txHash: activity.tx_hash,
            provider,
            providerBoundary: { chain_id: Number(activity.chain_id), complete: false },
            status: error.code === 'ETHERSCAN_NOT_CONFIGURED' ? 'unsupported' : 'failed',
            errorCode: error.code || 'BRIDGE_RECEIPT_FETCH_FAILED',
            errorDetail: error.message,
          });
          // A stale stored receipt is retained as evidence, but not trusted for
          // this rebuild because its current block boundary was not re-proven.
          record = null;
          logger.warn({
            userId, walletId: activity.wallet_id, chainId: activity.chain_id,
            txHash: activity.tx_hash, code: error.code,
          }, 'Bridge receipt refresh failed; movement remains unfolded');
        }
      }
      if (!acquireReceipts && record?.fetch_status !== 'complete') record = null;
      if (!record) continue;
      envelopes.push({
        ...activity,
        receipt_id: Number(record.id),
        transaction: record.transaction_json,
        receipt: record.receipt_json,
        provider_boundary: record.provider_boundary,
        endpoints: chainEndpoints,
        hop_routes: hopRoutes,
      });
    }
    return envelopes;
  }

  static async lockForUser(userId, client) {
    if (!userId || !client?.query) throw new Error('Bridge user lock requires a user and transaction client');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
      BRIDGE_LOCK_NAMESPACE, Number(userId),
    ]);
  }

  static async rebuildForUser(userId, options = {}) {
    if (!userId) throw new Error('BridgeMatchingService.rebuildForUser requires a userId');
    const transactionClient = options.client || null;
    if (transactionClient) {
      await this.lockForUser(userId, transactionClient);
      return this._rebuildForUserLocked(userId, options);
    }

    // Receipt acquisition is durable evidence and may involve bounded network
    // calls, so it remains outside the derived-state transaction. The locked
    // phase below reloads every activity, endpoint, receipt and verdict after
    // taking the database lock; it never derives from this preliminary
    // snapshot.
    if (options.acquireReceipts !== false) {
      const activities = await this._activitiesForUser(userId, pool);
      const endpoints = await EthBridgeEndpoint.findForTransactions(activities, pool);
      const annotated = this._withEndpointMetadata(activities, endpoints);
      await this._acquire(userId, annotated, endpoints, {
        ...options, acquireReceipts: true, client: pool,
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await this.lockForUser(userId, client);
      const result = await this._rebuildForUserLocked(userId, {
        ...options, acquireReceipts: false, client,
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async _rebuildForUserLocked(userId, options = {}) {
    const queryClient = options.client;
    if (!queryClient) throw new Error('Locked bridge rebuild requires a transaction client');
    const activities = await this._activitiesForUser(userId, queryClient);
    const endpoints = await EthBridgeEndpoint.findForTransactions(activities, queryClient);
    const hopRoutes = await EthHopBridgeRoute.findForTransactions(activities, queryClient);
    const coverageRows = activities.length
      ? await EthFeedCoverage.findBridgeCoverageForUser(userId, queryClient) : [];
    const coverageByCoordinate = new Map();
    for (const row of coverageRows) {
      const key = `${Number(row.wallet_id)}:${Number(row.chain_id)}`;
      if (!coverageByCoordinate.has(key)) coverageByCoordinate.set(key, []);
      coverageByCoordinate.get(key).push(row);
    }
    const annotatedActivities = this._withEndpointMetadata(
      activities, endpoints, coverageByCoordinate
    );
    const envelopes = await this._acquire(
      userId, annotatedActivities, endpoints, { ...options, client: queryClient, hopRoutes }
    );
    const decoderEvents = envelopes.flatMap((envelope) => decodeEnvelope(envelope));
    const decodedCoordinates = new Set(decoderEvents.map((event) => (
      `${Number(event.wallet_id)}:${Number(event.chain_id)}:${lower(event.tx_hash)}`
    )));
    let protocolMovements = [
      ...buildProtocolMovements(decoderEvents),
      ...envelopes.map((envelope) => unsupportedMovement(envelope, decodedCoordinates)).filter(Boolean),
    ];
    const verdicts = await EthBridgeMovement.findVerdictsForUser(userId, queryClient);
    const verdictPairs = new Map(verdicts.map((verdict) => [pairKeyFromVerdict(verdict), verdict]));

    protocolMovements = protocolMovements.map((movement) => {
      const key = pairKeyFromMovement(movement);
      const verdict = key ? verdictPairs.get(key) : null;
      if (!verdict || verdict.verdict !== 'rejected') return movement;
      return {
        ...movement,
        status: 'invalidated',
        evidence: { ...movement.evidence, invalidation: 'user_rejected_exact_pair' },
      };
    });
    const confirmedPairs = new Set(
      verdicts.filter((verdict) => verdict.verdict === 'confirmed').map(pairKeyFromVerdict)
    );
    // A durable confirmation supersedes a coincident protocol derivation so
    // one coordinate cannot project two links.
    protocolMovements = protocolMovements.filter((movement) => {
      const key = pairKeyFromMovement(movement);
      return !key || !confirmedPairs.has(key);
    });
    const manualMovements = verdicts
      .filter((verdict) => verdict.verdict === 'confirmed')
      .map(verdictMovement);
    protocolMovements = resolveProtocolCoordinateConflicts(protocolMovements, manualMovements);

    const occupiedPairs = new Set([
      ...protocolMovements.filter((movement) => movement.status === 'protocol_verified')
        .map(pairKeyFromMovement).filter(Boolean),
      ...verdicts.map(pairKeyFromVerdict),
    ]);
    const rejectedPairs = new Set(
      verdicts.filter((verdict) => verdict.verdict === 'rejected').map(pairKeyFromVerdict)
    );
    const suggestions = suggestBridgeLegs(annotatedActivities, rejectedPairs)
      .filter((suggestion) => !occupiedPairs.has(suggestionPairKey(
        {
          wallet_id: suggestion.out_wallet_id, chain_id: suggestion.out_chain_id,
          tx_hash: suggestion.out_tx_hash,
        },
        {
          wallet_id: suggestion.in_wallet_id, chain_id: suggestion.in_chain_id,
          tx_hash: suggestion.in_tx_hash,
        }
      )));

    const movements = [...protocolMovements, ...manualMovements];
    // The caller owns this already-locked transaction. Movements,
    // suggestions, compatibility folds, and review flags therefore swap as
    // one unit from a verdict snapshot taken after the same advisory lock.
    await EthBridgeMovement.replaceForUser(userId, movements, suggestions, queryClient);
    const linkRows = await EthBridgeMovement.rebuildProjectionForUser(userId, queryClient);
    const unmatched = await EthActivityLink.syncBridgeReviewState(
      userId, REVIEW_REASONS.unmatched_bridge, queryClient
    );
    const matched = movements.filter((movement) => (
      movement.status === 'protocol_verified' || movement.status === 'user_confirmed'
    )).length;
    logger.info({
      userId, matched, linkRows, suggestions: suggestions.length, unmatched,
      receipts: envelopes.length,
    }, 'Evidence-first bridge movements rebuilt');
    return { matched, linkRows, suggestions: suggestions.length, unmatched };
  }
}

module.exports = BridgeMatchingService;
module.exports.pairKeyFromMovement = pairKeyFromMovement;
module.exports.pairKeyFromVerdict = pairKeyFromVerdict;
module.exports.endpointApplies = endpointApplies;
module.exports.unsupportedMovement = unsupportedMovement;
