'use strict';

// Polymarket: conditional-token (CTF) ERC-1155 position movement through a
// Polymarket protocol counterparty. Outcome, market and payout need CTF event
// data the normalized feed does not retain.

module.exports = {
  id: 'polymarket',
  name: 'Polymarket',
  order: 30,
  pack: { source: 'builtin-polymarket' },
  labelPattern: /\bPolymarket\b/i,
  interpret(row, { shape, explain }) {
    if (!shape.nfts.some((leg) => leg.token_standard === 'erc1155')) return null;
    const action = shape.nftIn && shape.fungibleOut
      ? 'ctf_position_acquisition'
      : shape.nftOut && shape.fungibleIn
        ? 'ctf_position_disposal_or_redemption'
        : 'ctf_position_reconfiguration';
    return explain(
      action,
      'Conditional-token ERC-1155 position movement is visible through a Polymarket protocol counterparty.',
      ['erc1155_position_transfer', ...(shape.fungibleIn || shape.fungibleOut ? ['collateral_movement'] : [])],
      ['Outcome, market, split/merge intent, and final payout require CTF event data not retained in the normalized feed.']
    );
  },
};
