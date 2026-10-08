'use strict';

// Blockscout's V2 REST address history (addresses/<a>/transactions and
// /internal-transactions): newest-first, cursor-paginated by
// next_page_params, gated on the instance's global indexing ratios. Selected
// per feed by a network's `routes` (normal / internal: 'blockscout-v2').
//
// The walk is fail-closed: an incomplete index, a repeated row or cursor, or a
// walk past the page budget freezes the cursor. The whole walk is returned as
// ONE logical page whose evidence retains every raw response body.

const crypto = require('crypto');

const FEEDS = { txlist: 'normal', txlistinternal: 'internal' };

module.exports = {
  id: 'blockscout-v2',

  async *pages({ service, internals, action, address, startBlock, endBlock, apiKey, chainId, accountApi }) {
    const { apiError, MAX_ACCOUNT_PAGES } = internals;
    const kind = FEEDS[action];
    if (!kind) throw apiError(`Blockscout V2 serves no ${action} feed; cursor frozen`);
    const config = kind === 'internal'
      ? {
        path: 'internal-transactions',
        normalize: (row) => service._normalizeBlockscoutV2Internal(row),
        rowKey: (row) => `${row.hash}:${row.traceId}`,
        repeated: 'internal trace',
        requiredRatio: 'indexed_internal_transactions_ratio',
        incomplete: 'internal index',
        hydrate: (rows) => service._hydrateBlockscoutV2InternalStatus(rows, chainId),
      }
      : {
        path: 'transactions',
        normalize: (row) => service._normalizeBlockscoutV2Normal(row),
        rowKey: (row) => row.hash,
        repeated: 'transaction',
        requiredRatio: null,
        incomplete: 'block index',
        hydrate: null,
      };
    if (!/^0x[0-9a-f]{40}$/i.test(String(address))) {
      throw apiError(`Blockscout V2 ${kind} history requires a valid address; cursor frozen`);
    }
    const baseUrl = accountApi.v2BaseUrl;
    if (!baseUrl) {
      throw apiError(`Blockscout V2 ${kind} history has no endpoint; cursor frozen`);
    }
    const statusResponse = await service._blockscoutV2Request(
      chainId, apiKey, baseUrl, 'main-page/indexing-status'
    );
    const status = statusResponse.payload;
    const complete = status.finished_indexing === true
      && status.finished_indexing_blocks === true
      && Number(status.indexed_blocks_ratio) === 1
      && (!config.requiredRatio || Number(status[config.requiredRatio]) === 1);
    if (!complete) {
      throw apiError(`Blockscout V2 ${config.incomplete} is incomplete; cursor frozen`);
    }

    const normalizedAddress = String(address).toLowerCase();
    const path = `addresses/${encodeURIComponent(normalizedAddress)}/${config.path}`;
    const sourcePages = [];
    const rows = [];
    const rowKeys = new Set();
    const cursorKeys = new Set();
    let next = {};
    let exhausted = false;
    // V2 pages newest-first. While every item so far has arrived in
    // non-increasing block order, a page reaching below startBlock proves
    // every later page is older still, so the walk can stop there instead of
    // re-reading the wallet's whole history on every sync. Any out-of-order
    // item disables the shortcut and the walk runs to the provider's end.
    let lastBlockSeen = Infinity;
    let monotonic = true;
    for (let count = 0; count < MAX_ACCOUNT_PAGES; count += 1) {
      const page = await service._blockscoutV2Request(chainId, apiKey, baseUrl, path, next);
      const items = page.payload.items;
      if (!Array.isArray(items)) {
        throw apiError(`Blockscout V2 ${kind} history returned no items array; cursor frozen`);
      }
      sourcePages.push(page);
      for (const item of items) {
        const normalized = config.normalize(item);
        const key = config.rowKey(normalized);
        if (rowKeys.has(key)) {
          throw apiError(`Blockscout V2 repeated ${config.repeated} ${key}; cursor frozen`);
        }
        rowKeys.add(key);
        const block = Number(normalized.blockNumber);
        if (!(block <= lastBlockSeen)) monotonic = false;
        lastBlockSeen = block;
        if (block >= startBlock && block <= endBlock) rows.push(normalized);
      }
      const nextParams = page.payload.next_page_params;
      if (nextParams == null) {
        exhausted = true;
        break;
      }
      if (monotonic && items.length > 0 && lastBlockSeen < startBlock) {
        exhausted = true;
        break;
      }
      if (typeof nextParams !== 'object' || Array.isArray(nextParams)
          || Object.keys(nextParams).length === 0
          || Object.values(nextParams).some((value) => !['string', 'number'].includes(typeof value))) {
        throw apiError('Blockscout V2 returned an invalid pagination cursor; cursor frozen');
      }
      const cursorKey = JSON.stringify(
        Object.entries(nextParams).sort(([a], [b]) => a.localeCompare(b))
      );
      if (cursorKeys.has(cursorKey)) {
        throw apiError('Blockscout V2 repeated its pagination cursor; cursor frozen');
      }
      cursorKeys.add(cursorKey);
      next = nextParams;
    }
    if (!exhausted) {
      throw apiError(`Blockscout V2 ${kind} walk exceeded ${MAX_ACCOUNT_PAGES} pages; cursor frozen`);
    }

    const outputRows = config.hydrate ? await config.hydrate(rows) : rows;
    outputRows.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber)
      || a.hash.localeCompare(b.hash)
      || (a.blockscoutTraceIndex ?? 0) - (b.blockscoutTraceIndex ?? 0));

    // Retain the exact raw body of every provider response inside one evidence
    // envelope. The sync path consumes only rows, while the audit path can
    // persist and hash this bounded, complete proof as one logical page.
    const responseJson = {
      indexing_status: statusResponse.payload,
      pages: sourcePages.map((page) => page.payload),
    };
    const rawText = JSON.stringify({
      indexing_status: statusResponse.evidence.rawText,
      pages: sourcePages.map((page) => page.evidence.rawText),
    });
    yield {
      provider: 'Blockscout V2',
      endpoint: new URL(path, `${String(baseUrl).replace(/\/$/, '')}/`).toString(),
      requestParams: {
        address: normalizedAddress,
        startblock: startBlock,
        endblock: endBlock,
        page_count: sourcePages.length,
      },
      rawText,
      responseJson,
      responseSha256: crypto.createHash('sha256').update(rawText).digest('hex'),
      requestId: null,
      rows: outputRows,
      cursorIn: String(startBlock),
      cursorOut: null,
      itemCount: outputRows.length,
    };
  },
};
