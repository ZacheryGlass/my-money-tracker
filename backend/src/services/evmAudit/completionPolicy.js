'use strict';

const { isDeepStrictEqual } = require('node:util');

// Only providers that independently enumerate address history may satisfy a
// completion proof. `existing-ledger` is deliberately absent because it is the
// stored projection being audited, not an independent source.
const INDEPENDENT_ENUMERATION_PROVIDERS = Object.freeze([
  'moralis',
  'blockscout',
  'etherscan',
  'zksync explorer',
  'trace-rpc',
]);

// Durable per-chain progress written by EvmAuditService and consumed by the
// private completion reporter. Keep the producer and consumer on this shared
// manifest so an older job can never be interpreted under a newer contract.
const AUDIT_PROGRESS_CONTRACT = Object.freeze({
  version: 2,
  nonnegative_integer_fields: Object.freeze([
    'boundary_block', 'transactions', 'native_relevant_transactions', 'provider_lookup_gaps',
    'transaction_conflicts', 'transaction_native_conflicts',
    'transaction_optional_conflicts', 'capability_gaps', 'nonce_gaps',
    'token_balance_gaps', 'historical_token_balance_gap',
    'historical_token_checks', 'historical_token_deferred',
    'historical_token_failures', 'historical_token_mismatches',
    'asset_universe_contracts', 'asset_universe_observed_only',
    'indexed_token_log_enumeration_gap', 'receipt_enumeration_gap',
    'historical_state_gap', 'archive_depth_gap', 'archive_balance_gap',
    'archive_probe_block', 'credential_feed_gap',
    'corroborated_identity_repairs', 'missing_activity',
    'missing_native_activity', 'missing_optional_activity',
    'provisional_effects', 'provisional_native_effects',
    'provisional_optional_effects', 'unmatched_effects',
    'unmatched_native_effects', 'unmatched_optional_effects',
  ]),
  array_fields: Object.freeze(['unresolved_bridges', 'unsupported_capabilities']),
  boolean_fields: Object.freeze(['native_balance_match', 'internal_trace_enumeration_complete']),
  nonempty_string_fields: Object.freeze([
    'asset_universe_basis', 'indexed_token_log_coverage_basis',
    'internal_trace_coverage_basis', 'balance_coverage_basis',
  ]),
  nullable_string_fields: Object.freeze(['credential_feed_error']),
  archive_statuses: Object.freeze(['available', 'mismatch', 'unavailable']),
});

const EXCLUDED_BASE_CHAIN_ID = 8453;

// Canonical first-party Base L1 deployments. This single registry drives both
// movement production and completion validation; a merely well-formed address
// or URL is not evidence that a transaction crossed the excluded Base scope.
const BASE_EXCLUSION_ENDPOINTS = Object.freeze([
  Object.freeze({
    address: '0x3154cf16ccdb4c6d922629664174b904d80f2c35',
    name: 'Base: L1 Standard Bridge', role: 'standard_bridge',
    source_url: 'https://docs.base.org/specifications/reference/base-contracts',
  }),
  Object.freeze({
    address: '0x49048044d57e1c92a77f79988d21fa8faf74e97e',
    name: 'Base: Portal', role: 'portal',
    source_url: 'https://docs.base.org/specifications/reference/base-contracts',
  }),
  Object.freeze({
    address: '0x866e82a600a1414e583f7f13623f1ac5d58b0afa',
    name: 'Base: L1 Cross Domain Messenger', role: 'cross_domain_messenger',
    source_url: 'https://docs.base.org/specifications/reference/base-contracts',
  }),
]);
const BASE_EXCLUSION_BY_ADDRESS = new Map(
  BASE_EXCLUSION_ENDPOINTS.map((endpoint) => [endpoint.address, endpoint])
);
const BASE_CHAIN_TEXT_VALUES = Object.freeze(['8453', '0x2105']);

function nonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBaseChainValue(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value === EXCLUDED_BASE_CHAIN_ID;
  }
  if (typeof value !== 'string') return false;
  return BASE_CHAIN_TEXT_VALUES.includes(value.trim().toLowerCase());
}

function baseExclusionEndpoint(address) {
  return BASE_EXCLUSION_BY_ADDRESS.get(String(address || '').toLowerCase()) || null;
}

function identityMentionsBase(identity) {
  return identity && typeof identity === 'object' && !Array.isArray(identity)
    && ['destination_chain_id', 'origin_chain_id', 'source_chain_id']
      .some((field) => isBaseChainValue(identity[field]));
}

function excludedBaseIdentityFields(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
  if (identityMentionsBase(evidence.identity_fields)) return evidence.identity_fields;
  if (identityMentionsBase(evidence.hop)) return evidence.hop;
  return null;
}

