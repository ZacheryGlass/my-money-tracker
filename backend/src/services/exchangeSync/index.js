'use strict';

const kraken = require('./kraken');
const coinbase = require('./coinbase');
const binanceUs = require('./binanceus');

// Which venues the API sync can talk to. 'other' is CSV-only by definition --
// there is no endpoint to call -- so it never reaches here.
const CONNECTORS = new Map([
  [kraken.EXCHANGE, kraken],
  [coinbase.EXCHANGE, coinbase],
  [binanceUs.EXCHANGE, binanceUs],
]);

function connectorFor(exchange) {
  return CONNECTORS.get(exchange) || null;
}

// What the credential form asks for, per venue. The two providers use
// different words for the same two fields and getting them the wrong way round
// produces nothing but 401s, so the labels come from the code that consumes
// them rather than being retyped in the UI.
const CREDENTIAL_FIELDS = {
  kraken: {
    keyLabel: 'API key',
    secretLabel: 'Private key',
    // https://support.kraken.com/articles/360000919966-how-to-create-an-api-key
    permissions: kraken.REQUIRED_PERMISSIONS,
    help: 'Create the key with ONLY Query Funds, Query Ledger Entries and Query Closed Orders & Trades. '
      + 'Do not grant Withdraw Funds — withdrawal destinations are readable with Query Ledger Entries alone.',
  },
  coinbase: {
    keyLabel: 'Key name',
    secretLabel: 'Private key (ECDSA PEM)',
    // https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/rest-api
    permissions: coinbase.REQUIRED_PERMISSIONS,
    help: 'Create a CDP secret API key with the View permission only — no Trade, no Transfer. '
      + 'Choose ECDSA as the signature algorithm; Ed25519 keys are not supported by these APIs.',
  },
  binance_us: {
    keyLabel: 'API key',
    secretLabel: 'Secret key',
    permissions: binanceUs.REQUIRED_PERMISSIONS,
    help: 'Create an API key with read-only permissions. This integration only calls signed GET endpoints; never grant trading, withdrawal, or transfer permissions.',
  },
};

module.exports = { CONNECTORS, connectorFor, CREDENTIAL_FIELDS };
