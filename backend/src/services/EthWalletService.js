'use strict';

const pool = require('../config/database');
const EtherscanService = require('./EtherscanService');
const SecretsService = require('./SecretsService');
const EthTransactionMirrorService = require('./EthTransactionMirrorService');
const EthActivityService = require('./EthActivityService');
const ExchangeMatchService = require('./ExchangeMatchService');
const EthReconciliationService = require('./EthReconciliationService');
const MethodSignatureService = require('./MethodSignatureService');
const PriceService = require('./PriceService');
const TransactionClassificationService = require('./TransactionClassificationService');
const EthWallet = require('../models/EthWallet');
const EthWalletChain = require('../models/EthWalletChain');
const EthTransfer = require('../models/EthTransfer');
const chains = require('../config/chains');
const logger = require('../config/logger');
const { shortAddress } = require('../utils/ethAddress');

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

// The five Etherscan account feeds, each with the cursor it resumes from and
// the transfer_types it owns. `normal` owns two: gas rows are synthesized from
// txlist, so they share its resume window.
//
// Order matters only for throttle fairness -- the feeds are independent, and
// each one's failure is isolated from the others (see _syncWalletChain).
const FEED_SPECS = [
  { key: 'normal', fetch: 'fetchNormalTxs', types: ['native', 'gas'] },
  { key: 'internal', fetch: 'fetchInternalTxs', types: ['internal'] },
  { key: 'token', fetch: 'fetchTokenTxs', types: ['token'] },
  { key: 'nft', fetch: 'fetchNftTxs', types: ['nft'] },
  { key: 'nft1155', fetch: 'fetch1155Txs', types: ['nft1155'] },
];

// holdings.quantity is DECIMAL(20,8): 12 integer digits, 8 fractional.
// Scam-token airdrops mint absurd quantities that would overflow the column
// and break the whole sync, so quantities are clamped; the ignore list is the
// real remedy for those tokens.
const MAX_QUANTITY = '999999999999.99999999';

function unitsToDecimalString(value, decimals) {
  const v = BigInt(value);
  if (v <= 0n) return '0';
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  if (whole.toString().length > 12) return MAX_QUANTITY;
  const frac = (v % base).toString().padStart(Number(decimals), '0').slice(0, 8);
  return frac ? `${whole}.${frac}` : whole.toString();
}

// Sync resumes this many blocks before the stored cursor so a chain reorg
// near the tip is healed by the delete-then-reinsert ingest. Sized past
// Ethereum's finality window (~2 epochs = 64 blocks).
const REORG_OVERLAP_BLOCKS = 64;

// transactions/holdings rebuilds are delete-then-insert, so concurrent runs
// (cron job, manual sync, sync-on-add, ignore-list refresh) would corrupt
// derived data. All such work funnels through this in-process queue.
let derivedQueue = Promise.resolve();

function serialized(fn) {
  const run = derivedQueue.then(fn, fn);
  derivedQueue = run.then(() => undefined, () => undefined);
  return run;
}

function toTimestamp(unixSeconds) {
  return new Date(Number(unixSeconds) * 1000);
}

function maxBlock(rows) {
  let max = null;
  for (const row of rows) {
    const block = Number(row.blockNumber);
    if (max === null || block > max) max = block;
  }
  return max;
}

