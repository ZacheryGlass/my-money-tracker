'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';

const pgModulePath = require.resolve('pg');
require.cache[pgModulePath] = {
  id: pgModulePath,
  filename: pgModulePath,
  loaded: true,
  exports: {
    Pool: class FakePool {
      async query() { return { rows: [], rowCount: 0 }; }
      connect() { throw new Error('Unexpected connect'); }
      on() {}
    },
    types: { setTypeParser() {} },
  },
};

const chains = require('../src/config/chains');
const ZkSyncLiteService = require('../src/services/ZkSyncLiteService');
const EthWalletService = require('../src/services/EthWalletService');
const EthWalletChain = require('../src/models/EthWalletChain');
const EthTransfer = require('../src/models/EthTransfer');

// Fixtures must remain synthetic: never commit a tracked user's address.
const WALLET = '0x2222222222222222222222222222222222222222';
const OTHER = '0x1111111111111111111111111111111111111111';
const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const TOKENS = new Map([
  [0, {
    id: 0,
    address: '0x0000000000000000000000000000000000000000',
    symbol: 'ETH',
    decimals: 18,
  }],
  [2, {
    id: 2,
    address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    symbol: 'USDC',
    decimals: 6,
  }],
]);

function tx(hash, blockNumber, op, overrides = {}) {
  return {
    txHash: hash,
    blockNumber,
    op,
    status: 'finalized',
    failReason: null,
    createdAt: '2022-09-16T12:00:00.000Z',
    ...overrides,
  };
}

test('Era and legacy Lite have distinct, explicit registry identities', () => {
  const era = chains.getChain(324);
  assert.equal(era.accountApi.baseUrl, 'https://zksync.blockscout.com/api');
  assert.equal(era.rpcUrl, 'https://mainnet.era.zksync.io');
  assert.equal(era.coingeckoPlatform, 'zksync');

  const lite = chains.getChain(ZkSyncLiteService.CHAIN_ID);
  assert.equal(lite.id, 32401);
  assert.equal(lite.historyProvider, 'zksync-lite');
  assert.equal(lite.coingeckoPlatform, 'ethereum');
  assert.notEqual(lite.id, era.id);
});

test('Lite deposits and withdrawals become bridge-classifiable unified legs', () => {
  const result = ZkSyncLiteService.normalizeTransactions(WALLET, [
    tx(HASH_A, 100, {
      type: 'Deposit',
      from: WALLET,
      to: WALLET,
      tokenId: 0,
      amount: '500000000000000000',
    }),
    tx(HASH_B, 200, {
      type: 'Withdraw',
      from: WALLET,
      to: WALLET,
      tokenId: 0,
      amount: '486081500000000000',
      fee: '1000000000000000',
    }),
  ], TOKENS, { accountId: 22 });

  assert.deepEqual(result.limitations, []);
  assert.equal(result.rows.length, 3);
  assert.deepEqual(
    result.rows.map((row) => ({
      hash: row.tx_hash,
      type: row.transfer_type,
      from: row.from_address,
      to: row.to_address,
      value: row.value_wei,
      method: row.method_name,
    })),
    [
      {
        hash: HASH_A,
        type: 'native',
        from: ZkSyncLiteService.BRIDGE_ADDRESS,
        to: WALLET,
        value: '500000000000000000',
        method: 'zkSync Lite Deposit',
      },
      {
        hash: HASH_B,
        type: 'native',
        from: WALLET,
        to: ZkSyncLiteService.BRIDGE_ADDRESS,
        value: '486081500000000000',
        method: 'zkSync Lite Withdraw',
      },
      {
        hash: HASH_B,
        type: 'gas',
        from: WALLET,
        to: ZkSyncLiteService.BRIDGE_ADDRESS,
        value: '1000000000000000',
        method: 'zkSync Lite Withdraw',
      },
    ]
  );
});

test('Lite ERC-20 transfers preserve token base units and token-denominated fees', () => {
  const result = ZkSyncLiteService.normalizeTransactions(WALLET, [
    tx(HASH_A, 300, {
      type: 'Transfer',
      from: WALLET,
      to: OTHER,
      token: 2,
      amount: '12500000',
      fee: '2500',
    }),
  ], TOKENS);

  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map((row) => ({
    ordinal: row.ordinal,
    type: row.transfer_type,
    contract: row.token_contract,
    symbol: row.token_symbol,
    decimals: row.token_decimals,
    value: row.value_wei,
  })), [
    {
      ordinal: 0,
      type: 'token',
      contract: TOKENS.get(2).address,
      symbol: 'USDC',
      decimals: 6,
      value: '12500000',
    },
    {
      ordinal: 1,
      type: 'token',
      contract: TOKENS.get(2).address,
      symbol: 'USDC',
      decimals: 6,
      value: '2500',
    },
  ]);
});

