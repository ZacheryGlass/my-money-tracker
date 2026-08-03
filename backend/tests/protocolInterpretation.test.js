'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { interpretProtocolActivity } = require('../src/services/ethActivity/protocolInterpretation');

const ETH_OUT = { asset: 'ETH', direction: 'out', token_standard: null };
const USDC_IN = { asset: 'USDC', direction: 'in', token_standard: 'erc20' };
const NFT_IN = { asset: 'NFT', direction: 'in', token_standard: 'erc721' };
const NFT_OUT = { asset: 'NFT', direction: 'out', token_standard: 'erc721' };
const CTF_IN = { asset: 'CTF', direction: 'in', token_standard: 'erc1155' };

const label = (name, source = 'eth-labels', confidence = 'low') => ({ name, source, confidence });

test('router interpretation requires both a source-bearing protocol label and conserved swap legs', () => {
  const interpreted = interpretProtocolActivity(
    { category: 'swap', legs: [ETH_OUT, USDC_IN] },
    label('Uniswap V3: Router', 'eth-labels', 'low')
  );
  assert.equal(interpreted.protocol, 'Uniswap');
  assert.equal(interpreted.action, 'router_swap');
  assert.equal(interpreted.confidence, 'low');

  assert.equal(interpretProtocolActivity(
    { category: 'swap', legs: [ETH_OUT, USDC_IN] },
    label('Uniswap V3: Router', 'user-note', 'high')
  ), null, 'a user-chosen name is not source identity');
  assert.equal(interpretProtocolActivity(
    { category: 'send', legs: [ETH_OUT] },
    label('Uniswap V3: Router')
  ), null, 'a label alone does not prove a swap');
});

test('OpenSea purchase and sale explanations require opposite NFT and consideration movement', () => {
  const purchase = interpretProtocolActivity(
    { category: 'nft_purchase', legs: [ETH_OUT, NFT_IN] },
    label('OpenSea: Seaport 1.5', 'builtin-opensea', 'high')
  );
  assert.equal(purchase.action, 'nft_purchase');
  assert.deepEqual(purchase.evidence, [
    'source_backed_counterparty_label', 'netted_nft_in', 'netted_consideration_out',
  ]);

  const sale = interpretProtocolActivity(
    { category: 'nft_sale', legs: [NFT_OUT, USDC_IN] },
    label('OpenSea: Wyvern', 'builtin-opensea', 'high')
  );
  assert.equal(sale.action, 'nft_sale');
  assert.equal(interpretProtocolActivity(
    { category: 'nft_sale', legs: [NFT_OUT] },
    label('OpenSea: Wyvern', 'builtin-opensea', 'high')
  ), null);
});

test('EtherDelta interpretation states the custody boundary and does not invent fills', () => {
  const result = interpretProtocolActivity(
    { category: 'exchange_deposit', legs: [ETH_OUT] },
    label('EtherDelta', 'builtin-etherdelta', 'high')
  );
  assert.equal(result.action, 'custody_deposit');
  assert.match(result.limitations[0], /Internal EtherDelta order-book fills/);
});

test('ENS and Polymarket interpretations retain unavailable event-level semantics', () => {
  const ens = interpretProtocolActivity(
    { category: 'nft_mint', legs: [NFT_IN] },
    label('ENS: Base Registrar', 'eth-labels', 'low')
  );
  assert.equal(ens.action, 'name_token_mint');
  assert.match(ens.limitations[0], /name, generation/);

  const polymarket = interpretProtocolActivity(
    { category: 'nft_purchase', legs: [ETH_OUT, CTF_IN] },
    label('Polymarket: Conditional Tokens', 'builtin-polymarket', 'high')
  );
  assert.equal(polymarket.action, 'ctf_position_acquisition');
  assert.match(polymarket.limitations[0], /Outcome, market/);
});

test('legacy fungible mints are explained without asserting airdrop, income, or intent', () => {
  const result = interpretProtocolActivity({
    category: 'receive',
    counterparty_address: '0x0000000000000000000000000000000000000000',
    legs: [{ asset: 'OLD', direction: 'in', token_standard: 'erc20' }],
  });
  assert.equal(result.action, 'fungible_token_mint');
  assert.match(result.limitations[0], /purpose, personal intent, and tax treatment/);
});

test('selectors and decoded method names never create a protocol interpretation', () => {
  assert.equal(interpretProtocolActivity({
    category: 'contract_interaction',
    method_id: '0x7ff36ab5',
    method_name: 'swapExactETHForTokens(uint256,address[],address,uint256)',
    legs: [],
  }), null);
});
