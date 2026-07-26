'use strict';

// ERC-721 / ERC-1155 ingest. Fixtures are trimmed copies of real
// tokennfttx / token1155tx responses for
// 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045, so the field names asserted here
// are the ones Etherscan actually sends -- note neither NFT feed carries an
// `isError` field, and only tokennfttx carries `tokenDecimal`.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const queries = [];
const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      async query(text, params) {
        queries.push({ text, params });
        return { rows: [] };
      }
      connect() { throw new Error('Unexpected connect'); }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const EthWalletService = require('../src/services/EthWalletService');
const EtherscanService = require('../src/services/EtherscanService');
const EthTransfer = require('../src/models/EthTransfer');
const { buildMirrorRow } = require('../src/services/EthTransactionMirrorService');

const sqlOf = (query) => query.text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

const WALLET = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const OTHER = '0x91d40d9f7179ecb8c691e204baa1167e26b2d327';
const ZERO = '0x0000000000000000000000000000000000000000';
const NFT_CONTRACT = '0xA1EB40c284C5B44419425c4202Fa8DabFF31006b';

function nftTx(overrides = {}) {
  return {
    blockNumber: '7791330',
    timeStamp: '1558280061',
    hash: '0xnft1',
    from: ZERO,
    contractAddress: NFT_CONTRACT,
    to: WALLET,
    tokenID: '682',
    tokenName: 'POAP',
    tokenSymbol: 'POAP',
    tokenDecimal: '0',
    gas: '500000',
    gasPrice: '10000000000',
    gasUsed: '245056',
    ...overrides,
  };
}

function tx1155(overrides = {}) {
  return {
    blockNumber: '9045965',
    timeStamp: '1575410760',
    hash: '0x1155a',
    contractAddress: '0xFaaFDc07907ff5120a76b34b731b278c38d6043C',
    from: OTHER,
    to: WALLET,
    tokenID: '50885195465617469194167106852330514362694690086631139282090694154350210580562',
    tokenValue: '1',
    tokenName: 'Enjin',
    tokenSymbol: 'ENJ',
    ...overrides,
  };
}

test('ERC-721 rows map to transfer_type nft with a unit quantity of 1', () => {
  const rows = EthWalletService.normalizeFeeds(WALLET, { nft: [nftTx()] });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.transfer_type, 'nft');
  assert.equal(row.token_standard, 'erc721');
  assert.equal(row.token_id, '682');
  // tokennfttx has no value field: an ERC-721 is indivisible, so exactly one
  // unit moves per row.
  assert.equal(row.value_wei, '1');
  // 0, not NULL -- the shared unit helpers default NULL to 18 and would render
  // the token as 0.000000000000000001.
  assert.equal(row.token_decimals, 0);
  assert.equal(row.token_contract, NFT_CONTRACT.toLowerCase());
  assert.equal(row.token_symbol, 'POAP');
  // The feed has no isError field; an NFT log only exists on success.
  assert.equal(row.is_error, false);
});

test('ERC-1155 rows store tokenValue as a unit count in value_wei', () => {
  const rows = EthWalletService.normalizeFeeds(WALLET, {
    nft1155: [tx1155({ tokenValue: '100' })],
  });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.transfer_type, 'nft1155');
  assert.equal(row.token_standard, 'erc1155');
  // 100 COPIES of that id, not 100 wei and not a scaled decimal amount.
  assert.equal(row.value_wei, '100');
  assert.equal(row.token_decimals, 0);
});

test('a uint256 token id survives as an exact string', () => {
  const rows = EthWalletService.normalizeFeeds(WALLET, { nft1155: [tx1155()] });
  // Round-tripping this through Number would silently corrupt it -- and
  // token_id is NUMERIC(78,0) precisely so the full value can be stored.
  assert.equal(
    rows[0].token_id,
    '50885195465617469194167106852330514362694690086631139282090694154350210580562'
  );
  assert.equal(typeof rows[0].token_id, 'string');
});

test('a mint (from 0x0) and a burn (to 0x0) both keep the zero address', () => {
  const rows = EthWalletService.normalizeFeeds(WALLET, {
    nft: [
      nftTx({ hash: '0xmint', from: ZERO, to: WALLET }),
      nftTx({ hash: '0xburn', from: WALLET, to: ZERO, tokenID: '683' }),
    ],
  });
  const mint = rows.find((r) => r.tx_hash === '0xmint');
  const burn = rows.find((r) => r.tx_hash === '0xburn');
  // Both endpoints are real and load-bearing: the activity layer tells a mint
  // from a purchase by exactly this, so neither may be normalized away to NULL.
  assert.equal(mint.from_address, ZERO);
  assert.equal(mint.to_address, WALLET.toLowerCase());
  assert.equal(burn.from_address, WALLET.toLowerCase());
  assert.equal(burn.to_address, ZERO);
});

test('an ERC-1155 batch lands one row per id with sequential ordinals', () => {
  const batch = [1, 2, 3].map((id) => tx1155({ hash: '0xbatch', tokenID: String(id) }));
  const rows = EthWalletService.normalizeFeeds(WALLET, { nft1155: batch });
  assert.deepEqual(rows.map((r) => r.token_id), ['1', '2', '3']);
  // Etherscan pre-unbundles a safeBatchTransferFrom, so ordinals just count
  // position in the feed -- which is what makes re-sync dedupe stable.
  assert.deepEqual(rows.map((r) => r.ordinal), [0, 1, 2]);
});

