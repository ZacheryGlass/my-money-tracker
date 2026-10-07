'use strict';

// Base Mainnet, RETIRED by migration 082. Not synced, not audited; listed so
// the retirement is data rather than scattered constants: imports drop its
// chain id, and the bridge/completion policy recognizes a movement toward it
// as an explicit scope exclusion.
module.exports = {
  id: 8453,
  caip2: 'eip155:8453',
  family: 'evm',
  name: 'Base',
  retired: true,
  // Spellings a decoded bridge identity may use for this chain id.
  chainTextValues: ['8453', '0x2105'],
  // Canonical first-party Base L1 deployments. This single list drives both
  // movement production and completion validation; a merely well-formed
  // address or URL is not evidence that a transaction crossed the excluded
  // Base scope.
  exclusionEndpoints: [
    {
      address: '0x3154cf16ccdb4c6d922629664174b904d80f2c35',
      name: 'Base: L1 Standard Bridge', role: 'standard_bridge',
      source_url: 'https://docs.base.org/specifications/reference/base-contracts',
    },
    {
      address: '0x49048044d57e1c92a77f79988d21fa8faf74e97e',
      name: 'Base: Portal', role: 'portal',
      source_url: 'https://docs.base.org/specifications/reference/base-contracts',
    },
    {
      address: '0x866e82a600a1414e583f7f13623f1ac5d58b0afa',
      name: 'Base: L1 Cross Domain Messenger', role: 'cross_domain_messenger',
      source_url: 'https://docs.base.org/specifications/reference/base-contracts',
    },
  ],
};
