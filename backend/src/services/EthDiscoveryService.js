'use strict';

const EthDiscoveryCandidate = require('../models/EthDiscoveryCandidate');
const EthAddressLabel = require('../models/EthAddressLabel');
const EthWalletService = require('./EthWalletService');
const logger = require('../config/logger');

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

class EthDiscoveryService {
  static async run(userId) {
    const candidates = await EthDiscoveryCandidate.seed(userId);
    return {
      candidates_found: candidates.length,
      pending: candidates.filter((candidate) => candidate.status === 'pending').length,
    };
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