test('Lite swaps emit both wallet asset effects plus the submitter fee', () => {
  const result = ZkSyncLiteService.normalizeTransactions(WALLET, [
    tx(HASH_A, 400, {
      type: 'Swap',
      submitterAddress: WALLET,
      feeToken: 0,
      fee: '10',
      orders: [
        { accountId: 22, recipient: WALLET, tokenSell: 0, tokenBuy: 2 },
        { accountId: 33, recipient: OTHER, tokenSell: 2, tokenBuy: 0 },
      ],
      amounts: ['1000000000000000000', '2500000000'],
    }),
  ], TOKENS, { accountId: 22 });

  assert.deepEqual(
    result.rows.map((row) => [row.transfer_type, row.from_address, row.to_address, row.value_wei]),
    [
      ['native', WALLET, ZkSyncLiteService.BRIDGE_ADDRESS, '1000000000000000000'],
      ['token', ZkSyncLiteService.BRIDGE_ADDRESS, WALLET, '2500000000'],
      ['gas', WALLET, ZkSyncLiteService.BRIDGE_ADDRESS, '10'],
    ]
  );
});

test('amount-less legacy operations stay visible and mark reconciliation incomplete', () => {
  const result = ZkSyncLiteService.normalizeTransactions(WALLET, [
    tx(HASH_A, 500, { type: 'FullExit', accountId: 22, tokenId: 0 }),
    tx(HASH_B, 501, {
      type: 'ForcedExit',
      initiatorAccountId: 22,
      target: WALLET,
      tokenId: 0,
      fee: '7',
    }),
  ], TOKENS, { accountId: 22 });

  assert.deepEqual(result.limitations, ['legacy_amounts']);
  assert.equal(result.rows.length, 3);
  assert.equal(result.rows[0].value_wei, '0');
  assert.match(result.rows[0].method_name, /exit amount unavailable/);
  assert.deepEqual(
    result.rows.slice(1).map((row) => [row.transfer_type, row.value_wei, row.method_name]),
    [
      ['gas', '7', 'zkSync Lite ForcedExit'],
      ['native', '0', 'zkSync Lite ForcedExit (forced-exit amount unavailable)'],
    ]
  );
});

test('Lite history pagination is overlap-bounded and de-duplicates the boundary', async (t) => {
  const original = ZkSyncLiteService._request;
  const calls = [];
  t.after(() => { ZkSyncLiteService._request = original; });

  const first = Array.from({ length: 100 }, (_, index) =>
    tx(`0x${(1000 - index).toString(16).padStart(64, '0')}`, 200 - index, {
      type: 'Transfer',
      from: OTHER,
      to: WALLET,
      token: 0,
      amount: '1',
      fee: '0',
    }));
  const boundary = first.at(-1);
  ZkSyncLiteService._request = async (path, params) => {
    calls.push({ path, ...params });
    if (params.from === 'latest') return { list: first };
    return {
      list: [
        boundary,
        tx(HASH_B, 99, {
          type: 'Transfer',
          from: OTHER,
          to: WALLET,
          token: 0,
          amount: '1',
          fee: '0',
        }),
      ],
    };
  };

  const result = await ZkSyncLiteService.fetchHistory(WALLET, 100);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].from, boundary.txHash);
  assert.equal(result.transactions.length, 100);
  assert.equal(new Set(result.transactions.map((row) => row.txHash)).size, 100);
  assert.equal(result.scannedThroughBlock, 200);
});

test('Lite sync replaces only its overlap window and advances its normal cursor', async (t) => {
  const restore = [];
  const stub = (object, key, value) => {
    restore.push([object, key, object[key]]);
    object[key] = value;
  };
  t.after(() => {
    for (const [object, key, value] of restore.reverse()) object[key] = value;
  });

  const calls = { deletes: [], cursors: [], gaps: [] };
  stub(EthWalletChain, 'ensure', async () => ({
    ingest_version: 0,
    last_block_normal: 200,
  }));
  stub(EthWalletChain, 'updateCursors', async (walletId, chainId, value) => {
    calls.cursors.push({ walletId, chainId, value });
  });
  stub(EthWalletChain, 'setUnsupportedFeeds', async (walletId, chainId, value) => {
    calls.gaps.push({ walletId, chainId, value });
  });
  stub(EthWalletChain, 'clearError', async () => {});
  stub(EthWalletChain, 'updateSyncTime', async () => {});
  stub(EthTransfer, 'deleteFromBlock', async (...args) => { calls.deletes.push(args); });
  stub(EthTransfer, 'bulkInsert', async (rows) => rows.length);
  stub(ZkSyncLiteService, 'fetchHistory', async (walletAddress, startBlock) => {
    assert.equal(walletAddress, WALLET);
    assert.equal(startBlock, 136);
    return {
      transactions: [
        tx(HASH_A, 220, {
          type: 'Deposit',
          from: WALLET,
          to: WALLET,
          tokenId: 0,
          amount: '10',
        }),
      ],
      scannedThroughBlock: 220,
    };
  });
  stub(ZkSyncLiteService, 'getAccount', async () => ({
    committed: { accountId: 22, balances: {} },
  }));
  stub(ZkSyncLiteService, 'getTokens', async () => TOKENS);

  const result = await EthWalletService._syncZkSyncLiteWalletChain(
    { id: 7, address: WALLET },
    chains.getChain(32401)
  );

  assert.equal(result.inserted, 1);
  assert.deepEqual(calls.deletes, [[
    7,
    32401,
    ['native', 'internal', 'token', 'gas', 'nft', 'nft1155'],
    136,
  ]]);
  assert.equal(calls.cursors[0].value.normal, 220);
  assert.deepEqual(calls.gaps[0].value, []);
});
