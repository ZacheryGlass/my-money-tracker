import { describe, expect, it } from 'vitest';
import {
  explorerAddressUrl,
  explorerTxUrl,
  nativeSymbol,
} from './chains';

describe('zkSync explorer routing', () => {
  it('links Era rows to the configured Blockscout explorer', () => {
    expect(explorerTxUrl('0xabc', 324)).toBe('https://zksync.blockscout.com/tx/0xabc');
    expect(explorerAddressUrl('0xdef', 324))
      .toBe('https://zksync.blockscout.com/address/0xdef');
  });

  it('uses zkScan legacy routes for the app-internal Lite chain identity', () => {
    expect(explorerTxUrl('0xabc', 32401))
      .toBe('https://zkscan.io/explorer/transactions/0xabc');
    expect(explorerAddressUrl('0xdef', 32401))
      .toBe('https://zkscan.io/explorer/accounts/0xdef');
  });

  it('treats both zkSync networks as ETH-native', () => {
    expect(nativeSymbol(324)).toBe('ETH');
    expect(nativeSymbol(32401)).toBe('ETH');
  });
});
