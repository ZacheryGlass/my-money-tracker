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

const VERSION = 1;
const SOURCE_PACKS = new Set([
  'builtin-etherdelta',
  'builtin-opensea',
  'builtin-polymarket',
  // The large public address pack is explicitly low-confidence.  A matching
  // transfer shape makes the explanation useful, but the interpretation keeps
  // that confidence and never clears review.
  'eth-labels',
]);

function confidenceOf(label) {
  return ['high', 'medium', 'low'].includes(label?.confidence) ? label.confidence : 'low';
}

function protocolOf(label) {
  if (!label || !SOURCE_PACKS.has(label.source)) return null;
  const name = String(label.name || '');
  if (label.source === 'builtin-etherdelta' || /^EtherDelta\b/i.test(name)) return 'EtherDelta';
  if (label.source === 'builtin-opensea' || /\b(?:OpenSea|Wyvern|Seaport)\b/i.test(name)) return 'OpenSea';
  if (label.source === 'builtin-polymarket' || /\bPolymarket\b/i.test(name)) return 'Polymarket';
  if (/^ENS\b|Ethereum Name Service/i.test(name)) return 'ENS';
  if (/^Uniswap\b/i.test(name)) return 'Uniswap';
  if (/^MetaMask\b/i.test(name)) return 'MetaMask';
  return null;
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

function interpretProtocolActivity(row, label = null) {
  const legs = Array.isArray(row?.legs) ? row.legs : [];
  const fungible = legs.filter((leg) => !NFT_STANDARDS.has(leg.token_standard));
  const nfts = legs.filter((leg) => NFT_STANDARDS.has(leg.token_standard));
  const fungibleIn = fungible.some((leg) => leg.direction === 'in');
  const fungibleOut = fungible.some((leg) => leg.direction === 'out');
  const nftIn = nfts.some((leg) => leg.direction === 'in');
  const nftOut = nfts.some((leg) => leg.direction === 'out');
  const protocol = protocolOf(label);

  if (protocol === 'EtherDelta'
      && ['exchange_deposit', 'exchange_withdrawal'].includes(row.category)) {
    const deposit = row.category === 'exchange_deposit';
    return interpretation(
      protocol,
      deposit ? 'custody_deposit' : 'custody_withdrawal',
      deposit
        ? 'Assets moved from the wallet into the EtherDelta custody contract.'
        : 'Assets moved from the EtherDelta custody contract back to the wallet.',
      label,
      ['custody_contract_transfer'],
      ['Internal EtherDelta order-book fills are not emitted as standard token transfers.']
    );
  }

  if (protocol === 'OpenSea' && row.category === 'nft_purchase' && nftIn && fungibleOut) {
    return interpretation(
      protocol,
      'nft_purchase',
      'NFT consideration is visible leaving the wallet and an NFT is visible entering it through an OpenSea protocol counterparty.',
      label,
      ['netted_nft_in', 'netted_consideration_out'],
      ['Bundle allocation and off-chain order terms are not retained in the normalized feed.']
    );
  }
  if (protocol === 'OpenSea' && row.category === 'nft_sale' && nftOut && fungibleIn) {
    return interpretation(
      protocol,
      'nft_sale',
      'An NFT is visible leaving the wallet and sale consideration is visible entering it through an OpenSea protocol counterparty.',
      label,
      ['netted_nft_out', 'netted_consideration_in'],
      ['Bundle allocation and off-chain order terms are not retained in the normalized feed.']
    );
  }

  if (protocol === 'ENS' && row.category === 'nft_mint' && nftIn) {
    return interpretation(
      protocol,
      'name_token_mint',
      'An ENS-labelled contract minted a name-token NFT into the wallet.',
      label,
      ['netted_nft_mint'],
      ['The normalized feed does not retain the name, generation, or registration calldata.']
    );
  }

  if ((protocol === 'Uniswap' || protocol === 'MetaMask')
      && row.category === 'swap' && fungibleIn && fungibleOut) {
    return interpretation(
      protocol,
      'router_swap',
      `A ${protocol} router interaction has one or more fungible assets leaving the wallet and a different fungible asset entering it.`,
      label,
      ['netted_fungible_out', 'netted_fungible_in'],
      ['The normalized feed proves net movement, not the quoted route, pool path, or slippage settings.']
    );
  }

  if (protocol === 'Polymarket' && nfts.some((leg) => leg.token_standard === 'erc1155')) {
    const action = nftIn && fungibleOut
      ? 'ctf_position_acquisition'
      : nftOut && fungibleIn
        ? 'ctf_position_disposal_or_redemption'
        : 'ctf_position_reconfiguration';
    return interpretation(
      protocol,
      action,
      'Conditional-token ERC-1155 position movement is visible through a Polymarket protocol counterparty.',
      label,
      ['erc1155_position_transfer', ...(fungibleIn || fungibleOut ? ['collateral_movement'] : [])],
      ['Outcome, market, split/merge intent, and final payout require CTF event data not retained in the normalized feed.']
    );
  }

  // A fungible mint is an on-chain fact, but "airdrop", "reward", and income
  // are intent/tax judgments.  Keep the useful legacy-distribution explanation
  // while preserving the existing receive review verdict.
  if (!protocol && row.counterparty_address === ZERO_ADDRESS
      && row.category === 'receive' && fungibleIn && !fungibleOut) {
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