class EthWalletService {
  // Pure: raw Etherscan feed rows -> eth_transfers rows (without wallet_id).
  // Gas rows are synthesized here, one per normal tx sent by the wallet --
  // including failed txs, which still burn gas. Zero-value normal/internal
  // rows (contract calls, approvals) are dropped as noise; their economic
  // content is the gas row and/or the token row from the token feed.
  static normalizeFeeds(walletAddress, { normal = [], internal = [], token = [], nft = [], nft1155 = [] } = {}) {
    const wallet = walletAddress.toLowerCase();
    const rows = [];
    const ordinals = new Map();

    const nextOrdinal = (transferType, txHash) => {
      const key = `${transferType}:${txHash}`;
      const ordinal = ordinals.get(key) || 0;
      ordinals.set(key, ordinal + 1);
      return ordinal;
    };

    const baseRow = (raw, transferType) => ({
      tx_hash: raw.hash,
      ordinal: nextOrdinal(transferType, raw.hash),
      transfer_type: transferType,
      block_number: Number(raw.blockNumber),
      block_time: toTimestamp(raw.timeStamp),
      from_address: (raw.from || '').toLowerCase(),
      to_address: raw.to ? raw.to.toLowerCase() : null,
      value_wei: '0',
      token_contract: null,
      token_symbol: null,
      token_decimals: null,
      token_standard: null,
      token_id: null,
      is_error: raw.isError === '1',
      // The transaction's own status, distinct from this leg's. Stamped only on
      // the gas leg below; NULL everywhere else. See the tx_is_error note in
      // 038 for why the gas leg cannot just use is_error.
      tx_is_error: null,
      // Only the top-level tx has calldata, so at most one leg names its
      // method: the native leg when ETH moved, else the gas leg (stamped in
      // the txlist loop below). Internal traces and token logs stay NULL.
      method_id: null,
      method_name: null,
    });

    // Shared by both NFT feeds. Neither reports isError -- an NFT log only
    // exists if the transfer succeeded. from = 0x0 (mint) and to = 0x0 (burn)
    // are deliberately preserved as-is: they are real, meaningful endpoints,
    // and the activity layer needs them to tell a mint from a purchase.
    const nftRow = (raw, transferType, tokenStandard, valueUnits) => ({
      ...baseRow(raw, transferType),
      // Units, not wei. See 033_nft_transfers.sql.
      value_wei: valueUnits,
      token_contract: (raw.contractAddress || '').toLowerCase() || null,
      // Spam contracts use symbols as ad space; VARCHAR(64) is a hard limit
      // and one oversized symbol would abort the whole insert chunk.
      token_symbol: raw.tokenSymbol ? String(raw.tokenSymbol).slice(0, 64) : null,
      // Whole units. NULL would default to 18 in the shared unit helpers.
      token_decimals: 0,
      token_standard: tokenStandard,
      // uint256, past Number precision -- keep it a string end to end. A
      // malformed id must not reach NUMERIC(78,0) and abort the chunk.
      token_id: raw.tokenID != null && /^\d+$/.test(String(raw.tokenID)) ? String(raw.tokenID) : null,
      is_error: false,
    });

    for (const raw of normal) {
      // Free at ingest: txlist already carries both. functionName is a full
      // signature ("swapExactETHForTokens(uint256,address[],...)") when
      // Etherscan can decode the contract and empty otherwise, which is what
      // leaves work for the decode pass.
      const methodId = MethodSignatureService.normalizeSelector(raw.methodId);
      const methodName = MethodSignatureService.normalizeMethodName(raw.functionName);
      const hasNativeLeg = raw.value !== '0';
      if (hasNativeLeg) {
        rows.push({
          ...baseRow(raw, 'native'),
          value_wei: raw.value,
          method_id: methodId,
          method_name: methodName,
        });
      }
      if ((raw.from || '').toLowerCase() === wallet) {
        const fee = BigInt(raw.gasUsed || 0) * BigInt(raw.gasPrice || 0);
        rows.push({
          ...baseRow(raw, 'gas'),
          value_wei: fee.toString(),
          is_error: false,
          // is_error stays FALSE (the fee did not fail) and consumers depend on
          // that; the transaction's status rides alongside it. A reverted
          // zero-value call emits nothing BUT this leg, so without it the most
          // common revert shape on chain is invisible to the activity layer.
          tx_is_error: raw.isError === '1',
          // Zero-value calls -- every approve, token->token swap, ERC-20
          // transfer -- emit no native leg, and they are the majority of the
          // "contract interaction" population this feature names. The gas leg
          // exists exactly once per tx the wallet SENT, which is exactly when
          // the calldata originated here, so it carries the method instead.
          // Invariant kept: at most one leg per tx has a method. Reverted
          // zero-value calls get NO method: the gas leg keeps is_error false
          // (the fee itself did not fail), so a method stamped here would
          // render a reverted approve as a successful one. A reverted
          // value-bearing call keeps its method on the native leg, which
          // does carry is_error.
          method_id: hasNativeLeg || raw.isError === '1' ? null : methodId,
          method_name: hasNativeLeg || raw.isError === '1' ? null : methodName,
        });
      }
    }

    for (const raw of internal) {
      if (raw.value === '0') continue;
      rows.push({ ...baseRow(raw, 'internal'), value_wei: raw.value });
    }

    for (const raw of token) {
      rows.push({
        ...baseRow(raw, 'token'),
        value_wei: raw.value,
        token_contract: (raw.contractAddress || '').toLowerCase() || null,
        token_symbol: raw.tokenSymbol ? String(raw.tokenSymbol).slice(0, 64) : null,
        token_decimals: raw.tokenDecimal != null ? Number(raw.tokenDecimal) : null,
        // tokentx is ERC-20 only; the NFT standards have their own feeds.
        token_standard: 'erc20',
        is_error: false,
      });
    }

    // An ERC-721 is indivisible and tokennfttx carries no value field, so
    // every row is exactly one unit.
    for (const raw of nft) {
      rows.push(nftRow(raw, 'nft', 'erc721', '1'));
    }

    // tokenValue is how many copies of that id moved. Etherscan already emits
    // one row per id for a batch transfer, so a batch arrives pre-unbundled and
    // each row gets its own ordinal for free.
    for (const raw of nft1155) {
      const units = raw.tokenValue != null && /^\d+$/.test(String(raw.tokenValue)) ? String(raw.tokenValue) : '1';
      rows.push(nftRow(raw, 'nft1155', 'erc1155', units));
    }

    return rows;
  }

  static syncWallet(walletId) {
    return serialized(() => this._syncWallet(walletId));
  }

