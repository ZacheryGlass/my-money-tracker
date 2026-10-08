'use strict';

// ENS: a name-token NFT minted into the wallet by an ENS-labelled contract.

module.exports = {
  id: 'ens',
  name: 'ENS',
  order: 40,
  pack: null,
  labelPattern: /^ENS\b|Ethereum Name Service/i,
  interpret(row, { shape, explain }) {
    if (row.category !== 'nft_mint' || !shape.nftIn) return null;
    return explain(
      'name_token_mint',
      'An ENS-labelled contract minted a name-token NFT into the wallet.',
      ['netted_nft_mint'],
      ['The normalized feed does not retain the name, generation, or registration calldata.']
    );
  },
};
