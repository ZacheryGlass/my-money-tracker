'use strict';

const TRANSFER_TYPES = {
  erc20: 'token',
  erc721: 'nft',
  erc1155: 'nft1155',
};

function normalizedAddress(value) {
  const text = String(value || '').toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(text) ? text : null;
}

function quantity(value, { allowSafeNumber = false } = {}) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    return allowSafeNumber && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  try { return BigInt(text); } catch { return null; }
}

function decimal(value, options) {
  const parsed = quantity(value, options);
  return parsed == null ? null : parsed.toString();
}

function moralisTransferFields(effect, payload) {
  const standard = effect.effect_type;
  const numericFields = payload.__evm_json_numeric_fields;
  if (standard !== 'erc20' && Array.isArray(numericFields) && numericFields.includes('amount')) {
    return null;
  }
  const contract = normalizedAddress(payload.address ?? payload.token_address);
  const from = normalizedAddress(payload.from_address ?? payload.from);
  const to = normalizedAddress(payload.to_address ?? payload.to);
  const value = decimal(
    standard === 'erc20' ? payload.value : payload.amount,
    { allowSafeNumber: standard === 'erc20' }
  );
  const tokenId = standard === 'erc20' ? null : decimal(payload.token_id ?? payload.tokenId);
  if (!contract || !from || !to || value == null || (standard !== 'erc20' && tokenId == null)) {
    return null;
  }
  return { contract, from, to, value, tokenId };
}

function matchesMoralisTransfer(effect, observation) {
  if (!effect || !observation || !TRANSFER_TYPES[effect.effect_type]) return false;
  if (observation.provider !== 'moralis') return false;
  const expectedKind = `${effect.effect_type}_transfer`;
  if (observation.evidence_kind !== expectedKind
      || String(observation.tx_hash || '').toLowerCase() !== String(effect.tx_hash).toLowerCase()
      || Number(observation.log_index) !== Number(effect.log_index)) return false;
  const fields = moralisTransferFields(effect, observation.payload_json || {});
  return Boolean(fields)
    && fields.contract === String(effect.token_contract || '').toLowerCase()
    && fields.from === String(effect.from_address || '').toLowerCase()
    && fields.to === String(effect.to_address || '').toLowerCase()
    && fields.value === decimal(effect.value_units)
    && fields.tokenId === (effect.effect_type === 'erc20' ? null : decimal(effect.token_id));
}

function matchesLegacyTransfer(effect, row) {
  return Boolean(effect && row)
    && TRANSFER_TYPES[effect.effect_type] === row.transfer_type
    && String(row.tx_hash || '').toLowerCase() === String(effect.tx_hash).toLowerCase()
    && String(row.from_address || '').toLowerCase() === String(effect.from_address || '').toLowerCase()
    && String(row.to_address || '').toLowerCase() === String(effect.to_address || '').toLowerCase()
    && decimal(row.value_wei) === decimal(effect.value_units)
    && String(row.token_contract || '').toLowerCase() === String(effect.token_contract || '').toLowerCase()
    && (effect.effect_type === 'erc20'
      ? row.token_id == null
      : decimal(row.token_id) === decimal(effect.token_id));
}

module.exports = {
  TRANSFER_TYPES,
  matchesLegacyTransfer,
  matchesMoralisTransfer,
};
