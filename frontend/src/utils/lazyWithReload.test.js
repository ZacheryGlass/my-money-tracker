import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadOnImportFailure } from './lazyWithReload';

describe('reloadOnImportFailure', () => {
  let reload;

  beforeEach(() => {
    window.sessionStorage.clear();
    reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes through a successful import', async () => {
    const mod = { default: () => null };
    await expect(reloadOnImportFailure(vi.fn().mockResolvedValue(mod))()).resolves.toBe(mod);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads once and hangs (does not settle) on a failed import', async () => {
    const factory = vi.fn().mockRejectedValue(new Error('Failed to fetch dynamically imported module'));
    const pending = reloadOnImportFailure(factory)();

    // Let the rejected import propagate into the .catch handler.
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);

    // The returned promise never settles so the reload can take over.
    const outcome = await Promise.race([pending.then(() => 'settled'), Promise.resolve('pending')]);
    expect(outcome).toBe('pending');
  });

  it('rethrows instead of looping when a reload was just attempted', async () => {
    window.sessionStorage.setItem('chunk-reload-at', String(Date.now()));
    await expect(reloadOnImportFailure(vi.fn().mockRejectedValue(new Error('still missing')))())
      .rejects.toThrow('still missing');
    expect(reload).not.toHaveBeenCalled();
  });

  it('retries again once the reload window has elapsed', async () => {
    window.sessionStorage.setItem('chunk-reload-at', String(Date.now() - 60_000));
    reloadOnImportFailure(vi.fn().mockRejectedValue(new Error('stale again')))();

    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
