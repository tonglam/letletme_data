import { describe, expect, test } from 'bun:test';
import { recoverContentDatabaseStartup } from '../../src/content/acquisition/startup-recovery';

describe('content registry startup recovery', () => {
  test('recovers a wrapped shutdown error before starting consumers once', async () => {
    let calls = 0;
    let retries = 0;
    let starts = 0;
    const value = await recoverContentDatabaseStartup(
      async () => {
        if (++calls < 3) throw new Error('query failed', { cause: { code: '57P03' } });
        return 'registry-ready';
      },
      {
        signal: new AbortController().signal,
        retryDelayMs: 1,
        onRetry: () => {
          retries++;
        },
      },
    );
    starts++;
    expect({ value, calls, retries, starts }).toEqual({
      value: 'registry-ready',
      calls: 3,
      retries: 2,
      starts: 1,
    });
  });

  test('keeps invalid manifest and permanent SQL failures stopped', async () => {
    for (const error of [new Error('invalid manifest'), { code: '42501' }, { code: '42P01' }]) {
      let calls = 0;
      await expect(
        recoverContentDatabaseStartup(
          async () => {
            calls++;
            throw error;
          },
          {
            signal: new AbortController().signal,
            retryDelayMs: 1,
            onRetry: () => {
              throw new Error('unexpected retry');
            },
          },
        ),
      ).rejects.toBe(error);
      expect(calls).toBe(1);
    }
  });

  test('shutdown cancels the pending delay without another database attempt', async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      recoverContentDatabaseStartup(
        async () => {
          calls++;
          throw { code: 'ECONNRESET' };
        },
        {
          signal: controller.signal,
          onRetry: () => {
            controller.abort();
          },
        },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
