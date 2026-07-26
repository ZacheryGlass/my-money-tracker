'use strict';

const axios = require('axios');
const EthMethodSignature = require('../models/EthMethodSignature');
const EthTransfer = require('../models/EthTransfer');
const logger = require('../config/logger');

// Sourcify's signature database, which absorbed openchain.xyz (and the 4byte
// signature API samczsun ran there) -- same request and response shape, new
// host. Its rows come from Sourcify's verified contracts, so unlike
// 4byte.directory it can say whether a candidate signature actually appears in
// a contract somebody compiled.
const SOURCIFY_URL = 'https://api.4byte.sourcify.dev/signature-database/v1/lookup';
// The long-standing community database. Broader, but anyone can submit, so it
// carries every mined collision alongside the real signatures.
const FOURBYTE_URL = 'https://www.4byte.directory/api/v1/signatures/';

// Observed latency is sub-200ms for both services; 4s is already generous.
// The decode pass runs inside the serialized sync queue, so its worst case
// is user-visible -- see DECODE_DEADLINE_MS below.
const REQUEST_TIMEOUT_MS = 4000;
// Wall-clock budget for one decode pass. The design is already "defer to the
// next sync"; a slow provider must not hold the derived-data lock (and an
// awaited sync request) for minutes.
const DECODE_DEADLINE_MS = 30000;
// Both services are free public goods with no key and no published quota.
// Lookups are serialized and spaced rather than fired in parallel.
const REQUEST_SPACING_MS = 200;
// A first sync of an old, busy wallet can surface a long tail of unnamed
// selectors, and at ~0.5 s each that would stretch the sync out for minutes.
// Capping is safe precisely because the pending set is re-derived from STORED
// rows on every sync: what does not fit this run is picked up by the next one,
// which is the "decode progressively" half of the design.
const MAX_LOOKUPS_PER_SYNC = 50;

// eth_transfers.method_name is VARCHAR(200). Etherscan's functionName is a full
// signature with parameter names, so a handful genuinely exceed that; the front
// of the string is the part the UI shows, so truncating beats dropping.
const MAX_NAME_LENGTH = 200;

const SELECTOR_RE = /^0x[0-9a-f]{8}$/;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Etherscan uses several different spellings of "there is no method here":
// absent, empty, a bare '0x' (a plain ETH transfer has no calldata), and the
// literal 'deprecated' on rows it no longer decodes. All of them mean NULL --
// storing them would make an empty selector look like a real one.
function normalizeSelector(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return SELECTOR_RE.test(value) ? value : null;
}

function normalizeMethodName(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value === '0x' || value.toLowerCase() === 'deprecated') return null;
  return value.slice(0, MAX_NAME_LENGTH);
}

class MethodSignatureService {
  // Resolved names are LOW-CONFIDENCE DISPLAY HINTS. Selector collisions are
  // cheap to mine, so nothing here may feed classification -- these two helpers
  // and the decode pass below only ever write method_id/method_name, which no
  // classifier reads.
  static normalizeSelector(raw) {
    return normalizeSelector(raw);
  }

  static normalizeMethodName(raw) {
    return normalizeMethodName(raw);
  }