function canonicalEndpointSource(endpoint) {
  return {
    type: 'source_backed_endpoint', chain_id: 1,
    address: endpoint.address, name: endpoint.name, role: endpoint.role,
    source_url: endpoint.source_url,
  };
}

function validExcludedBaseSource(source, decoderEvent = null) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
  if (source.type === 'source_backed_endpoint') {
    const endpoint = baseExclusionEndpoint(source.address);
    return endpoint != null && isDeepStrictEqual(source, canonicalEndpointSource(endpoint));
  }
  if (source.type !== 'decoded_protocol_identity') return false;
  const identity = excludedBaseIdentityFields(decoderEvent?.evidence);
  return Object.keys(source).length === 5
    && nonemptyString(source.protocol)
    && nonemptyString(source.family_version)
    && nonemptyString(source.correlation_key)
    && source.protocol === decoderEvent?.protocol
    && source.family_version === decoderEvent?.family_version
    && source.correlation_key === decoderEvent?.correlation_key
    && identity != null
    && isDeepStrictEqual(source.identity_fields, identity);
}

function isVerifiedExcludedBaseMovement(movement) {
  return movement?.status === 'unsupported'
    && movement?.verification_method === 'protocol_identity'
    && movement?.evidence?.reason === 'excluded_counterparty_chain'
    && movement?.evidence?.excluded_chain_id === EXCLUDED_BASE_CHAIN_ID
    && validExcludedBaseSource(
      movement?.evidence?.source,
      movement?.evidence?.decoder_event
    );
}

function sqlJson(value) {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

function baseChainSql(jsonExpression) {
  return `LOWER(BTRIM(COALESCE(${jsonExpression} #>> '{}', ''))) IN (`
    + BASE_CHAIN_TEXT_VALUES.map((value) => `'${value}'`).join(', ')
    + ')';
}

function identityMentionsBaseSql(identityExpression) {
  return ['destination_chain_id', 'origin_chain_id', 'source_chain_id']
    .map((field) => baseChainSql(`${identityExpression}->'${field}'`))
    .join(' OR ');
}

// SQL equivalent of isVerifiedExcludedBaseMovement. The alias is restricted
// to a plain identifier because this fragment is embedded in model queries.
function verifiedExcludedBaseMovementSql(alias = 'm') {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error('invalid movement SQL alias');
  const evidence = `${alias}.evidence`;
  const source = `${evidence}->'source'`;
  const decoder = `${evidence}->'decoder_event'`;
  const decoderEvidence = `${decoder}->'evidence'`;
  const identity = `${decoderEvidence}->'identity_fields'`;
  const hop = `${decoderEvidence}->'hop'`;
  const selectedIdentity = `CASE WHEN ${identityMentionsBaseSql(identity)} THEN ${identity} `
    + `WHEN ${identityMentionsBaseSql(hop)} THEN ${hop} ELSE NULL END`;
  const endpoints = BASE_EXCLUSION_ENDPOINTS
    .map((endpoint) => sqlJson(canonicalEndpointSource(endpoint))).join(', ');
  return `(
    ${alias}.status = 'unsupported'
    AND ${alias}.verification_method = 'protocol_identity'
    AND ${evidence}->>'reason' = 'excluded_counterparty_chain'
    AND ${evidence}->'excluded_chain_id' = '${EXCLUDED_BASE_CHAIN_ID}'::jsonb
    AND (
      ${source} IN (${endpoints})
      OR (
        ${source}->>'type' = 'decoded_protocol_identity'
        AND ${source} = jsonb_build_object(
          'type', ${source}->'type',
          'protocol', ${source}->'protocol',
          'family_version', ${source}->'family_version',
          'correlation_key', ${source}->'correlation_key',
          'identity_fields', ${source}->'identity_fields'
        )
        AND NULLIF(BTRIM(${source}->>'protocol'), '') IS NOT NULL
        AND ${source}->>'protocol' = ${decoder}->>'protocol'
        AND NULLIF(BTRIM(${source}->>'family_version'), '') IS NOT NULL
        AND ${source}->>'family_version' = ${decoder}->>'family_version'
        AND NULLIF(BTRIM(${source}->>'correlation_key'), '') IS NOT NULL
        AND ${source}->>'correlation_key' = ${decoder}->>'correlation_key'
        AND jsonb_typeof(${source}->'identity_fields') = 'object'
        AND ${source}->'identity_fields' = (${selectedIdentity})
      )
    )
  )`;
}

module.exports = {
  AUDIT_PROGRESS_CONTRACT,
  BASE_EXCLUSION_ENDPOINTS,
  EXCLUDED_BASE_CHAIN_ID,
  INDEPENDENT_ENUMERATION_PROVIDERS,
  baseExclusionEndpoint,
  excludedBaseIdentityFields,
  isBaseChainValue,
  isVerifiedExcludedBaseMovement,
  validExcludedBaseSource,
  verifiedExcludedBaseMovementSql,
};
