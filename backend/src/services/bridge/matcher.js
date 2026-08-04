'use strict';

const {
  bridgeAsset, bridgeMovement,
  BRIDGE_DEPOSIT_WINDOW_MS, BRIDGE_WITHDRAWAL_WINDOW_MS,
} = require('../ethActivity/bridge');
const { DEFAULT_CHAIN_ID } = require('../../config/chains');
const { RULE_VERSION } = require('./adapters');

const DESTINATION_ROLES = new Set(['destination_execution', 'fill', 'finalization']);

function coordinateKey(row) {
  return `${Number(row.wallet_id)}:${Number(row.chain_id)}:${String(row.tx_hash).toLowerCase()}`;
}

function memberKey(row) {
  return `${coordinateKey(row)}:${row.role}:${row.log_index ?? ''}`;
}

function compatibleIdentityFields(left, right) {
  const a = left?.evidence?.identity_fields || {};
  const b = right?.evidence?.identity_fields || {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[key] != null && b[key] != null
        && String(a[key]).toLowerCase() !== String(b[key]).toLowerCase()) return false;
  }
  return true;
}

function toMember(event) {
  return {
    wallet_id: event.wallet_id,
    chain_id: event.chain_id,
    tx_hash: event.tx_hash,
    role: event.role,
    receipt_id: event.receipt_id,
    log_index: event.log_index,
    asset_id: event.asset_id,
    amount: event.amount,
    fee_amount: event.fee_amount,
    evidence: event.evidence || {},
  };
}

// Identity joins are set-based. There is no ordering and no claimed/greedy
// state: concurrent identical-looking bridges remain independent because their
// protocol keys differ; duplicated evidence for one key makes that key
// unsupported instead of choosing a winner.
function buildProtocolMovements(events) {
  const groups = new Map();
  for (const event of events || []) {
    if (!event?.protocol || !event.family_version || !event.correlation_key) continue;
    const key = `${event.protocol}\u0000${event.family_version}\u0000${event.correlation_key}`;
    if (!groups.has(key)) groups.set(key, []);
    if (!groups.get(key).some((existing) => memberKey(existing) === memberKey(event))) {
      groups.get(key).push(event);
    }
  }

  const movements = [];
  for (const group of groups.values()) {
    const first = group[0];
    const initiations = group.filter((event) => event.role === 'initiation' && event.direction === 'out');
    const destinations = group.filter(
      (event) => DESTINATION_ROLES.has(event.role) && event.direction === 'in'
    );
    const refunds = group.filter((event) => event.role === 'refund');
    const failures = group.filter((event) => event.status === 'failed');
    const pairFinalized = [...initiations, ...destinations].every(
      (event) => event.evidence?.finality?.status === 'finalized'
    );
    let status = 'pending';
    let ambiguity = null;

    if (refunds.length) status = 'refunded';
    else if (failures.length) status = 'failed';
    else if (initiations.length === 1 && destinations.length === 1
      && initiations[0].chain_id !== destinations[0].chain_id
      && compatibleIdentityFields(initiations[0], destinations[0])
      && pairFinalized) {
      status = 'protocol_verified';
    } else if (initiations.length > 1 || destinations.length > 1) {
      status = 'unsupported';
      ambiguity = 'duplicate_protocol_members';
    } else if (initiations.length === 1 && destinations.length === 1) {
      if (initiations[0].chain_id === destinations[0].chain_id) {
        status = 'unsupported';
        ambiguity = 'same_chain_members';
      } else if (!compatibleIdentityFields(initiations[0], destinations[0])) {
        status = 'unsupported';
        ambiguity = 'incompatible_protocol_fields';
      } else {
        status = 'pending';
        ambiguity = 'awaiting_chain_finality';
      }
    }

    movements.push({
      protocol: first.protocol,
      family_version: first.family_version,
      correlation_key: first.correlation_key,
      verification_method: 'protocol_identity',
      status,
      rule_version: RULE_VERSION,
      evidence: {
        member_count: group.length,
        ambiguity,
        decoder_events: group.map((event) => ({
          wallet_id: event.wallet_id,
          chain_id: event.chain_id,
          tx_hash: event.tx_hash,
          role: event.role,
          log_index: event.log_index,
          evidence: event.evidence,
        })),
      },
      members: group.map(toMember),
    });
  }
  return movements;
}