  // One chain's ingest for one wallet: fetch each feed, replace that feed's
  // resume window, advance that feed's cursor. Everything derived (holdings,
  // the ledger mirror, classification) spans chains and is rebuilt once by the
  // caller after all chains have landed.
  //
  // Failure is isolated per (chain, feed), in three flavours:
  //   * transient (rate limit, timeout, 5xx) -> 'skipped'. Retried next sync,
  //     and it badges the wallet.
  //   * ETHERSCAN_FEED_UNSUPPORTED -> 'unsupported', this feed only.
  //   * ETHERSCAN_CHAIN_UNAVAILABLE -> 'unsupported', and a verdict on the whole
  //     chain, so the remaining feeds are marked without being called.
  // The unsupported kinds are recorded as a gap on eth_wallet_chains so #62
  // knows derived figures there are INCOMPLETE rather than merely stale.
  //
  // All three do the same three things, which is the part that must not be got
  // wrong: contribute no rows, SKIP that feed's delete so its stored rows
  // survive, and leave its cursor untouched. Advancing a cursor past blocks
  // that were never fetched drops those rows silently and forever.
  static async _syncWalletChain(wallet, chain, apiKey) {
    const state = await EthWalletChain.ensure(wallet.id, chain.id);
    // Resume before the stored cursor so a reorg near the tip is healed by the
    // delete-then-reinsert ingest. Per chain: an L2's cursor has nothing to do
    // with mainnet's, and block numbers are independent sequences.
    const resumeFrom = (cursor) => Math.max(0, Number(cursor ?? 0) - REORG_OVERLAP_BLOCKS);
    const resume = {
      normal: resumeFrom(state?.last_block_normal),
      internal: resumeFrom(state?.last_block_internal),
      token: resumeFrom(state?.last_block_token),
      nft: resumeFrom(state?.last_block_nft),
      nft1155: resumeFrom(state?.last_block_1155),
    };

    const feeds = {};
    const fetchedOk = {};
    const skipped = [];
    const unsupported = [];

    // Set by the first feed that reports the CHAIN as unreadable. The remaining
    // feeds are then marked unsupported WITHOUT being called: they would answer
    // identically, and the throttle they would spend is global across every
    // user, so proving the same point five times delays everyone else's sync.
    // They still land in unsupported_feeds, so the gap record stays complete
    // and the whole-chain verdict below can still recognise itself.
    let chainUnreadable = false;

    for (const spec of FEED_SPECS) {
      feeds[spec.key] = [];
      if (chainUnreadable) {
        fetchedOk[spec.key] = false;
        unsupported.push(spec.key);
        continue;
      }
      try {
        feeds[spec.key] = await EtherscanService[spec.fetch](
          wallet.address, resume[spec.key], apiKey, chain.id
        );
        fetchedOk[spec.key] = true;
      } catch (err) {
        fetchedOk[spec.key] = false;
        if (err.code === 'ETHERSCAN_CHAIN_UNAVAILABLE' || err.code === 'ETHERSCAN_FEED_UNSUPPORTED') {
          // Only the whole-chain verdict cascades. A single missing feed says
          // nothing about its neighbours, and assuming otherwise would freeze
          // four healthy cursors and report four gaps that do not exist.
          chainUnreadable = err.code === 'ETHERSCAN_CHAIN_UNAVAILABLE';
          unsupported.push(spec.key);
          logger.warn({ walletId: wallet.id, chainId: chain.id, feed: spec.key, code: err.code, err: err.message },
            'Etherscan cannot serve this feed; cursor frozen and gap recorded');
        } else {
          skipped.push(spec.key);
          logger.warn({ walletId: wallet.id, chainId: chain.id, feed: spec.key, err },
            'Feed fetch failed; feed skipped this sync and its cursor left unchanged');
        }
      }
    }

    const rows = this.normalizeFeeds(wallet.address, feeds)
      .map((row) => ({ ...row, wallet_id: wallet.id, chain_id: chain.id }));

    for (const spec of FEED_SPECS) {
      if (!fetchedOk[spec.key]) continue;
      await EthTransfer.deleteFromBlock(wallet.id, chain.id, spec.types, resume[spec.key]);
    }
    const inserted = await EthTransfer.bulkInsert(rows);

    await EthWalletChain.updateCursors(wallet.id, chain.id, {
      normal: fetchedOk.normal ? maxBlock(feeds.normal) : null,
      internal: fetchedOk.internal ? maxBlock(feeds.internal) : null,
      token: fetchedOk.token ? maxBlock(feeds.token) : null,
      nft: fetchedOk.nft ? maxBlock(feeds.nft) : null,
      nft1155: fetchedOk.nft1155 ? maxBlock(feeds.nft1155) : null,
    });
    // Written every time, empty array included, so a feed that starts working
    // again (a plan upgrade) stops being reported as a gap.
    await EthWalletChain.setUnsupportedFeeds(wallet.id, chain.id, unsupported);

    if (unsupported.length === FEED_SPECS.length) {
      await EthWalletChain.setError(wallet.id, chain.id, 'CHAIN_UNAVAILABLE',
        `${chain.name} is not readable with this Etherscan key. Upgrade the plan or remove ${chain.id} from ETH_CHAINS.`);
    } else if (skipped.length) {
      await EthWalletChain.setError(wallet.id, chain.id, 'FEED_SKIPPED',
        `Partial sync: ${skipped.join(', ')} feed failed; will retry next sync`);
    } else if (unsupported.length) {
      await EthWalletChain.setError(wallet.id, chain.id, 'FEED_UNSUPPORTED',
        `${unsupported.join(', ')} unavailable on ${chain.name}; derived balances there may drift`);
    } else {
      await EthWalletChain.clearError(wallet.id, chain.id);
    }
    await EthWalletChain.updateSyncTime(wallet.id, chain.id);

    return {
      chainId: chain.id,
      chainName: chain.name,
      inserted,
      skippedFeeds: skipped,
      unsupportedFeeds: unsupported,
      unavailable: unsupported.length === FEED_SPECS.length,
      fetched: Object.fromEntries(FEED_SPECS.map((spec) => [spec.key, feeds[spec.key].length])),
    };
  }

