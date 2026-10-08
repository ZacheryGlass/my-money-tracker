'use strict';

// The router-swap explanation shared by aggregator/router protocols: fungible
// assets leave, a different fungible asset arrives.

module.exports = function routerSwap(name) {
  return (row, { shape, explain }) => {
    if (row.category !== 'swap' || !shape.fungibleIn || !shape.fungibleOut) return null;
    return explain(
      'router_swap',
      `A ${name} router interaction has one or more fungible assets leaving the wallet and a different fungible asset entering it.`,
      ['netted_fungible_out', 'netted_fungible_in'],
      ['The normalized feed proves net movement, not the quoted route, pool path, or slippage settings.']
    );
  };
};
