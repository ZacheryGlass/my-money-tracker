'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const CdpClient = require('../src/services/evmAudit/CdpClient');
const CdpHistoryProvider = require('../src/services/evmAudit/CdpHistoryProvider');
const normalizer = require('../src/services/evmAudit/normalizer');
const EthWalletService = require('../src/services/EthWalletService');
const chains = require('../src/config/chains');

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const CONTRACT = '0x3333333333333333333333333333333333333333';
const ERC20 = '0x4444444444444444444444444444444444444444';
const ERC721 = '0x5555555555555555555555555555555555555555';
const ERC1155 = '0x6666666666666666666666666666666666666666';
const HASH = `0x${'ab'.repeat(32)}`;
const BLOCK_HASH = `0x${'cd'.repeat(32)}`;

function transaction(overrides = {}) {
  return {
    name: HASH,
    hash: HASH,
    blockHash: BLOCK_HASH,
    blockHeight: 123,
    status: 'confirmed',
    content: {
      ethereum: {
        from: WALLET,
        to: OTHER,
        value: '0x0',
        gas: '0x5208',
        gasPrice: '0x64',
        nonce: '0x0',
        input: '0x095ea7b3',
        blockTimestamp: '2024-01-01T00:00:00Z',
        receipt: {
          status: '0x1',
          transactionIndex: '0x3',
          gasUsed: '0x5208',
          effectiveGasPrice: '0x64',
          logs: [{ address: ERC20, logIndex: 4, topics: [] }],
        },
        flattenedTraces: [{
          from: WALLET, to: CONTRACT, value: '0x0', traceAddress: [0],
          status: '0',
        }, {
          from: OTHER, to: CONTRACT, value: '0x999', traceAddress: [1],
          status: '1',
        }],
        tokenTransfers: [
          {
            fromAddress: WALLET, toAddress: OTHER, tokenAddress: ERC20,
            logIndex: 5, erc20: { value: '123456' },
          },
          {
            fromAddress: OTHER, toAddress: WALLET, tokenAddress: ERC721,
            logIndex: 6, erc721: { tokenId: '7' },
          },
          {
            fromAddress: OTHER, toAddress: WALLET, tokenAddress: ERC1155,
            logIndex: 7, erc1155: { tokenIds: ['8'], values: ['9'] },
          },
          {
            fromAddress: OTHER, toAddress: OTHER, tokenAddress: ERC20,
            logIndex: 8, erc20: { value: '999' },
          },
        ],
      },
    },
    ...overrides,
  };
}

function jsonRpcResult(result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('CDP address history uses bounded cursor pagination and never exposes the key to attempts', async (t) => {
  const originalFetch = global.fetch;
  const requests = [];
  const attempts = [];
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const pageToken = requests.at(-1).params[0].pageToken;
    return jsonRpcResult({
      addressTransactions: [transaction({ hash: pageToken ? `0x${'ef'.repeat(32)}` : HASH })],
      nextPageToken: pageToken ? null : 'opaque-next',
    });
  };
  t.after(() => { global.fetch = originalFetch; });

  const pages = [];
  for await (const page of new CdpClient('do-not-log-this-key', {
    spacingMs: 0, maxAttempts: 1, onFailedAttempt: async (attempt) => attempts.push(attempt),
  }).addressTransactionPages(WALLET, { pageSize: 1000 })) pages.push(page);

  assert.equal(pages.length, 2);
  assert.equal(requests[0].method, 'cdp_listAddressTransactions');
  assert.deepEqual(requests[0].params[0], {
    address: WALLET.toLowerCase(), pageSize: 100, pageToken: '',
  });
  assert.equal(requests[1].params[0].pageToken, 'opaque-next');
  assert.equal(pages[0].cursorOut, 'opaque-next');
  assert.equal(pages[1].cursorOut, null);
  assert.deepEqual(attempts, []);
  assert.ok(!JSON.stringify(pages).includes('do-not-log-this-key'));
});

