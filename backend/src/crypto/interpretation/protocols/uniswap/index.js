'use strict';

module.exports = {
  id: 'uniswap',
  name: 'Uniswap',
  order: 50,
  pack: null,
  labelPattern: /^Uniswap\b/i,
  interpret: require('../routerSwap')('Uniswap'),
};
