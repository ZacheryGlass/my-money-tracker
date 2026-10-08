import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCryptoMeta, keepLoadingCryptoMeta, setCryptoMeta } from './meta';
import cryptoMetaFixture from '../../test/cryptoMeta.fixture.json';

describe('keepLoadingCryptoMeta', () => {
  afterEach(() => {
    vi.useRealTimers();
    setCryptoMeta(cryptoMetaFixture);
  });

  it('retries a failed load with backoff until the meta lands', async () => {
    vi.useFakeTimers();
    setCryptoMeta(null);
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('cold start'))
      .mockRejectedValueOnce(new Error('cold start'))
      .mockResolvedValue({ networks: [] });

    keepLoadingCryptoMeta(fetcher, { firstDelayMs: 1000, maxDelayMs: 30000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(getCryptoMeta()).toBeNull();

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(getCryptoMeta()).toEqual({ networks: [] });

    await vi.advanceTimersByTimeAsync(60000);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('stops retrying once cancelled', async () => {
    vi.useFakeTimers();
    setCryptoMeta(null);
    const fetcher = vi.fn().mockRejectedValue(new Error('down'));

    const stop = keepLoadingCryptoMeta(fetcher, { firstDelayMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(getCryptoMeta()).toBeNull();
  });
});
