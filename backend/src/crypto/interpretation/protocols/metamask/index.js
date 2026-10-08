'use strict';

module.exports = {
  id: 'metamask',
  name: 'MetaMask',
  order: 60,
  pack: null,
  labelPattern: /^MetaMask\b/i,
  interpret: require('../routerSwap')('MetaMask'),
};