  // Returns the signature text, or null when the service answered and knew
  // nothing. Throws only on transport failure, which the caller treats very
  // differently from a miss.
  static async lookupSourcify(selector) {
    const response = await axios.get(SOURCIFY_URL, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: { accept: 'application/json' },
      params: { function: selector },
    });
    // A 200 that is not the documented envelope (CDN interstitial, HTML error
    // page, future shape change) must count as a FAILURE, not a miss -- misses
    // cache permanently. The envelope carries an explicit ok flag; demand it.
    if (response.data?.ok !== true) {
      throw new Error('Sourcify signature lookup returned an unexpected envelope');
    }
    // openchain-compatible shape: functions come back null when unknown, and
    // the key is echoed exactly as sent (we always send lowercase).
    const candidates = response.data?.result?.function?.[selector];
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    // 0x7ff36ab5 returns both swapExactETHForTokens and a mined spam signature.
    // hasVerifiedContract is the tiebreak Sourcify exists to provide: prefer a
    // candidate that appears in a contract somebody actually verified.
    const best = candidates.find((c) => c && c.hasVerifiedContract && !c.filtered)
      || candidates.find((c) => c && !c.filtered)
      || candidates[0];
    return normalizeMethodName(best && best.name);
  }

  static async lookupFourByte(selector) {
    const response = await axios.get(FOURBYTE_URL, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: { accept: 'application/json' },
      params: { hex_signature: selector },
    });
    // Same contract as Sourcify above: an off-shape 200 is a failure, not a
    // permanent miss. A real miss is the documented {count: 0, results: []}.
    if (!response.data || typeof response.data !== 'object' || !Array.isArray(response.data.results)) {
      throw new Error('4byte signature lookup returned an unexpected envelope');
    }
    const results = response.data.results.filter((r) => r && Number.isFinite(Number(r.id)));
    if (results.length === 0) return null;
    // No verified-contract signal here, so submission order is the tiebreak:
    // a collision is mined to match an ALREADY popular selector, so it is
    // always submitted after the signature it impersonates. Lowest id wins.
    const best = results.reduce((a, b) => (Number(b.id) < Number(a.id) ? b : a));
    return normalizeMethodName(best.text_signature);
  }

  // Sourcify first, 4byte second. Returns { name, source } to cache, or null
  // when the answer is unknowable right now.
  //
  // A miss is only cached when BOTH services answered, because caching is
  // permanent: letting a timeout count as "nobody knows this selector" would
  // poison it forever on the strength of one bad minute of network.
  static async _resolve(selector) {
    const sources = [
      ['sourcify', this.lookupSourcify],
      ['4byte', this.lookupFourByte],
    ];
    let failures = 0;
    for (const [source, lookup] of sources) {
      try {
        const name = await lookup.call(this, selector);
        if (name) return { name, source };
      } catch (err) {
        failures++;
        logger.warn({ selector, source, err }, 'Method signature lookup failed');
      }
    }
    return failures === 0 ? { name: null, source: 'none' } : null;
  }

  // The decode pass. Runs during sync ONLY -- never in a request handler, which
  // is why it reads from stored rows rather than from whatever the sync just
  // held in memory: that also makes it self-healing, since a selector deferred
  // by the cap or missed by an outage is still pending on the next run.
  static async decodePendingForWallet(walletId) {
    const selectors = await EthTransfer.pendingMethodSelectors(walletId);
    const summary = { pending: selectors.length, lookups: 0, resolved: 0, applied: 0 };
    if (!selectors.length) return summary;

    // The cache-once guarantee lives on this line: anything already in the
    // table -- hit OR miss -- is excluded from the network set, so a second
    // sync over the same wallet performs zero lookups.
    const cached = await EthMethodSignature.findMany(selectors);
    const unknown = selectors.filter((selector) => !cached.has(selector));
    const budget = unknown.slice(0, MAX_LOOKUPS_PER_SYNC);
    if (unknown.length > budget.length) {
      logger.info(
        { walletId, deferred: unknown.length - budget.length },
        'Method selector lookups deferred to the next sync'
      );
    }

    const startedAt = Date.now();
    for (const selector of budget) {
      if (Date.now() - startedAt > DECODE_DEADLINE_MS) {
        logger.info(
          { walletId, remaining: budget.length - summary.lookups },
          'Method selector decode deadline reached; remaining selectors deferred'
        );
        break;
      }
      if (summary.lookups > 0) await delay(REQUEST_SPACING_MS);
      summary.lookups++;
      const answer = await this._resolve(selector);
      if (!answer) continue;
      try {
        await EthMethodSignature.cache(selector, answer.name, answer.source);
        if (answer.name) summary.resolved++;
      } catch (err) {
        // One failed INSERT must not skip the rest of the budget or the
        // applyMethodNames pass that publishes names already resolved.
        logger.warn({ selector, err }, 'Method signature cache write failed');
      }
    }

    summary.applied = await EthTransfer.applyMethodNames(walletId);
    return summary;
  }
}

module.exports = MethodSignatureService;
