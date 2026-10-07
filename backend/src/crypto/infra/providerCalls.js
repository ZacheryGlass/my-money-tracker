'use strict';

// Counts outbound provider requests made inside a measured scope. The derived
// pipeline wraps each run in measure() so its timing log can say how many
// network calls a label write or rebuild made; a database-only refresh should
// report zero. Scopes nest: an inner measure() also counts into its parents.

const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

// Called by every provider queue at the moment a request is dispatched.
function record(key) {
  for (let scope = storage.getStore(); scope; scope = scope.parent) {
    scope.total += 1;
    scope.byKey[key] = (scope.byKey[key] || 0) + 1;
  }
}

async function measure(fn) {
  const scope = { total: 0, byKey: {}, parent: storage.getStore() || null };
  const result = await storage.run(scope, fn);
  return { result, calls: { total: scope.total, byKey: scope.byKey } };
}

module.exports = { record, measure };