function projectionCoordinates(movement) {
  return [...new Set((movement.members || [])
    .filter((member) => member.role === 'initiation' || DESTINATION_ROLES.has(member.role))
    .map(coordinateKey))];
}

// One activity row cannot host two compatibility projections. Protocols may
// emit several independently identified messages from a batch/multicall, but
// the activity table is transaction-granular rather than message-granular.
// Until message slices are modeled, every protocol movement claiming the same
// transaction stays visible and unsupported instead of letting a UNIQUE
// violation roll back the user's entire bridge rebuild. A durable user verdict
// owns its coordinates and therefore also demotes a coincident automatic
// derivation.
function resolveProtocolCoordinateConflicts(protocolMovements, manualMovements = []) {
  const manualCoordinates = new Set(
    manualMovements
      .filter((movement) => movement.status === 'user_confirmed')
      .flatMap(projectionCoordinates)
  );
  const claims = new Map();
  const conflicts = new Map();

  for (const [index, movement] of protocolMovements.entries()) {
    if (movement.status !== 'protocol_verified') continue;
    for (const key of projectionCoordinates(movement)) {
      if (!claims.has(key)) claims.set(key, []);
      claims.get(key).push(index);
      if (manualCoordinates.has(key)) {
        conflicts.set(index, {
          reason: 'user_verdict_claims_transaction',
          coordinate: key,
        });
      }
    }
  }

  for (const [key, indexes] of claims) {
    if (indexes.length < 2) continue;
    for (const index of indexes) {
      if (!conflicts.has(index)) {
        conflicts.set(index, {
          reason: 'shared_transaction_multiple_protocol_identities',
          coordinate: key,
        });
      }
    }
  }

  return protocolMovements.map((movement, index) => {
    const conflict = conflicts.get(index);
    if (!conflict) return movement;
    return {
      ...movement,
      status: 'unsupported',
      evidence: {
        ...movement.evidence,
        ambiguity: conflict.reason,
        conflicting_coordinate: conflict.coordinate,
      },
    };
  });
}

function verdictMovement(verdict) {
  return {
    protocol: 'manual',
    family_version: 'user-confirmed',
    correlation_key: [
      'verdict', verdict.out_wallet_id, verdict.out_chain_id, verdict.out_tx_hash,
      verdict.in_wallet_id, verdict.in_chain_id, verdict.in_tx_hash,
    ].join(':'),
    verification_method: 'user_verdict',
    status: 'user_confirmed',
    rule_version: RULE_VERSION,
    evidence: { verdict_id: verdict.id, note: verdict.note || null },
    members: [
      {
        wallet_id: verdict.out_wallet_id, chain_id: verdict.out_chain_id,
        tx_hash: verdict.out_tx_hash, role: 'initiation', evidence: { verdict_id: verdict.id },
      },
      {
        wallet_id: verdict.in_wallet_id, chain_id: verdict.in_chain_id,
        tx_hash: verdict.in_tx_hash, role: 'destination_execution', evidence: { verdict_id: verdict.id },
      },
    ],
  };
}

function exactBundle(left, right) {
  const a = left.assets || [{ asset: left.asset, amount: left.amount }];
  const b = right.assets || [{ asset: right.asset, amount: right.amount }];
  if (a.length !== b.length) return false;
  const byAsset = new Map(b.map((entry) => [entry.asset, entry.amount]));
  return a.every((entry) => byAsset.get(entry.asset) === entry.amount);
}

function assetBundle(left, right) {
  const a = (left.assets || [{ asset: left.asset }]).map((entry) => entry.asset).sort();
  const b = (right.assets || [{ asset: right.asset }]).map((entry) => entry.asset).sort();
  return a.length === b.length && a.every((asset, index) => asset === b[index]);
}

function suggestionPairKey(out, incoming) {
  return `${coordinateKey(out)}>${coordinateKey(incoming)}`;
}

