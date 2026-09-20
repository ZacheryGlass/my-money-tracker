import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const axiosMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  responseUse: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      get: axiosMocks.get,
      post: axiosMocks.post,
      interceptors: { response: { use: axiosMocks.responseUse } },
    })),
  },
}));

import { eth } from './api';

const runningJob = (id = 41) => ({
  id,
  status: 'running',
  started_at: '2026-09-19T12:00:00.000Z',
  completed_at: null,
  sync_status: null,
});

describe('eth.syncWallet', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T12:00:00.000Z'));
    axiosMocks.get.mockReset();
    axiosMocks.post.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves a legacy synchronous sync response without polling', async () => {
    const payload = {
      wallet: { id: 7 },
      sync: { status: 'complete', inserted: 12 },
    };
    axiosMocks.post.mockResolvedValue({ data: payload });

    await expect(eth.syncWallet(7)).resolves.toBe(payload);
    expect(axiosMocks.post).toHaveBeenCalledWith('/api/eth/wallets/7/sync?async=true');
    expect(axiosMocks.get).not.toHaveBeenCalled();
  });

  it('polls the durable job and maps its completed outcome to sync.status', async () => {
    const started = {
      started: true,
      job: runningJob(),
      message: 'Wallet sync started',
    };
    const completed = {
      ...runningJob('41'),
      status: 'completed',
      completed_at: '2026-09-19T12:00:06.000Z',
      sync_status: 'deferred',
    };
    axiosMocks.post.mockResolvedValue({ data: started });
    axiosMocks.get
      .mockResolvedValueOnce({ data: { job: runningJob('41') } })
      .mockResolvedValueOnce({ data: { job: completed } });

    const pending = eth.syncWallet(7);
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(axiosMocks.get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toEqual({
      ...started,
      job: completed,
      sync: { status: 'deferred' },
    });
    expect(axiosMocks.get).toHaveBeenNthCalledWith(1, '/api/eth/wallets/7/sync-status?job_id=41');
    expect(axiosMocks.get).toHaveBeenNthCalledWith(2, '/api/eth/wallets/7/sync-status?job_id=41');
  });

  it('maps a terminal failed job to the legacy failed sync outcome', async () => {
    const failed = {
      ...runningJob(),
      status: 'failed',
      completed_at: '2026-09-19T12:00:01.000Z',
    };
    axiosMocks.post.mockResolvedValue({ data: { started: false, job: failed } });

    await expect(eth.syncWallet(7)).resolves.toEqual({
      started: false,
      job: failed,
      sync: { status: 'failed' },
    });
    expect(axiosMocks.get).not.toHaveBeenCalled();
  });

  it('tolerates a missing status route during a rolling deployment', async () => {
    const routeMissing = new Error('not found on old instance');
    routeMissing.response = { status: 404 };
    const completed = {
      ...runningJob(),
      status: 'completed',
      completed_at: '2026-09-19T12:00:20.000Z',
      sync_status: 'complete',
    };
    axiosMocks.post.mockResolvedValue({
      data: { started: true, job: runningJob(), message: 'Wallet sync started' },
    });
    axiosMocks.get
      .mockRejectedValueOnce(routeMissing)
      .mockResolvedValueOnce({ data: { job: completed } });

    const pending = eth.syncWallet(7);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(pending).resolves.toMatchObject({
      job: completed,
      sync: { status: 'complete' },
    });
    expect(axiosMocks.get).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the start response has no durable job', async () => {
    axiosMocks.post.mockResolvedValue({ data: { started: true, job: null } });

    await expect(eth.syncWallet(7)).rejects.toThrow(
      'Wallet sync protocol error: response did not include a job'
    );
    expect(axiosMocks.get).not.toHaveBeenCalled();
  });

  it('fails closed when a completed job has no compatible sync outcome', async () => {
    axiosMocks.post.mockResolvedValue({
      data: {
        started: false,
        job: { ...runningJob(), status: 'completed', sync_status: null },
      },
    });

    await expect(eth.syncWallet(7)).rejects.toThrow(
      'Wallet sync protocol error: completed job 41 has invalid sync status null'
    );
    expect(axiosMocks.get).not.toHaveBeenCalled();
  });

  it('fails closed when polling loses the claimed job', async () => {
    axiosMocks.post.mockResolvedValue({ data: { started: true, job: runningJob() } });
    axiosMocks.get.mockResolvedValue({ data: { job: null } });

    const pending = eth.syncWallet(7);
    const rejected = expect(pending).rejects.toThrow(
      'Wallet sync protocol error: response did not include a job'
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);

    await rejected;
  });

  it('times out a job that remains running for two hours', async () => {
    const start = Date.now();
    axiosMocks.post.mockResolvedValue({ data: { started: true, job: runningJob() } });
    axiosMocks.get.mockResolvedValue({ data: { job: runningJob() } });

    const pending = eth.syncWallet(7);
    const rejected = expect(pending).rejects.toThrow(
      'Wallet sync for wallet 7 timed out after 2 hours'
    );
    await Promise.resolve();

    // Move close to the deadline without executing thousands of poll ticks;
    // the already-scheduled poll delay then reaches the same timeout boundary.
    vi.setSystemTime(new Date(start + (2 * 60 * 60 * 1_000) - 10_000));
    await vi.advanceTimersByTimeAsync(10_000);

    await rejected;
    expect(axiosMocks.get).toHaveBeenCalledTimes(1);
  });
});
