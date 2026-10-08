'use strict';

// Which venues the API sync can talk to, and what each one's credential form
// asks for: both declared by the venue folders (crypto/exchanges/venues).
// 'other' is CSV-only by definition -- there is no endpoint to call.
const { VENUE_MODULES } = require('../../crypto/exchanges/venues');

const CONNECTORS = new Map(VENUE_MODULES
  .filter((venue) => venue.hasConnector)
  .map((venue) => [venue.id, venue.connector]));

function connectorFor(exchange) {
  return CONNECTORS.get(exchange) || null;
}

// The two providers use different words for the same two fields and getting
// them the wrong way round produces nothing but 401s, so the labels come from
// the venue that consumes them rather than being retyped in the UI.
const CREDENTIAL_FIELDS = Object.fromEntries(VENUE_MODULES
  .filter((venue) => venue.hasConnector)
  .map((venue) => [venue.id, venue.credentials]));

module.exports = { CONNECTORS, connectorFor, CREDENTIAL_FIELDS };