  static async _syncWallet(walletId) {
    const wallet = await EthWallet.findById(walletId);
    if (!wallet) throw new Error(`EthWallet ${walletId} not found`);
    // Credentials belong to the wallet's owner (the nightly job has no
    // request context). Missing key -> ETHERSCAN_NOT_CONFIGURED.
    const apiKey = await SecretsService.getUserKey(wallet.user_id, 'etherscan');
    if (!apiKey) {
      const error = new Error('Etherscan is not configured. Add your Etherscan key under Settings -> API Keys.');
      error.code = 'ETHERSCAN_NOT_CONFIGURED';
      throw error;
    }

    try {
      // Only enabled chains are touched. A chain switched off keeps its
      // eth_wallet_chains row, its cursors and every transfer it ever ingested
      // -- disabling stops syncing, it does not delete history, so switching it
      // back on resumes from where it left off instead of refetching years.
      const enabled = chains.enabledChains();
      const perChain = [];
      // Isolation is per CHAIN, not merely per feed. _syncWalletChain already
      // absorbs Etherscan's own failures, but everything else it does can throw
      // too -- a DB blip in bulkInsert, a cursor write timing out -- and an
      // escaping throw would abandon the whole wallet: every chain that DID
      // land would go without reclassification, holdings and mirror rows, so a
      // transient error on the fifth chain would silently roll the wallet's
      // derived state back to the previous sync.
      //
      // A failed chain's cursors are untouched by construction (nothing past
      // the throw runs), so it resumes exactly where it left off next sync.
      for (const chain of enabled) {
        try {
          perChain.push(await this._syncWalletChain(wallet, chain, apiKey));
        } catch (err) {
          logger.error({ walletId, chainId: chain.id, err },
            'Chain sync failed; other chains continue and this chain retries next sync');
          // Same error slot and convention as the feed-level states, so the
          // chain badge reads identically whatever failed.
          try {
            await EthWalletChain.ensure(wallet.id, chain.id);
            await EthWalletChain.setError(wallet.id, chain.id, err.code || 'SYNC_ERROR', err.message);
          } catch (recordErr) {
            logger.error({ walletId, chainId: chain.id, err: recordErr },
              'Could not record the chain sync error');
          }
          perChain.push({
            chainId: chain.id,
            chainName: chain.name,
            inserted: 0,
            skippedFeeds: [],
            unsupportedFeeds: [],
            unavailable: false,
            error: err.message,
            errorCode: err.code || 'SYNC_ERROR',
            fetched: Object.fromEntries(FEED_SPECS.map((spec) => [spec.key, 0])),
          });
        }
      }

      const failedChains = perChain.filter((result) => result.error);
      // A wallet where NOTHING landed fails exactly as it did before per-chain
      // isolation: nothing was ingested, so there is nothing to rebuild derived
      // data from, and the caller (and the nightly job's failure count) must
      // still see a thrown error rather than a clean-looking empty sync.
      if (failedChains.length === perChain.length && perChain.length > 0) {
        const [first] = failedChains;
        const error = new Error(first.error);
        error.code = first.errorCode;
        throw error;
      }

      // Naming the selectors Etherscan could not decode. Sync-time only: the
      // transfers route must never wait on Sourcify or 4byte. Non-fatal by
      // design -- method_name is a cosmetic hint, so a signature service being
      // down must not fail a sync that already has every balance and transfer.
      // Chain-agnostic: a 4-byte selector means the same thing everywhere, and
      // eth_method_signatures is global, so one pass covers every chain.
      let methods = null;
      try {
        methods = await MethodSignatureService.decodePendingForWallet(walletId);
      } catch (err) {
        logger.warn({ walletId, err }, 'Method signature decode failed; selectors stay unnamed');
      }

      // Derived data is rebuilt ONCE for the whole wallet, after every chain has
      // landed. Counterparty labels are address-keyed with no chain dimension,
      // and holdings/mirror rows span chains, so doing this per chain would
      // rebuild the same rows N times and briefly publish a wallet whose
      // holdings reflect only the chains synced so far.
      await EthTransfer.reclassifyCounterparties(wallet.user_id);
      const holdings = await this.refreshHoldings(walletId);
      const mirror = await EthTransactionMirrorService.rebuildForWallet(walletId);
      // After reclassify: the ladder reads counterparty_is_own and
      // counterparty_exchange off the freshly-classified legs.
      const activity = await EthActivityService.rebuildForWallet(walletId);
      await TransactionClassificationService.backfill();

      // The balance audit (#62): does the ledger we just stored reproduce the
      // balance the chain reports? Runs last, and non-fatally, because it is a
      // VERDICT ON the sync rather than a step of it -- everything above has
      // already landed, and an audit that could fail a completed sync would
      // trade a real balance for an opinion about it. It reuses the live ETH
      // figures refreshHoldings already fetched, so ETH costs no extra request.
      let reconciliation = null;
      try {
        reconciliation = await EthReconciliationService.reconcileWallet(wallet, {
          liveWeiByChain: holdings?.liveWeiByChain || {},
          chainResults: perChain,
          apiKey,
        });
      } catch (err) {
        logger.warn({ walletId, err }, 'Balance reconciliation failed; the sync itself is unaffected');
      }

      // Feed labels carry their chain: "nft failed" is not actionable when five
      // chains ran, and the same feed can be healthy on one chain and skipped
      // on another.
      const skippedFeeds = perChain.flatMap((result) =>
        result.skippedFeeds.map((feed) => `${result.chainName}/${feed}`));
      const unsupportedFeeds = perChain.flatMap((result) =>
        result.unsupportedFeeds.map((feed) => `${result.chainName}/${feed}`));

      // A partial sync must not report clean: the error slot doubles as the
      // degraded-feed badge until a sync fetches every feed.
      //
      // Only TRANSIENT skips reach the wallet badge. An unsupported feed is a
      // standing property of the chain and the key, so badging it would pin the
      // wallet's attention count above zero permanently -- and a badge that
      // cannot reach zero gets ignored, which would cost us the real sync
      // errors too. Those gaps live on the chain row, which the wallets API
      // returns, and are what #62 reconciles against.
      //
      // A chain that threw outright badges the wallet for the same reason a
      // skipped feed does: it is transient by assumption and it retries, so the
      // badge can still reach zero.
      const partial = [
        ...skippedFeeds.map((feed) => `${feed} feed`),
        ...failedChains.map((result) => `${result.chainName} chain`),
      ];
      if (partial.length === 0) {
        await EthWallet.clearError(walletId);
      } else {
        await EthWallet.setError(walletId, failedChains.length ? 'CHAIN_SYNC_FAILED' : 'FEED_SKIPPED',
          `Partial sync: ${partial.join(', ')} failed; will retry next sync`);
      }
      await EthWallet.updateSyncTime(walletId);

      const results = {
        inserted: perChain.reduce((sum, result) => sum + result.inserted, 0),
        holdings,
        mirror,
        activity,
        reconciliation,
        methods,
        skippedFeeds,
        unsupportedFeeds,
        chains: perChain,
        // Cross-chain totals, so the shape callers already read still means
        // "how much did this sync bring in".
        fetched: FEED_SPECS.reduce((totals, spec) => {
          totals[spec.key] = perChain.reduce((sum, result) => sum + result.fetched[spec.key], 0);
          return totals;
        }, {}),
      };
      logger.info({ walletId, address: wallet.address, results }, 'ETH wallet sync completed');
      return results;
    } catch (err) {
      await EthWallet.setError(walletId, err.code || 'SYNC_ERROR', err.message);
      throw err;
    }
  }

