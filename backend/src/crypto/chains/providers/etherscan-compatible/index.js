'use strict';

// The Etherscan account-API dialect (module=account, startblock/endblock,
// page/offset, ascending). Served by Etherscan V2 itself and by every
// Etherscan-compatible explorer a network declares in `accountApi`
// (Blockscout's legacy API, the ZKsync Explorer). Page sizes, the exact-fee
// field and request spacing come from the network's accountApi block.
//
// The walk is ascending and fail-closed: a page outside the requested range,
// a crowded block that fills the provider maximum, or a walk past the page
// budget freezes the cursor instead of skipping data.

const { EXPLORER_CREDENTIAL } = require('../credentials');

module.exports = {
  id: 'etherscan-compatible',
  // Needed only when the network's accountApi does not declare requiresApiKey:
  // false (Etherscan V2 itself).
  credential: EXPLORER_CREDENTIAL,

  async *pages({ service, internals, action, address, startBlock, endBlock, apiKey, chainId, accountApi }) {
    const { apiError, PAGE_SIZE, MAX_ACCOUNT_PAGES } = internals;
    let cursor = startBlock;
    const pageSize = Number(accountApi?.pageSize) || PAGE_SIZE;
    const blockPageSize = Number(accountApi?.blockPageSize) || 10000;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE
        || !Number.isSafeInteger(blockPageSize) || blockPageSize < pageSize
        || blockPageSize > 10000) {
      throw apiError(`Chain ${chainId} account provider has invalid page-size configuration`);
    }
    const readPage = async (throughBlock, offset) => {
      const { result, evidence } = await service._request({
        module: 'account', action, address, startblock: cursor,
        endblock: throughBlock, page: 1, offset, sort: 'asc',
      }, { apiKey, chainId, captureEvidence: true });
      if (!Array.isArray(result) || !evidence) {
        throw apiError(`${action} returned a non-array page or missing evidence; cursor frozen`);
      }
      for (const row of result) {
        const block = Number(row?.blockNumber);
        if (!Number.isSafeInteger(block) || block < cursor || block > throughBlock) {
          throw apiError(`${action} returned block ${JSON.stringify(row?.blockNumber)} outside requested range ${cursor}-${throughBlock}; cursor frozen`);
        }
      }
      // Sort a copy so retained responseJson remains the provider's exact page.
      const rows = result.slice().sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber))
        .map((row) => (action === 'txlistinternal' && !row.hash && row.transactionHash
          ? { ...row, hash: row.transactionHash } : row))
        .map((row) => {
          if (action !== 'txlist' || !accountApi?.normalFeeField) return row;
          const fee = row?.[accountApi.normalFeeField];
          if (typeof fee !== 'string' || !/^\d+$/.test(fee)) {
            throw apiError(
              `${accountApi.provider || 'account provider'} returned an invalid exact fee`
            );
          }
          return { ...row, feeWei: fee };
        });
      return { ...evidence, rows, cursorIn: String(cursor), itemCount: rows.length };
    };
    const hydrate = async (page) => ({
      ...page,
      rows: action === 'txlist' ? await service._hydrateOpStackDeposits(page.rows, chainId) : page.rows,
    });
    for (let count = 0; cursor <= endBlock; count += 1) {
      if (count >= MAX_ACCOUNT_PAGES) {
        throw apiError(`${action} account walk exceeded ${MAX_ACCOUNT_PAGES} pages without completing; cursor frozen`);
      }
      const page = await readPage(endBlock, pageSize);
      const lastBlock = Number(page.rows.at(-1)?.blockNumber);
      const full = page.rows.length >= pageSize;
      page.cursorOut = full ? String(lastBlock) : null;
      yield await hydrate(page);
      if (!full) break;
      if (lastBlock === cursor) {
        // Re-read a crowded block at the provider maximum. A full maximum
        // window cannot prove exhaustion, so never step past that unknown tail.
        const blockPage = await readPage(cursor, blockPageSize);
        if (blockPage.rows.length >= blockPageSize) {
          throw apiError(
            `${action} block ${cursor} reached the ${blockPageSize}-row provider limit; cursor frozen`
          );
        }
        blockPage.cursorOut = String(cursor + 1);
        yield await hydrate(blockPage);
        cursor += 1;
      } else {
        cursor = lastBlock;
      }
    }
  },
};
