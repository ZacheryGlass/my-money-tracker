'use strict';

const EthDiscoveryCandidate = require('../models/EthDiscoveryCandidate');
const EthAddressLabel = require('../models/EthAddressLabel');
const EthWalletService = require('./EthWalletService');
const EtherscanService = require('./EtherscanService');
const SecretsService = require('./SecretsService');
const chains = require('../config/chains');
const logger = require('../config/logger');

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const HIGH_TRAFFIC_MULTIPLIER = 10;

function positiveUnits(value) {
  try {
    return BigInt(String(value ?? '0')) > 0n;
  } catch {
    return false;
  }
}

class EthDiscoveryService {
  static async run(userId) {
    const candidates = await EthDiscoveryCandidate.seed(userId);
    const expansion = await this.expand(userId);
    return {
      candidates_found: candidates.length,
      pending: candidates.filter((candidate) => candidate.status === 'pending').length,
      expansion,
    };
  }

  // Bounded, on-demand frontier expansion. It never runs from a nightly job:
  // the user explicitly pressed Run Checks, and the receipt says exactly how
  // much provider work happened. Contracts and high-traffic candidates are
  // killed before they can turn a service address into a personal wallet.
  static async expand(userId, { maxCalls = 25, maxDepth = 3, maxRows = 200 } = {}) {
    const frontier = await EthDiscoveryCandidate.pendingFrontier(userId, maxCalls);
    const apiKey = await SecretsService.getUserKey(userId, 'etherscan');
    let calls = 0;
    let rows = 0;
    let completed = 0;
    let truncated = false;
    for (const candidate of frontier) {
      if (calls >= maxCalls) { truncated = true; break; }
      const chainId = Number(candidate.chain_id) || chains.DEFAULT_CHAIN_ID;
      const depth = Math.max(0, (candidate.evidence || []).reduce((max, item) => {
        const hop = Number(item.hop_depth);
        return Number.isFinite(hop) ? Math.max(max, hop) : max;
      }, 0));
      if (depth >= maxDepth) {
        await EthDiscoveryCandidate.recordFetch(userId, {
          address: candidate.address, chainId, depth, status: 'truncated', rowsFetched: 0,
        });
        truncated = true;
        continue;
      }
      try {
        if (chains.getChain(chainId)?.rpcUrl) {
          calls += 1;
          const code = await EtherscanService._rpcRequest(chainId, 'eth_getCode', [candidate.address, 'latest']);
          if (code && code !== '0x' && code !== '0x0') {
            await EthDiscoveryCandidate.recordFetch(userId, {
              address: candidate.address, chainId, depth, status: 'contract', rowsFetched: 0,
            });
            continue;
          }
        }
        if (calls >= maxCalls) {
          truncated = true;
          await EthDiscoveryCandidate.recordFetch(userId, {
            address: candidate.address, chainId, depth, status: 'truncated', rowsFetched: 0,
          });
          continue;
        }
        const txs = await EtherscanService.fetchNormalTxs(candidate.address, 0, apiKey, chainId);
        calls += 1;
        let tokenTxs = [];
        if (calls < maxCalls) {
          tokenTxs = await EtherscanService.fetchTokenTxs(candidate.address, 0, apiKey, chainId);
          calls += 1;
        } else {
          truncated = true;
        }
        const allTxs = [...txs, ...tokenTxs];
        rows += allTxs.length;
        if (allTxs.length > maxRows * HIGH_TRAFFIC_MULTIPLIER) {
          await EthDiscoveryCandidate.recordFetch(userId, {
            address: candidate.address, chainId, depth, status: 'high_traffic', rowsFetched: allTxs.length,
            errorMessage: `Provider returned more than ${maxRows * HIGH_TRAFFIC_MULTIPLIER} rows; review manually or import an export`,
          });
          continue;
        }
        const evidence = Array.isArray(candidate.evidence) ? candidate.evidence : [];
        const inboundTime = evidence.reduce((latest, item) => {
          const value = item?.inbound?.block_time || item?.block_time;
          const time = value ? new Date(value).getTime() : 0;
          return Math.max(latest, Number.isFinite(time) ? time : 0);
        }, 0);
        const outbound = allTxs.filter((tx) => String(tx.from || '').toLowerCase() === candidate.address.toLowerCase()
          && tx.to && Number(tx.isError || 0) === 0
          && positiveUnits(tx.value)
          && (!inboundTime || Number(tx.timeStamp || 0) * 1000 > inboundTime));
        if (!outbound.length && allTxs.length > 0) {
          await EthDiscoveryCandidate.recordFetch(userId, {
            address: candidate.address, chainId, depth, status: 'dust', rowsFetched: allTxs.length,
          });
          continue;
        }
        const limited = outbound.slice(0, maxRows);
        for (const tx of limited) {
          const hop = {
            type: 'expansion_hop', hop_depth: depth + 1, tx_hash: tx.hash,
            block_time: tx.timeStamp ? new Date(Number(tx.timeStamp) * 1000).toISOString() : null,
            from_address: tx.from, to_address: tx.to, amount: tx.value,
            token_contract: tx.contractAddress || tx.token_contract || null,
            token_symbol: tx.tokenSymbol || tx.token_symbol || null,
          };
          const known = await EthDiscoveryCandidate.findKnownAddress(userId, tx.to);
          if (known) { completed += 1; continue; }
          await EthDiscoveryCandidate.upsertPath(userId, {
            address: tx.to, chainId,
            score: Math.max(0.5, Number(candidate.score || 0.5) - 0.05),
            evidence: [...evidence, hop],
          });
        }
        await EthDiscoveryCandidate.recordFetch(userId, {
          address: candidate.address, chainId, depth,
          status: outbound.length > limited.length ? 'truncated' : 'complete',
          rowsFetched: allTxs.length,
        });
        if (outbound.length > limited.length) truncated = true;
      } catch (error) {
        await EthDiscoveryCandidate.recordFetch(userId, {
          address: candidate.address, chainId, depth, status: 'failed',
          rowsFetched: 0, errorMessage: error.message,
        });
      }
    }
    return { calls, rows, completed, truncated, frontier: frontier.length };
  }

