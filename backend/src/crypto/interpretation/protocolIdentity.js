'use strict';

// Protocol identity for curated builtin packs (one source per protocol, every
// address taken from the protocol's own deployment records).
//
// A user label on such an address is a statement about how the USER wants the
// address treated, not a claim that the contract is a different protocol. So:
//
//   identity  -- comes from the builtin row. Only a user 'own' verdict removes
//                it (the user says the address is theirs, not the protocol's).
//                Identity drives the protocol EXPLANATION, which then attaches
//                even when the user renamed the address.
//   verdict   -- behavior that changes accounting (the EtherDelta custody rung,
//                the mirror's custody mapping) applies only when no user row
//                exists or the user's kind equals the builtin's kind, the same
//                rule bridge endpoints use. Renaming keeps it; re-voting the
//                kind turns it off.
//
// The scraped 'eth-labels' pack is not curated and keeps label-row semantics.

// One curated pack per protocol module that ships one (registry/protocols.js).
const { CURATED_PROTOCOL_SOURCES } = require('../registry/protocols');

function identityHolds(pair) {
  return Boolean(pair?.builtin) && pair.user?.kind !== 'own';
}

function verdictHolds(pair) {
  return identityHolds(pair) && (!pair.user || pair.user.kind === pair.builtin.kind);
}

// The builtin row whose identity applies to this address, or null.
function identityLabel(pair) {
  return identityHolds(pair) ? pair.builtin : null;
}

module.exports = {
  CURATED_PROTOCOL_SOURCES,
  identityHolds,
  verdictHolds,
  identityLabel,
};
