'use strict';

// EtherDelta: the historical custody/order-book contract. Visible deposits and
// withdrawals are custody moves; internal order-book fills are not emitted as
// standard token transfers, so they cannot be explained from transfer legs.

module.exports = {
  id: 'etherdelta',
  name: 'EtherDelta',
  order: 10,
  // The curated builtin pack (migrations 067/100).
  pack: { source: 'builtin-etherdelta' },
  // A custody venue: transfers to/from it are exchange deposits/withdrawals
  // (the activity ladder's custody rung and the mirror's custody mapping),
  // subject to the protocol verdict rule.
  custody: true,
  // A scraped (low-confidence) label naming the protocol.
  labelPattern: /^EtherDelta\b/i,
  interpret(row, { explain }) {
    if (!['exchange_deposit', 'exchange_withdrawal'].includes(row.category)) return null;
    const deposit = row.category === 'exchange_deposit';
    return explain(
      deposit ? 'custody_deposit' : 'custody_withdrawal',
      deposit
        ? 'Assets moved from the wallet into the EtherDelta custody contract.'
        : 'Assets moved from the EtherDelta custody contract back to the wallet.',
      ['custody_contract_transfer'],
      ['Internal EtherDelta order-book fills are not emitted as standard token transfers.']
    );
  },
};