  static async decide(userId, candidate, decision, label) {
    if (!candidate || !ADDRESS_RE.test(candidate.address)) {
      const error = new Error('Discovery candidate address is invalid');
      error.code = 'INVALID_ADDRESS';
      throw error;
    }
    if (!['track', 'own', 'external'].includes(decision)) {
      const error = new Error('decision must be track, own, or external');
      error.code = 'INVALID_DISCOVERY_DECISION';
      throw error;
    }

    let wallet = null;
    if (decision === 'track') {
      try {
        const added = await EthWalletService.addWallet(userId, candidate.address, label || null);
        wallet = added.wallet;
        // addWallet starts its first sync in the route; the discovery action is
        // deliberately just as safe when called from an API client, so start it
        // here too and leave errors on the wallet's durable status.
        EthWalletService.syncWallet(wallet.id).catch((err) => {
          logger.error({ walletId: wallet.id, err }, 'Discovery wallet sync failed');
        });
      } catch (error) {
        // A race or a previous manual add means the candidate is already owned;
        // do not turn a successful ownership decision into a failed action.
        if (error.code !== 'DUPLICATE_WALLET') throw error;
      }
    } else {
      await EthAddressLabel.upsert(
        userId,
        candidate.address,
        label || (decision === 'own' ? 'Own address (untracked)' : 'Dismissed discovery candidate'),
        candidate.evidence?.length ? 'Discovery evidence reviewed by user' : null,
        decision === 'own' ? 'own' : 'external'
      );
    }

    const status = await EthDiscoveryCandidate.decide(
      userId,
      candidate.id,
      decision === 'external' ? 'dismissed' : 'confirmed_own'
    );
    return { candidate: status, wallet };
  }
}

module.exports = EthDiscoveryService;
