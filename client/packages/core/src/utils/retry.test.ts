import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { retryWithBackoff } from './retry.ts';

describe('retryWithBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns on first successful attempt', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const p = retryWithBackoff(fn, { maxAttempts: 3, initialDelayMs: 100 });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and eventually resolves', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValue('ok');

    const p = retryWithBackoff(fn, { maxAttempts: 5, initialDelayMs: 100 });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting all attempts', async () => {
    vi.useRealTimers();
    const fn = vi.fn().mockRejectedValue(new Error('always fail'));
    await expect(
      retryWithBackoff(fn, { maxAttempts: 3, initialDelayMs: 1 }),
    ).rejects.toThrow('always fail');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws immediately if maxAttempts < 1', async () => {
    const fn = vi.fn();
    await expect(
      retryWithBackoff(fn, { maxAttempts: 0, initialDelayMs: 100 }),
    ).rejects.toThrow('maxAttempts must be >= 1');
    expect(fn).not.toHaveBeenCalled();
  });

  it('stops retrying when shouldRetry returns false', async () => {
    vi.useRealTimers();
    const fn = vi.fn().mockRejectedValue(new Error('permanent'));
    const shouldRetry = vi.fn().mockReturnValue(false);

    await expect(
      retryWithBackoff(fn, {
        maxAttempts: 5,
        initialDelayMs: 1,
        shouldRetry,
      }),
    ).rejects.toThrow('permanent');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledTimes(1);
  });

  it('calls onRetry with attempt number and delay', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');
    const onRetry = vi.fn();

    const p = retryWithBackoff(fn, {
      maxAttempts: 3,
      initialDelayMs: 100,
      onRetry,
    });
    await vi.runAllTimersAsync();
    await p;
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Number));
    // Jittered delay should be in [0, initialDelayMs)
    const delay = onRetry.mock.calls[0][1];
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(100);
  });

  it('respects cancellation signal before attempt', async () => {
    vi.useRealTimers();
    const signal = { cancelled: true };
    const fn = vi.fn().mockResolvedValue('ok');

    await expect(
      retryWithBackoff(fn, {
        maxAttempts: 3,
        initialDelayMs: 1,
        signal,
      }),
    ).rejects.toThrow('Cancelled');
    expect(fn).not.toHaveBeenCalled();
  });

  it('respects cancellation signal after successful fn()', async () => {
    vi.useRealTimers();
    const signal = { cancelled: false };
    const fn = vi.fn().mockImplementation(async () => {
      signal.cancelled = true;
      return 'ok';
    });

    await expect(
      retryWithBackoff(fn, {
        maxAttempts: 3,
        initialDelayMs: 1,
        signal,
      }),
    ).rejects.toThrow('Cancelled');
  });

  it('respects maxDelayMs cap', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');
    const onRetry = vi.fn();

    // initialDelayMs=1000, maxDelayMs=1500 — after doubling to 2000, should cap at 1500
    const p = retryWithBackoff(fn, {
      maxAttempts: 5,
      initialDelayMs: 1000,
      maxDelayMs: 1500,
      onRetry,
    });
    await vi.runAllTimersAsync();
    await p;

    // Third retry delay should be capped: delay would be 4000 but capped at 1500
    const thirdDelay = onRetry.mock.calls[2][1];
    expect(thirdDelay).toBeLessThan(1500);
  });
});