function suggestBridgeLegs(rows, rejectedPairs = new Set()) {
  const outs = [];
  const ins = [];
  for (const row of rows || []) {
    const direction = row.category === 'bridge_out' ? 'out'
      : (row.category === 'bridge_in' ? 'in' : null);
    if (!direction) continue;
    const movement = bridgeMovement(row, direction);
    if (!movement) continue;
    const candidate = {
      ...row,
      ...movement,
      wallet_id: Number(row.wallet_id),
      chain_id: Number(row.chain_id),
      tx_hash: String(row.tx_hash).toLowerCase(),
    };
    (direction === 'out' ? outs : ins).push(candidate);
  }

  const suggestions = [];
  for (const out of outs) {
    for (const incoming of ins) {
      if (out.chain_id === incoming.chain_id || incoming.time < out.time) continue;
      const window = out.chain_id === DEFAULT_CHAIN_ID
        ? BRIDGE_DEPOSIT_WINDOW_MS
        : BRIDGE_WITHDRAWAL_WINDOW_MS;
      if (incoming.time - out.time > window || !assetBundle(out, incoming)) continue;
      if (rejectedPairs.has(suggestionPairKey(out, incoming))) continue;

      const sameProtocol = out.endpoint_protocol && incoming.endpoint_protocol
        && out.endpoint_protocol === incoming.endpoint_protocol;
      const exactAmount = exactBundle(out, incoming);
      const suggestionReason = sameProtocol && exactAmount
        ? 'address_asset_amount'
        : (exactAmount ? 'asset_amount' : 'asset_time_only');
      suggestions.push({
        out_wallet_id: out.wallet_id,
        out_chain_id: out.chain_id,
        out_tx_hash: out.tx_hash,
        in_wallet_id: incoming.wallet_id,
        in_chain_id: incoming.chain_id,
        in_tx_hash: incoming.tx_hash,
        protocol: sameProtocol ? out.endpoint_protocol : null,
        family_version: sameProtocol ? (out.endpoint_family_version || incoming.endpoint_family_version || null) : null,
        suggestion_reason: suggestionReason,
        ambiguous: false,
        rule_version: RULE_VERSION,
        evidence: {
          exact_amount: exactAmount,
          asset_identity: movementAssetsForEvidence(out),
          seconds_apart: Math.floor((incoming.time - out.time) / 1000),
          endpoint_protocol: sameProtocol ? out.endpoint_protocol : null,
          policy: 'confirmation_required',
        },
      });
    }
  }

  const counts = new Map();
  for (const suggestion of suggestions) {
    const outKey = `${suggestion.out_wallet_id}:${suggestion.out_chain_id}:${suggestion.out_tx_hash}`;
    const inKey = `${suggestion.in_wallet_id}:${suggestion.in_chain_id}:${suggestion.in_tx_hash}`;
    counts.set(`out:${outKey}`, (counts.get(`out:${outKey}`) || 0) + 1);
    counts.set(`in:${inKey}`, (counts.get(`in:${inKey}`) || 0) + 1);
  }
  for (const suggestion of suggestions) {
    const outKey = `out:${suggestion.out_wallet_id}:${suggestion.out_chain_id}:${suggestion.out_tx_hash}`;
    const inKey = `in:${suggestion.in_wallet_id}:${suggestion.in_chain_id}:${suggestion.in_tx_hash}`;
    suggestion.ambiguous = counts.get(outKey) > 1 || counts.get(inKey) > 1;
  }
  return suggestions;
}

function movementAssetsForEvidence(movement) {
  return (movement.assets || [{ asset: movement.asset, rawAmount: movement.rawAmount }])
    .map((entry) => ({ asset: bridgeAsset(entry.asset), amount: entry.rawAmount }));
}

module.exports = {
  DESTINATION_ROLES,
  buildProtocolMovements,
  compatibleIdentityFields,
  coordinateKey,
  memberKey,
  projectionCoordinates,
  resolveProtocolCoordinateConflicts,
  suggestBridgeLegs,
  suggestionPairKey,
  verdictMovement,
};
