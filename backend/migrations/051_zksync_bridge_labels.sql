-- Add the zkSync bridge labels introduced after 044 had already run in
-- production. These rows also remain in 044's generated seed so a fresh
-- database receives one complete canonical pack; this migration upgrades
-- existing databases. Never overwrite a builtin the user already corrected.
INSERT INTO eth_address_labels
  (user_id, address, name, source, kind, confidence, note)
VALUES
  (NULL, '0xabea9132b05a70803a4e85094fd0e1800777fbef',
   'zkSync Lite: Main Contract', 'builtin-bridge', 'bridge', 'high',
   'Cross-chain bridge on chain 1. Source: https://docs.lite.zksync.io/api/environments/'),
  (NULL, '0x303a465b659cbb0ab36ee643ea362c509eeb5213',
   'ZKsync: Bridgehub', 'builtin-bridge', 'bridge', 'high',
   'Cross-chain bridge on chain 1. Source: https://docs.zksync.io/zksync-protocol/contracts/l1-contracts/zk-chain-addresses'),
  (NULL, '0xd7f9f54194c633f36ccd5f3da84ad4a1c38cb2cb',
   'ZKsync: Shared Bridge', 'builtin-bridge', 'bridge', 'high',
   'Cross-chain bridge on chain 1. Source: https://docs.zksync.io/zksync-protocol/contracts/l1-contracts/zk-chain-addresses'),
  (NULL, '0x8829ad80e425c646dab305381ff105169feece56',
   'ZKsync: L1 Asset Router', 'builtin-bridge', 'bridge', 'high',
   'Cross-chain bridge on chain 1. Source: https://docs.zksync.io/zksync-protocol/contracts/l1-contracts/zk-chain-addresses'),
  (NULL, '0x32400084c286cf3e17e7b677ea9583e60a000324',
   'ZKsync Era: Chain Contract', 'builtin-bridge', 'bridge', 'high',
   'Cross-chain bridge on chain 1. Source: https://docs.zksync.io/zksync-protocol/contracts/l1-contracts/zk-chain-addresses'),
  (NULL, '0x57891966931eb4bb6fb81430e6ce0a03aabde063',
   'ZKsync Era: Legacy L1 ERC20 Bridge', 'builtin-bridge', 'bridge', 'high',
   'Cross-chain bridge on chain 1. Source: https://docs.zksync.io/zksync-protocol/api/zks-rpc'),
  (NULL, '0x11f943b2c77b743ab90f4a0ae7d5a4e7fca3e102',
   'ZKsync Era: L2 ERC20 Bridge', 'builtin-bridge', 'bridge', 'high',
   'Cross-chain bridge on chain 324. Source: https://docs.zksync.io/zksync-protocol/api/zks-rpc'),
  (NULL, '0x000000000000000000000000000000000000800a',
   'ZKsync Era: L2 Base Token', 'builtin-bridge', 'bridge', 'high',
   'Cross-chain bridge on chain 324. Source: https://docs.zksync.io/zksync-protocol/era-vm/contracts/system-contracts')
ON CONFLICT (address) WHERE user_id IS NULL DO NOTHING;
