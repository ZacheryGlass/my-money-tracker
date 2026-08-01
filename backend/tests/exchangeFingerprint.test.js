'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  canonicalAmount,
  canonicalAsset,
  conflictingDetails,
  fingerprintFor,
  annotateRecord,
} = require('../src/services/exchangeImport/canonicalFingerprint');
const { parseExchangeCsv } = require('../src/services/exchangeImport');
const binanceConnector = require('../src/services/exchangeSync/binanceus');
const coinbaseConnector = require('../src/services/exchangeSync/coinbase');

const FIXTURES = path.join(__dirname, 'fixtures', 'exchanges');

const apiTrade = {
  record_type: 'trade',
  occurred_at: '2026-07-30T12:34:56.000Z',
  base_asset: 'ETH2',
  base_amount: '1.000000',
  quote_asset: 'USD',
  quote_amount: '-3000.00',
  fee_asset: 'USD',
  fee_amount: '12.5000',
  external_id: 'api-fill-123',
  tx_hash: '0xabc',
  source: 'api',
};

test('canonicalization normalizes provider aliases and decimal spelling', () => {
  assert.equal(canonicalAsset('coinbase', 'ETH2'), 'ETH');
  assert.equal(canonicalAsset('kraken', 'XETH.S'), 'ETH');
  assert.equal(canonicalAmount('1.000000'), '1');
  assert.equal(canonicalAmount('-0.0000'), '0');
});

test('annotated ordinary records carry the required false candidate flag', () => {
  const annotated = annotateRecord('coinbase', apiTrade);
  assert.equal(annotated.duplicate_candidate, false);
  assert.equal(annotateRecord('coinbase', { ...apiTrade, duplicate_candidate: true }).duplicate_candidate, true);
});

test('API and CSV versions of one Coinbase event share a fingerprint', () => {
  const csvTrade = {
    ...apiTrade,
    external_id: 'retail-row-987',
    base_asset: 'ETH',
    base_amount: '1',
    fee_amount: '12.5',
    source: 'csv',
    tx_hash: null,
  };

  assert.equal(fingerprintFor('coinbase', apiTrade), fingerprintFor('coinbase', csvTrade));
  // A same-day collision is deliberately found by the candidate key; the
  // full timestamp remains a conflict so it cannot auto-merge.
  assert.equal(fingerprintFor('coinbase', apiTrade), fingerprintFor('coinbase', {
    ...csvTrade,
    occurred_at: '2026-07-30T12:34:57.000Z',
  }));
  assert.notEqual(fingerprintFor('coinbase', apiTrade), fingerprintFor('coinbase', {
    ...csvTrade,
    occurred_at: '2026-07-31T12:34:56.000Z',
  }));
});

test('conflicting provider identity details stay visible to conservative dedupe', () => {
  assert.deepEqual(conflictingDetails(
    { tx_hash: '0xabc', address: '0xdef', network: 'ethereum', chain_id: 1 },
    { tx_hash: '0xABC', address: '0xdef', network: 'base', chain_id: 8453 },
  ), ['network', 'chain_id']);
  assert.deepEqual(conflictingDetails(
    { occurred_at: '2026-07-30T12:00:00Z' },
    { occurred_at: '2026-07-30T12:00:01Z' },
  ), ['occurred_at']);
});

test('Binance.US API and account-activity CSV trades share the fingerprint', () => {
  const csvRecords = parseExchangeCsv(fs.readFileSync(path.join(FIXTURES, 'binance-us.csv'), 'utf8')).records;
  const csvTrade = csvRecords.find((record) => record.external_id === 'binanceus:trade:SOLUSD:100000002');
  const apiTradeRecord = binanceConnector._internals.tradeRecord({
    symbol: 'SOLUSD',
    id: 777,
    qty: '2.500000',
    quoteQty: '350.0000',
    commission: '0.002000',
    commissionAsset: 'SOL',
    isBuyer: true,
    time: Date.parse('2026-07-31T23:39:02Z'),
  }, new Map([['SOLUSD', { baseAsset: 'SOL', quoteAsset: 'USD' }]]));

  assert.equal(
    annotateRecord('binance_us', { ...csvTrade, source: 'csv' }).fingerprint,
    annotateRecord('binance_us', { ...apiTradeRecord, source: 'api' }).fingerprint,
  );
});

test('Coinbase API and retail CSV transfer records share the fingerprint', () => {
  const api = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'coinbase-api.json'), 'utf8'));
  const apiTransaction = api.transactions.data.find((transaction) => transaction.id.startsWith('aaaaaaaa'));
  const apiRecord = coinbaseConnector._internals.recordFromTransaction(apiTransaction, {
    line: 1,
    fillsByOrder: new Map(),
  });
  const csvRecords = parseExchangeCsv(fs.readFileSync(path.join(FIXTURES, 'coinbase-retail-api-parity.csv'), 'utf8')).records;
  const csvRecord = csvRecords.find((record) => record.external_id === `cb:${apiTransaction.id}`);

  assert.equal(
    annotateRecord('coinbase', { ...apiRecord, source: 'api' }).fingerprint,
    annotateRecord('coinbase', { ...csvRecord, source: 'csv' }).fingerprint,
  );
});