test('CDP pagination rejects a repeated opaque token', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => jsonRpcResult({
    addressTransactions: [], nextPageToken: 'same-token',
  });
  try {
    const iterator = new CdpClient('test-key', { spacingMs: 0, maxAttempts: 1 })
      .addressTransactionPages(WALLET);
    await iterator.next();
    await assert.rejects(() => iterator.next(), (error) => error.code === 'CDP_PAGINATION_STALLED');
  } finally {
    global.fetch = originalFetch;
  }
});

test('CDP pagination rejects non-string cursors, non-adjacent cycles, and mixed error/result envelopes', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => jsonRpcResult({
      addressTransactions: [], nextPageToken: 123,
    });
    await assert.rejects(
      () => new CdpClient('test-key', { spacingMs: 0, maxAttempts: 1 })
        .addressTransactionPages(WALLET).next(),
      (error) => error.code === 'CDP_INVALID_RESPONSE'
    );

    const cursors = [
      { addressTransactions: [], nextPageToken: 'cursor-a' },
      { addressTransactions: [], nextPageToken: 'cursor-b' },
      { addressTransactions: [], nextPageToken: 'cursor-a' },
    ];
    global.fetch = async () => jsonRpcResult(cursors.shift());
    const iterator = new CdpClient('test-key', { spacingMs: 0, maxAttempts: 1 })
      .addressTransactionPages(WALLET);
    await iterator.next();
    await iterator.next();
    await assert.rejects(() => iterator.next(), (error) => error.code === 'CDP_PAGINATION_STALLED');

    global.fetch = async () => new Response(JSON.stringify({
      jsonrpc: '2.0', id: 1,
      error: { code: -32000, message: 'partial result is invalid' },
      result: { addressTransactions: [] },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    await assert.rejects(
      () => new CdpClient('test-key', { spacingMs: 0, maxAttempts: 1 })
        .addressTransactionPages(WALLET).next(),
      (error) => error.code === 'CDP_API_ERROR'
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('CDP errors classify quota and rate limits with retry boundaries', async (t) => {
  const originalFetch = global.fetch;
  const responses = [
    new Response(JSON.stringify({ error: { message: 'monthly billing quota exhausted' } }), { status: 403 }),
    new Response(JSON.stringify({ error: { message: 'slow down' } }), {
      status: 429, headers: { 'retry-after': '2' },
    }),
  ];
  global.fetch = async () => responses.shift();
  t.after(() => { global.fetch = originalFetch; });

  await assert.rejects(
    () => new CdpClient('test-key', { spacingMs: 0, maxAttempts: 1 })
      .addressTransactionPages(WALLET).next(),
    (error) => error.code === 'CDP_QUOTA_EXHAUSTED' && error.retryAt instanceof Date
  );
  await assert.rejects(
    () => new CdpClient('test-key', { spacingMs: 0, maxAttempts: 1 })
      .addressTransactionPages(WALLET).next(),
    (error) => error.code === 'CDP_RATE_LIMITED' && error.retryAfterMs === 2000
  );
});

test('CDP normalizes failed zero-value calls, internal traces, and all token standards', () => {
  const item = transaction({
    status: 'failed',
    content: {
      ethereum: {
        ...transaction().content.ethereum,
        receipt: { ...transaction().content.ethereum.receipt, status: '0x0' },
      },
    },
  });
  const normalized = CdpHistoryProvider.normalizePage(WALLET, [item]);

  assert.equal(normalized.transactions.length, 1);
  assert.equal(normalized.feeds.normal[0].isError, '1');
  assert.equal(normalized.feeds.normal[0].value, '0');
  assert.equal(normalized.feeds.internal[0].value, '0');
  assert.equal(normalized.feeds.internal.length, 1, 'intermediary traces do not enter the wallet ledger');
  assert.equal(normalized.feeds.internal[0].isError, '1', 'the transaction-level failure propagates to its trace');
  assert.equal(normalized.feeds.token.length, 1);
  assert.equal(normalized.feeds.nft.length, 1);
  assert.equal(normalized.feeds.nft1155.length, 1);

  const ledgerRows = EthWalletService.normalizeFeeds(WALLET, normalized.feeds, {
    preserveZeroValue: true,
  });
  assert.ok(ledgerRows.some((row) => row.transfer_type === 'native' && row.value_wei === '0'));
  assert.ok(ledgerRows.some((row) => row.transfer_type === 'gas'));
  assert.ok(ledgerRows.some((row) => row.transfer_type === 'internal' && row.value_wei === '0'));
  assert.equal(ledgerRows.filter((row) => ['token', 'nft', 'nft1155'].includes(row.transfer_type))
    .every((row) => row.is_error), true);
});

test('CDP treats a trace status of string zero as an error', () => {
  const normalized = CdpHistoryProvider.normalizePage(WALLET, [transaction()]);
  assert.equal(normalized.feeds.internal[0].isError, '1');
  assert.equal(normalized.feeds.normal[0].transactionIndex, '3');
});

test('CDP treats a trace status of string one as successful', () => {
  const item = transaction();
  item.content.ethereum.flattenedTraces[0].status = '1';
  const normalized = CdpHistoryProvider.normalizePage(WALLET, [item]);
  assert.equal(normalized.feeds.internal[0].isError, '0');
});

test('CDP requires the provider to return every effect collection', () => {
  for (const field of ['flattenedTraces', 'tokenTransfers']) {
    const item = transaction();
    delete item.content.ethereum[field];
    assert.throws(
      () => CdpHistoryProvider.normalizePage(WALLET, [item]),
      (error) => error.code === 'CDP_INVALID_RESPONSE'
    );
  }
  const item = transaction();
  delete item.content.ethereum.receipt.logs;
  assert.throws(
    () => CdpHistoryProvider.normalizePage(WALLET, [item]),
    (error) => error.code === 'CDP_INVALID_RESPONSE'
  );
});

test('CDP rejects unknown status and malformed canonical economics', () => {
  assert.throws(
    () => CdpHistoryProvider.normalizePage(WALLET, [transaction({ status: 'pending' })]),
    (error) => error.code === 'CDP_INVALID_RESPONSE'
  );

  const missingGas = transaction();
  delete missingGas.content.ethereum.gas;
  assert.throws(
    () => CdpHistoryProvider.normalizePage(WALLET, [missingGas]),
    (error) => error.code === 'CDP_INVALID_RESPONSE'
  );

  const malformed1155 = transaction();
  malformed1155.content.ethereum.tokenTransfers = [{
    fromAddress: OTHER, toAddress: WALLET, tokenAddress: ERC1155,
    erc1155: { tokenIds: ['8', '9'], values: ['1'] },
  }];
  assert.throws(
    () => CdpHistoryProvider.normalizePage(WALLET, [malformed1155]),
    (error) => error.code === 'CDP_INVALID_RESPONSE'
  );
});

test('CDP balance evidence rejects missing or conflicting quantities', () => {
  const context = { jobId: 1, subjectId: 2, chainId: 8453, provider: 'coinbase-cdp' };
  const balance = {
    asset: { id: 'asset-1', type: 'erc20', groupId: ERC20, subGroupId: '' },
    value: '10', valueStr: '10', decimals: 18,
  };
  assert.equal(normalizer.cdpBalanceObservations(context, [balance]).length, 1);
  assert.throws(
    () => normalizer.cdpBalanceObservations(context, [{ ...balance, valueStr: '11' }]),
    (error) => error.code === 'CDP_INVALID_RESPONSE'
  );
});

test('CDP receipt logs provide a wallet-scoped Base bridge-credit feed', () => {
  const bridgeTopic = `0x${'12'.repeat(32)}`;
  const item = transaction({
    content: {
      ethereum: {
        ...transaction().content.ethereum,
        from: OTHER,
        to: CONTRACT,
        receipt: {
          ...transaction().content.ethereum.receipt,
          logs: [{
            address: CONTRACT,
            logIndex: 17,
            topics: [
              bridgeTopic,
              `0x${OTHER.slice(2).padStart(64, '0')}`,
              `0x${WALLET.slice(2).padStart(64, '0')}`,
            ],
            data: `0x${'00'.repeat(31)}01`,
          }],
        },
        flattenedTraces: [],
        tokenTransfers: [],
      },
    },
  });
  const normalized = CdpHistoryProvider.normalizePage(WALLET, [item], {
    nativeCredit: { contract: CONTRACT, topic0: bridgeTopic, userTopicIndex: 2 },
  });

  assert.equal(normalized.feeds.normal.length, 0, 'a bridge-only receipt has no ordinary wallet transaction leg');
  assert.equal(normalized.feeds.statesync.length, 1);
  assert.equal(normalized.feeds.statesync[0].from, CONTRACT.toLowerCase());
  assert.equal(normalized.feeds.statesync[0].to, WALLET.toLowerCase());
  assert.equal(normalized.feeds.statesync[0].value, '1');
  const rows = EthWalletService.normalizeFeeds(WALLET, normalized.feeds, {
    preserveZeroValue: true,
    stateSyncContract: CONTRACT,
  });
  assert.deepEqual(
    rows.filter((row) => row.transfer_type === 'internal').map((row) => row.value_wei),
    ['1']
  );
  assert.equal(rows.find((row) => row.transfer_type === 'internal').source_log_index, 17);
});

test('CDP preserves an OP Stack protocol mint as a native bridge credit', () => {
  const item = transaction({
    content: {
      ethereum: {
        ...transaction().content.ethereum,
        type: '0x7e',
        sourceHash: `0x${'ef'.repeat(32)}`,
        mint: '0x5',
        value: '0x0',
      },
    },
  });
  const normalized = CdpHistoryProvider.normalizePage(WALLET, [item]);
  const rows = EthWalletService.normalizeFeeds(WALLET, normalized.feeds, {
    preserveZeroValue: true,
    opStackDeposits: chains.getChain(8453).opStackDeposits,
  });

  assert.deepEqual(
    rows.filter((row) => row.transfer_type === 'native').map((row) => ({
      from: row.from_address, value: row.value_wei, isError: row.is_error,
    })),
    [{
      from: chains.getChain(8453).opStackDeposits.creditSource,
      value: '5',
      isError: false,
    }]
  );
  assert.equal(rows.some((row) => row.transfer_type === 'gas'), false,
    'protocol deposits do not charge the wallet gas');
});

test('CDP page normalization deduplicates identical transactions and rejects conflicting coordinates', () => {
  const duplicate = CdpHistoryProvider.normalizePage(WALLET, [transaction(), transaction()]);
  assert.equal(duplicate.transactions.length, 1);
  assert.equal(duplicate.feeds.normal.length, 1);

  assert.throws(
    () => CdpHistoryProvider.normalizePage(WALLET, [
      transaction(), transaction({ blockHash: `0x${'aa'.repeat(32)}` }),
    ]),
    (error) => error.code === 'CDP_CONFLICTING_TRANSACTION'
  );
});

test('CDP cross-page dedupe rejects changed economics for one transaction identity', () => {
  const seen = new Map();
  assert.equal(CdpHistoryProvider.dedupeItems([transaction()], seen).length, 1);
  assert.equal(CdpHistoryProvider.dedupeItems([transaction()], seen).length, 0);
  assert.throws(
    () => CdpHistoryProvider.dedupeItems([transaction({
      content: {
        ethereum: { ...transaction().content.ethereum, value: '0x1' },
      },
    })], seen),
    (error) => error.code === 'CDP_CONFLICTING_TRANSACTION'
  );
});

test('CDP raw observations retain receipt, log, trace, and token evidence by identity', () => {
  const observations = normalizer.cdpHistoryObservations({
    jobId: 1, subjectId: 2, chainId: 8453, provider: 'coinbase-cdp',
  }, transaction());
  const kinds = observations.map((row) => row.evidenceKind);
  assert.deepEqual(kinds, [
    'transaction', 'receipt', 'log', 'internal_trace',
    'internal_trace', 'erc20_transfer', 'erc721_transfer', 'erc1155_transfer',
    'erc20_transfer',
  ]);
  assert.equal(new Set(observations.map((row) => row.providerObjectKey)).size, observations.length);
  assert.ok(observations.every((row) => row.payloadSha256.length === 64));
});