test('each NFT feed keeps its own ordinal space on a shared tx hash', () => {
  const rows = EthWalletService.normalizeFeeds(WALLET, {
    token: [{
      hash: '0xshared', blockNumber: '100', timeStamp: '1700000000',
      from: OTHER, to: WALLET, value: '5',
      contractAddress: '0xToken0000000000000000000000000000000001',
      tokenSymbol: 'TKN', tokenDecimal: '18',
    }],
    nft: [nftTx({ hash: '0xshared' }), nftTx({ hash: '0xshared', tokenID: '683' })],
    nft1155: [tx1155({ hash: '0xshared' })],
  });

  // UNIQUE (wallet_id, transfer_type, tx_hash, ordinal): the ordinal is a
  // position WITHIN one feed. Three feeds sharing 'token' would interleave
  // three independently-paged sequences under one key and collide on re-sync.
  assert.deepEqual(rows.filter((r) => r.transfer_type === 'token').map((r) => r.ordinal), [0]);
  assert.deepEqual(rows.filter((r) => r.transfer_type === 'nft').map((r) => r.ordinal), [0, 1]);
  assert.deepEqual(rows.filter((r) => r.transfer_type === 'nft1155').map((r) => r.ordinal), [0]);
});

test('ERC-20 rows are tagged erc20 and ETH rows carry no standard at all', () => {
  const rows = EthWalletService.normalizeFeeds(WALLET, {
    normal: [{
      hash: '0xeth', blockNumber: '100', timeStamp: '1700000000',
      from: WALLET, to: OTHER, value: '1000000000000000000',
      gasUsed: '21000', gasPrice: '50000000000', isError: '0',
    }],
    internal: [{
      hash: '0xint', blockNumber: '101', timeStamp: '1700000001',
      from: OTHER, to: WALLET, value: '7', isError: '0',
    }],
    token: [{
      hash: '0xtok', blockNumber: '102', timeStamp: '1700000002',
      from: OTHER, to: WALLET, value: '9',
      contractAddress: '0xToken0000000000000000000000000000000001',
      tokenSymbol: 'TKN', tokenDecimal: '18',
    }],
  });

  const standards = Object.fromEntries(rows.map((r) => [r.transfer_type, r.token_standard]));
  assert.equal(standards.token, 'erc20');
  assert.equal(standards.native, null);
  assert.equal(standards.internal, null);
  assert.equal(standards.gas, null);
  assert.ok(rows.every((r) => r.token_id === null));
});

test('bulkInsert writes token_standard and token_id', async () => {
  queries.length = 0;
  await EthTransfer.bulkInsert([{
    wallet_id: 1, tx_hash: '0xnft1', ordinal: 0, transfer_type: 'nft',
    block_number: 7791330, block_time: new Date(0), from_address: ZERO,
    to_address: WALLET.toLowerCase(), value_wei: '1',
    token_contract: NFT_CONTRACT.toLowerCase(), token_symbol: 'POAP',
    token_decimals: 0, token_standard: 'erc721', token_id: '682', is_error: false,
  }]);
  const sql = sqlOf(queries[0]);
  assert.match(sql, /INSERT INTO eth_transfers \([^)]*token_standard, token_id, is_error\)/);
  // Column order and value order must agree or every row is written skewed.
  assert.deepEqual(queries[0].params.slice(-3), ['erc721', '682', false]);
});

test('holdings derivation cannot see NFT rows', async () => {
  queries.length = 0;
  await EthTransfer.tokenBalanceDeltas(9);
  const sql = sqlOf(queries[0]);
  // This is the one query that turns a contract into a priced holding, so it
  // is filtered twice: NFT feeds already have their own transfer_types, and
  // the standard test is the fail-closed half.
  assert.match(sql, /t\.transfer_type = 'token'/);
  assert.match(sql, /t\.token_standard = 'erc20'/);
});

test('the transactions mirror drops NFT rows instead of pricing them as ETH', () => {
  const base = {
    tx_hash: '0xnft1', block_time: new Date(0), from_address: ZERO,
    to_address: WALLET.toLowerCase(), value_wei: '1', is_error: false,
    counterparty_is_own: false, counterparty_exchange: null,
    token_contract: NFT_CONTRACT.toLowerCase(), token_symbol: 'POAP',
    token_decimals: 0, token_id: '682',
  };
  // Without the guard these fall through to the native-ETH branch and post a
  // CRYPTO_EXTERNAL row worth 1e-18 ETH for every mint the wallet ever received.
  assert.equal(buildMirrorRow({ ...base, transfer_type: 'nft', token_standard: 'erc721' }, WALLET, { ethPrice: 3000 }), null);
  assert.equal(buildMirrorRow({ ...base, transfer_type: 'nft1155', token_standard: 'erc1155', value_wei: '3' }, WALLET, { ethPrice: 3000 }), null);
});

test('the triage queue excludes the zero address', async () => {
  queries.length = 0;
  await EthTransfer.unreviewedCounterparties(7);
  const sql = sqlOf(queries[0]);
  // A burn is outbound, hence material, so without this one unlabelable row
  // would pin the attention badge above zero forever.
  assert.match(sql, /<> '0x0000000000000000000000000000000000000000'/);
});

test('the NFT feeds hit the documented Etherscan actions', async () => {
  const seen = [];
  const original = EtherscanService._fetchPaged;
  EtherscanService._fetchPaged = async (action, address, startBlock) => {
    seen.push({ action, address, startBlock });
    return [];
  };
  try {
    await EtherscanService.fetchNftTxs(WALLET, 100, 'key');
    await EtherscanService.fetch1155Txs(WALLET, 200, 'key');
  } finally {
    EtherscanService._fetchPaged = original;
  }
  assert.deepEqual(seen, [
    { action: 'tokennfttx', address: WALLET, startBlock: 100 },
    { action: 'token1155tx', address: WALLET, startBlock: 200 },
  ]);
});
