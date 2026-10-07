'use strict';

// The network registry: every *.js file in this directory is one network.
// Adding an EVM L2 is adding one file here (plus bridge pack rows if it has a
// canonical bridge); config/chains.js reads the result.
//
// Each file is data: identity (id, caip2, family), the persisted keys
// (shortName, nativeAsset), provider routing (accountApi / historyProvider),
// RPC endpoints (env name + default), per-chain quirks (classicRetryableDeposits,
// stateSyncDeposits, opStackDeposits), explorer links, exchange network
// spellings, and audit settings. `retired: true` marks a network that is no
// longer synced but whose identity still shapes policy (Base).
//
// CRYPTO_EXTRA_NETWORKS_DIR adds a second directory -- the extensibility
// acceptance test uses it to prove a new network needs no core edit.

const fs = require('fs');
const path = require('path');

function loadDir(dir) {
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith('.js') && file !== 'index.js')
    .sort()
    .map((file) => ({ file, network: require(path.join(dir, file)) }));
}

function validate(entries) {
  const byId = new Map();
  const shortNames = new Map();
  for (const { file, network } of entries) {
    if (!Number.isInteger(network.id) || network.id <= 0) throw new Error(`${file}: id must be a positive integer`);
    if (byId.has(network.id)) throw new Error(`${file}: duplicate network id ${network.id} (also ${byId.get(network.id)})`);
    byId.set(network.id, file);
    if (!network.family) throw new Error(`${file}: family is required`);
    if (!network.name) throw new Error(`${file}: name is required`);
    if (network.retired) continue;
    for (const field of ['shortName', 'nativeAsset']) {
      if (!network[field]) throw new Error(`${file}: ${field} is required`);
    }
    if (!Number.isFinite(network.order)) throw new Error(`${file}: order is required`);
    if (shortNames.has(network.shortName)) {
      throw new Error(`${file}: shortName ${network.shortName} is already used by ${shortNames.get(network.shortName)}`);
    }
    shortNames.set(network.shortName, file);
    if (!network.explorer?.baseUrl) throw new Error(`${file}: explorer.baseUrl is required`);
  }
}

// How each native symbol is priced, keyed by symbol: ETH is one asset whether
// it moved on mainnet or an L2. Exactly one network declares each symbol's
// pricing; another network with the same symbol inherits it.
function nativeAssets(active) {
  const out = {};
  for (const network of active) {
    if (!network.nativeAssetPricing) continue;
    if (out[network.nativeAsset]) {
      throw new Error(`native asset ${network.nativeAsset} is priced by more than one network`);
    }
    out[network.nativeAsset] = { ...network.nativeAssetPricing };
  }
  for (const network of active) {
    if (!out[network.nativeAsset]) {
      throw new Error(`network ${network.id}: no network declares pricing for ${network.nativeAsset}`);
    }
  }
  return out;
}

function load() {
  const entries = loadDir(__dirname);
  const extra = process.env.CRYPTO_EXTRA_NETWORKS_DIR;
  if (extra) entries.push(...loadDir(path.resolve(extra)));
  validate(entries);
  const all = entries.map((entry) => entry.network);
  const active = all.filter((network) => !network.retired).sort((a, b) => a.order - b.order);
  const retired = all.filter((network) => network.retired);
  return { active, retired, nativeAssets: nativeAssets(active) };
}

module.exports = load();