  static async syncAllWallets() {
    const wallets = await EthWallet.findAllForJobs();
    const summary = { processed: 0, succeeded: 0, failed: 0, results: [] };

    for (const wallet of wallets) {
      summary.processed++;
      try {
        const result = await this.syncWallet(wallet.id);
        summary.succeeded++;
        summary.results.push({ walletId: wallet.id, address: wallet.address, ...result });
      } catch (err) {
        if (err.code === 'ETHERSCAN_NOT_CONFIGURED') {
          summary.skipped = (summary.skipped || 0) + 1;
          summary.results.push({ walletId: wallet.id, address: wallet.address, skipped: 'not_configured' });
          logger.warn({ walletId: wallet.id, userId: wallet.user_id }, 'Skipping ETH wallet: owner has no Etherscan key');
          continue;
        }
        summary.failed++;
        summary.results.push({ walletId: wallet.id, address: wallet.address, error: err.message });
        logger.error({ walletId: wallet.id, err }, 'Failed to sync ETH wallet');
      }
    }

    return summary;
  }

  static async addWallet(userId, address, label) {
    if (typeof address !== 'string' || !ADDRESS_RE.test(address.trim())) {
      const error = new Error('address must be a 0x-prefixed 40-hex-character Ethereum address');
      error.code = 'INVALID_ADDRESS';
      throw error;
    }
    // Fail fast: without an API key the wallet could be created but never
    // synced, which would just strand an empty account.
    const apiKey = await SecretsService.getUserKey(userId, 'etherscan');
    if (!apiKey) {
      const error = new Error('Etherscan is not configured. Add your Etherscan key under Settings -> API Keys.');
      error.code = 'ETHERSCAN_NOT_CONFIGURED';
      throw error;
    }
    const normalized = address.trim().toLowerCase();

    const existing = await EthWallet.findByAddress(normalized, userId);
    if (existing) {
      const error = new Error('That address is already tracked');
      error.code = 'DUPLICATE_WALLET';
      throw error;
    }

    // Wallet and account are created atomically: a wallet without its account
    // would make every holdings/mirror refresh silently skip it. The account's
    // stable name is derived from the address (unique by construction); the
    // user-facing label rides on display_name like every other renamed account.
    const client = await pool.connect();
    const accountName = `Ethereum ${shortAddress(normalized)}`;
    const trimmedLabel = label?.trim() || null;
    let wallet;
    let account;
    try {
      await client.query('BEGIN');
      const walletResult = await client.query(
        'INSERT INTO eth_wallets (address, label, user_id) VALUES ($1, $2, $3) RETURNING *',
        [normalized, trimmedLabel, userId]
      );
      wallet = walletResult.rows[0];

      // Disconnecting a wallet with removeData=false detaches its account
      // (eth_wallet_id -> NULL) but keeps the row, name included. Re-adding the
      // same address must re-attach that account rather than insert a second
      // one: the name is unique per user, so inserting would violate
      // accounts_user_id_name_key, and re-attaching is what "keep data" was for
      // -- the account's snapshots, history, and display_name all survive.
      // Matching on name is exactly as precise as the constraint being avoided.
      const reattached = await client.query(
        `UPDATE accounts
            SET eth_wallet_id = $1,
                display_name = COALESCE($2, display_name),
                type = 'crypto',
                -- Un-hide deliberately. Hiding the leftover account is the
                -- natural response to a disconnect, and adopting it while
                -- hidden would exclude the wallet from net worth, holdings,
                -- history and exports -- every consumer filters
                -- is_hidden = FALSE -- with no error anywhere. Re-adding an
                -- address is an explicit "track this again"; a reappearing row
                -- is trivially re-hidden, a silently missing balance is not.
                is_hidden = FALSE
          WHERE user_id = $3 AND name = $4 AND eth_wallet_id IS NULL
          RETURNING *`,
        [wallet.id, trimmedLabel, userId, accountName]
      );
      if (reattached.rows.length) {
        account = reattached.rows[0];
      } else {
        const accountResult = await client.query(
          `INSERT INTO accounts (name, type, display_name, eth_wallet_id, user_id)
           VALUES ($1, 'crypto', $2, $3, $4)
           RETURNING *`,
          [accountName, trimmedLabel, wallet.id, userId]
        );
        account = accountResult.rows[0];
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      // Branch on the constraint, not just the code: the transaction's FIRST
      // statement inserts into eth_wallets, and the duplicate-address
      // pre-check above runs outside the transaction, so a double-submit or an
      // interceptor retry can race it. Reporting that as a name conflict would
      // send the user chasing an account rename for what is really "you
      // already track this address".
      if (err.code === '23505' && err.constraint === 'eth_wallets_user_id_address_key') {
        const duplicate = new Error('That address is already tracked');
        duplicate.code = 'DUPLICATE_WALLET';
        throw duplicate;
      }
      if (err.code === '23505') {
        // A live account already holds this name -- two distinct addresses
        // sharing a 6-and-4 abbreviation. Vanishingly rare, and there is no
        // API that renames an account, so the message must not tell the user
        // to go rename one; only display_name is editable.
        const conflict = new Error(`Another account is already named "${accountName}", so this address can't be added automatically.`);
        conflict.code = 'ACCOUNT_NAME_CONFLICT';
        throw conflict;
      }
      throw err;
    } finally {
      client.release();
    }

    // A new own-address can turn previously-external transfers into
    // self-transfers on other wallets, so their mirrored ledger rows must be
    // rebuilt too. Non-fatal: the wallet exists either way, and the first
    // sync re-derives all of this.
    try {
      await this.refreshClassificationsForUser(userId);
    } catch (err) {
      logger.warn({ walletId: wallet.id, err }, 'Derived-data refresh after wallet add failed');
    }

    logger.info({ walletId: wallet.id, address: normalized }, 'ETH wallet added');
    return { wallet, account };
  }

  // Rebuilds the wallet account's holdings: one ETH position PER CHAIN, priced
  // later by the regular price job (they all carry ticker ETH, so they all read
  // the single shared price_cache 'ETH' row), plus one row per non-ignored
  // token per chain. Token symbols never become tickers -- a scam token named
  // "AAPL" must not inherit Apple's stock price -- so tokens are NULL-ticker
  // holdings valued via manual_value at sync time.
  //
  // Rows are matched by NAME rather than by ticker. Post-#58 one account holds
  // several ticker='ETH' rows, so the old ticker matcher would return them all
  // and every chain would fight over whichever row came back first, overwriting
  // the previous chain's balance. Names are unique per account by construction:
  // 'Ethereum', 'ETH (Arbitrum)', 'USDC 0x1234…5678', 'USDC 0x1234…5678 (Base)'.
  static async refreshHoldings(walletId) {
    const wallet = await EthWallet.findById(walletId);
    if (!wallet) throw new Error(`EthWallet ${walletId} not found`);
    const account = await EthWallet.getAccountForWallet(walletId);
    if (!account) return { skipped: true };

    const apiKey = await SecretsService.getUserKey(wallet.user_id, 'etherscan');
    if (!apiKey) {
      const error = new Error('Etherscan is not configured. Add your Etherscan key under Settings -> API Keys.');
      error.code = 'ETHERSCAN_NOT_CONFIGURED';
      throw error;
    }

    const existingResult = await pool.query(
      'SELECT id, name FROM holdings WHERE account_id = $1',
      [account.id]
    );
    const existingByName = new Map(existingResult.rows.map((row) => [row.name, row.id]));

    const chainStates = await EthWalletChain.findForWallet(walletId);
    // A chain the key provably cannot read: skip the balance call rather than
    // spend a throttle slot learning the same thing nightly. Self-healing --
    // the sync still probes its feeds every run, so the moment the plan is
    // upgraded the error clears and this resumes.
    const unreadable = new Set(
      chainStates
        .filter((state) => state.error_code === 'CHAIN_UNAVAILABLE')
        .map((state) => Number(state.chain_id))
    );

    const desired = [];
    // Only chains actually re-derived this run may have their stale rows
    // reaped. This is what makes "disabling a chain leaves its stored rows
    // untouched" true, and it also protects a chain whose balance call failed
    // transiently from having last night's positions deleted.
    const refreshedChainIds = [];
    // Raw wei per chain, kept for the balance audit (#62). Passing this on is
    // what makes reconciliation cost ZERO extra Etherscan requests for ETH: a
    // second action=balance per chain would double the audit's price against a
    // globally throttled key to re-read a number this function already has.
    // Unscaled on purpose -- `desired` carries an 8-decimal clamped string, and
    // comparing that against the chain would invent drift below 1e-8 ETH.
    //
    // A chain gets an entry ONLY when its balance call actually came back: both
    // paths below (`unreadable`, and a failed fetch) `continue` without writing
    // one. The audit reads that absence as "this key could not reach this chain
    // this run" and spends no token lookups there, so an unreachable chain
    // cannot burn the whole per-wallet budget on calls destined to fail.
    const liveWeiByChain = {};

    for (const chain of chains.enabledChains()) {
      if (unreadable.has(chain.id)) {
        logger.warn({ walletId, chainId: chain.id }, 'Skipping balance: chain unreadable with this key');
        continue;
      }
      let wei;
      try {
        wei = await EtherscanService.getEthBalance(wallet.address, apiKey, chain.id);
      } catch (err) {
        // Mainnet keeps its pre-#58 fail-loud behavior: an unreadable mainnet
        // balance means the whole sync is untrustworthy. An L2 failing must not
        // take the wallet down with it, and must not delete the position it
        // wrote last night either.
        if (chain.id === chains.DEFAULT_CHAIN_ID) throw err;
        logger.warn({ walletId, chainId: chain.id, err },
          'ETH balance fetch failed; that chain keeps its previous holdings');
        continue;
      }
      refreshedChainIds.push(chain.id);
      liveWeiByChain[chain.id] = wei;
      const name = chains.ethHoldingName(chain.id);
      // Mainnet always keeps its ETH row, at zero if need be, so a mainnet-only
      // wallet looks exactly as it did before #58. An L2 earns a row once it
      // holds ETH or already has one -- otherwise enabling four chains would
      // decorate every existing wallet with four permanent 0.00000000 rows.
      if (chain.id === chains.DEFAULT_CHAIN_ID || BigInt(wei) > 0n || existingByName.has(name)) {
        desired.push({
          chain_id: chain.id,
          ticker: 'ETH',
          name,
          quantity: unitsToDecimalString(wei, 18),
          manual_value: null,
        });
      }
    }

    const refreshable = new Set(refreshedChainIds);
    const deltas = await EthTransfer.tokenBalanceDeltas(walletId);
    const held = deltas.filter((d) => BigInt(d.balance_units) > 0n && refreshable.has(Number(d.chain_id)));

    // Prices are fetched per chain: CoinGecko's token_price endpoint is keyed by
    // asset PLATFORM, and an Arbitrum contract queried against the ethereum
    // platform simply returns nothing -- which reads as "unpriced" rather than
    // as a mistake, so it would silently zero every L2 token's value.
    const prices = new Map();
    const byChain = new Map();
    for (const delta of held) {
      const chainId = Number(delta.chain_id);
      if (!byChain.has(chainId)) byChain.set(chainId, []);
      byChain.get(chainId).push(delta);
    }
    for (const [chainId, chainDeltas] of byChain) {
      const platform = chains.getChain(chainId)?.coingeckoPlatform;
      if (!platform) continue;
      try {
        const contracts = chainDeltas.map((d) => d.token_contract).join(',');
        const json = await PriceService.fetchCoinGeckoJson(
          `https://api.coingecko.com/api/v3/simple/token_price/${platform}?contract_addresses=${encodeURIComponent(contracts)}&vs_currencies=usd`
        );
        for (const [contract, value] of Object.entries(json || {})) {
          prices.set(`${chainId}:${contract.toLowerCase()}`, value);
        }
      } catch (err) {
        logger.warn({ walletId, chainId, err }, 'Token price lookup failed; token holdings stay unvalued');
      }
    }

    for (const delta of held) {
      const chainId = Number(delta.chain_id);
      const decimals = delta.token_decimals != null ? Number(delta.token_decimals) : 18;
      const quantity = unitsToDecimalString(delta.balance_units, decimals);
      const usd = Number(prices.get(`${chainId}:${delta.token_contract}`)?.usd);
      // Clamped like the mirror's toAmount: manual_value is DECIMAL(15,2) and
      // one absurd scam-token valuation must not abort the whole sync.
      const manualValue = Number.isFinite(usd)
        ? Math.min(Math.round(usd * Number(quantity) * 100) / 100, 9999999999999.99)
        : null;
      desired.push({
        chain_id: chainId,
        ticker: null,
        // Same contract address can exist on several chains as different
        // assets, so the chain has to be in the name -- it is the match key.
        name: `${delta.token_symbol || 'TOKEN'} ${shortAddress(delta.token_contract)}${chains.holdingSuffix(chainId)}`,
        quantity,
        manual_value: manualValue,
      });
    }

    for (const holding of desired) {
      const existingId = existingByName.get(holding.name);
      if (existingId) {
        await pool.query(
          `UPDATE holdings SET ticker = $1, quantity = $2, manual_value = $3, chain_id = $4,
                               updated_at = CURRENT_TIMESTAMP
           WHERE id = $5`,
          [holding.ticker, holding.quantity, holding.manual_value, holding.chain_id, existingId]
        );
      } else {
        await pool.query(
          `INSERT INTO holdings (account_id, ticker, name, quantity, manual_value, chain_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [account.id, holding.ticker, holding.name, holding.quantity, holding.manual_value, holding.chain_id]
        );
      }
    }

    // The account exists solely for this wallet, so anything this run did not
    // produce (sold-out positions, newly-ignored tokens) is stale -- but only
    // on the chains this run actually re-derived. COALESCE(chain_id, 1) covers
    // rows written before 039 added the column, which are all mainnet's.
    await pool.query(
      `DELETE FROM holdings
       WHERE account_id = $1
         AND COALESCE(chain_id, $2) = ANY($3::int[])
         AND name <> ALL($4::text[])`,
      [account.id, chains.DEFAULT_CHAIN_ID, refreshedChainIds, desired.map((h) => h.name)]
    );

    return {
      eth: desired.find((h) => h.chain_id === chains.DEFAULT_CHAIN_ID && h.ticker === 'ETH')?.quantity ?? null,
      ethByChain: Object.fromEntries(
        desired.filter((h) => h.ticker === 'ETH').map((h) => [h.chain_id, h.quantity])
      ),
      liveWeiByChain,
      tokens: held.length,
      chains: refreshedChainIds,
    };
  }

  static async removeWallet(walletId, { removeData = false } = {}) {
    const wallet = await EthWallet.findById(walletId);
    if (!wallet) throw new Error(`EthWallet ${walletId} not found`);

    await EthWallet.delete(walletId, { removeData });

    // Non-fatal: the wallet is already gone; a failure here must not report
    // the disconnect itself as failed.
    try {
      await this.refreshClassificationsForUser(wallet.user_id);
    } catch (err) {
      logger.warn({ walletId, err }, 'Derived-data refresh after wallet removal failed');
    }
    logger.info({ walletId, removeData }, 'ETH wallet disconnected');
  }

  // Classification changes (wallet add/remove, address-label change) flip
  // self/exchange/external on existing rows and their mirrored ledger rows.
  // Unlike refreshDerivedForUser this never touches Etherscan or holdings --
  // labels affect classification only.
  //
  // Scoped to the owner: wallets and labels only ever classify against their
  // own user's addresses, so rebuilding every user's rows was wasted work on an
  // edit they never made. The final backfill stays global -- it is an
  // account-keyed derivation over transactions, not an eth-wallet read.
  static refreshClassificationsForUser(userId) {
    return serialized(async () => {
      await EthTransfer.reclassifyCounterparties(userId);
      const wallets = await EthWallet.findAllByUser(userId);
      for (const wallet of wallets) {
        // Two independent derivations, so two independent catches: sharing one
        // made an activity failure log as "Mirror rebuild failed", and a mirror
        // failure skip the activity rebuild entirely.
        try {
          await EthTransactionMirrorService.rebuildForWallet(wallet.id);
        } catch (err) {
          logger.warn({ walletId: wallet.id, err }, 'Mirror rebuild failed during classification refresh');
        }
        try {
          // A label change flips self/exchange/external, which is what half the
          // classification ladder reads -- so the activity rows heal
          // retroactively, exactly like the mirror. Overrides live in their own
          // table and are untouched by the rebuild.
          await EthActivityService.rebuildForWallet(wallet.id, { rebuildMatches: false });
        } catch (err) {
          logger.warn({ walletId: wallet.id, err }, 'Activity rebuild failed during classification refresh');
        }
      }
      // Once, after every wallet has landed. The match pass is user-wide, so
      // running it inside the loop re-derived the same rows N times -- and the
      // early passes ran against a half-rebuilt feed.
      await ExchangeMatchService.rebuildForUserSafely(userId, { reason: 'classification-refresh' });
      await TransactionClassificationService.backfill();
    });
  }

  // Ignore lists are per-user, so this re-derives only the owner's wallets.
  // Fanning out over every wallet would spend other owners' Etherscan and
  // CoinGecko quota (refreshHoldings resolves the wallet owner's key) and
  // rewrite their holdings rows on an edit they never made.
  static refreshDerivedForUser(userId) {
    return serialized(async () => {
      const wallets = await EthWallet.findAllByUser(userId);
      for (const wallet of wallets) {
        // Three independent derivations of the same source rows: holdings need
        // a price lookup, the mirror and the activity rows do not. One catch
        // around all three let a price outage skip both rebuilds and report
        // every failure under the same message.
        try {
          await this.refreshHoldings(wallet.id);
        } catch (err) {
          logger.warn({ walletId: wallet.id, err }, 'Holdings refresh failed during derived-data refresh');
        }
        try {
          await EthTransactionMirrorService.rebuildForWallet(wallet.id);
        } catch (err) {
          logger.warn({ walletId: wallet.id, err }, 'Mirror rebuild failed during derived-data refresh');
        }
        try {
          // The ignore list filters legs out of the activity builder too, so a
          // newly-ignored spam token has to stop driving a classification.
          await EthActivityService.rebuildForWallet(wallet.id, { rebuildMatches: false });
        } catch (err) {
          logger.warn({ walletId: wallet.id, err }, 'Activity rebuild failed during derived-data refresh');
        }
      }
      // Once for the user, not once per wallet -- same reason as above.
      await ExchangeMatchService.rebuildForUserSafely(userId, { reason: 'derived-refresh' });
      await TransactionClassificationService.backfill();
    });
  }
}

module.exports = EthWalletService;
module.exports.REORG_OVERLAP_BLOCKS = REORG_OVERLAP_BLOCKS;
