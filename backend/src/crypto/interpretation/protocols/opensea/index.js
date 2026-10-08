'use strict';

// OpenSea (Wyvern and Seaport): an NFT purchase or sale is explained when the
// NFT and the consideration move in opposite directions through a protocol
// counterparty.

module.exports = {
  id: 'opensea',
  name: 'OpenSea',
  order: 20,
  pack: { source: 'builtin-opensea' },
  labelPattern: /\b(?:OpenSea|Wyvern|Seaport)\b/i,
  interpret(row, { shape, explain }) {
    const limitations = ['Bundle allocation and off-chain order terms are not retained in the normalized feed.'];
    if (row.category === 'nft_purchase' && shape.nftIn && shape.fungibleOut) {
      return explain(
        'nft_purchase',
        'NFT consideration is visible leaving the wallet and an NFT is visible entering it through an OpenSea protocol counterparty.',
        ['netted_nft_in', 'netted_consideration_out'],
        limitations
      );
    }
    if (row.category === 'nft_sale' && shape.nftOut && shape.fungibleIn) {
      return explain(
        'nft_sale',
        'An NFT is visible leaving the wallet and sale consideration is visible entering it through an OpenSea protocol counterparty.',
        ['netted_nft_out', 'netted_consideration_in'],
        limitations
      );
    }
    return null;
  },
};
