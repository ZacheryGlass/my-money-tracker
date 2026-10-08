'use strict';

// Evidence-backed protocol interpretation for one already-classified activity
// row.  This layer never changes category, review state, spam state, ownership,
// or intent.  It only records a compact explanation when two independent facts
// agree:
//   1. a source-bearing counterparty label identifies a protocol, and
//   2. the normalized transfer events have the protocol-compatible shape.
//
// method_id/method_name are deliberately absent.  Selectors are attacker-
// controlled display hints and the ingest schema does not retain full calldata,
// so they cannot prove which semantic path executed.

const { NFT_STANDARDS, ZERO_ADDRESS } = require('../../utils/ethActivityVocabulary');

const { PROTOCOLS, CURATED_PROTOCOL_SOURCES } = require('../../crypto/registry/protocols');

const VERSION = 1;
// Label sources that can name a protocol: each protocol's curated pack, plus
// the large public address pack, which is explicitly low-confidence. A
// matching transfer shape makes the explanation useful, but the
// interpretation keeps that confidence and never clears review.
const SOURCE_PACKS = new Set([...CURATED_PROTOCOL_SOURCES, 'eth-labels']);

function confidenceOf(label) {
  return ['high', 'medium', 'low'].includes(label?.confidence) ? label.confidence : 'low';
}

// The protocol module a source-bearing label names: its curated pack, or a
// name matching the protocol's pattern (crypto/interpretation/protocols/).
function protocolOf(label) {
  if (!label || !SOURCE_PACKS.has(label.source)) return null;
  const name = String(label.name || '');
  return PROTOCOLS.find((protocol) => (protocol.pack && label.source === protocol.pack.source)
    || (protocol.labelPattern && protocol.labelPattern.test(name))) || null;
}

function interpretation(protocol, action, summary, label, evidence, limitations = []) {
  return {
    version: VERSION,
    protocol,
    action,
    summary,
    confidence: confidenceOf(label),
    evidence: ['source_backed_counterparty_label', ...evidence],
    limitations,
  };
}

// `builtin` is the curated builtin row whose protocol identity applies to the
// counterparty (crypto/interpretation/protocolIdentity), even when a user row
// shadows it for display. It names the protocol and sets the confidence; the
// shadowing label still supplies the display name upstream.
function interpretProtocolActivity(row, displayLabel = null, builtin = null) {
  const label = builtin || displayLabel;
  const legs = Array.isArray(row?.legs) ? row.legs : [];
  const fungible = legs.filter((leg) => !NFT_STANDARDS.has(leg.token_standard));
  const nfts = legs.filter((leg) => NFT_STANDARDS.has(leg.token_standard));
  const shape = {
    nfts,
    fungibleIn: fungible.some((leg) => leg.direction === 'in'),
    fungibleOut: fungible.some((leg) => leg.direction === 'out'),
    nftIn: nfts.some((leg) => leg.direction === 'in'),
    nftOut: nfts.some((leg) => leg.direction === 'out'),
  };
  const protocol = protocolOf(label);

  if (protocol) {
    const explained = protocol.interpret(row, {
      label,
      shape,
      explain: (action, summary, evidence, limitations) => interpretation(
        protocol.name, action, summary, label, evidence, limitations
      ),
    });
    if (explained) return explained;
  }

  // A fungible mint is an on-chain fact, but "airdrop", "reward", and income
  // are intent/tax judgments.  Keep the useful legacy-distribution explanation
  // while preserving the existing receive review verdict.
  if (!protocol && row.counterparty_address === ZERO_ADDRESS
      && row.category === 'receive' && shape.fungibleIn && !shape.fungibleOut) {
    return {
      version: VERSION,
      protocol: 'Token contract',
      action: 'fungible_token_mint',
      summary: 'A fungible token was minted from the zero address into the wallet.',
      confidence: 'high',
      evidence: ['zero_address_counterparty', 'netted_fungible_in'],
      limitations: ['Distribution purpose, personal intent, and tax treatment are not stated on chain.'],
    };
  }

  return null;
}

module.exports = { VERSION, interpretProtocolActivity };
