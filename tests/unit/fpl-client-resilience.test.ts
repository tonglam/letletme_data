import { describe, expect, mock, test } from 'bun:test';

import { fplClient } from '../../src/clients/fpl';
import { FPLClientError } from '../../src/utils/errors';
import { getFplAdmissionStats, resetFplAdmissionForTests } from '../../src/utils/fpl-admission';

const ENV_KEYS = [
  'FPL_REQUEST_DEADLINE_MS',
  'FPL_REQUEST_TIMEOUT_MS',
  'FPL_RETRY_BASE_DELAY_MS',
  'FPL_RETRY_MAX_DELAY_MS',
] as const;

type AsyncTestBody = () => Promise<void>;

const serialTest = (test as unknown as { serial?: typeof test }).serial;
const fallbackCases: Array<{ label: string; body: AsyncTestBody }> = [];

const runWithIsolatedState = async (body: AsyncTestBody): Promise<void> => {
  const originalFetch = globalThis.fetch;
  const savedEnv = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);

  // Keep retry waits in the millisecond range for tests.
  process.env.FPL_RETRY_BASE_DELAY_MS = '1';
  process.env.FPL_RETRY_MAX_DELAY_MS = '50';
  try {
    resetFplAdmissionForTests();
    await body();
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const isolatedTest = (label: string, body: AsyncTestBody): void => {
  const wrapped = () => runWithIsolatedState(body);
  if (serialTest) serialTest(label, wrapped, 20_000);
  else fallbackCases.push({ label, body });
};

// These cases intentionally mutate process-wide fetch/env state. The helper
// above serializes their state windows so no case can leak into another one.
describe('FPL client resilience (FP-18)', () => {
  isolatedTest('hung socket aborts after the timeout and exhausts retries', async () => {
    process.env.FPL_REQUEST_TIMEOUT_MS = '20';
    let fetchCalls = 0;
    const fetchMock = (_url: string, init?: RequestInit): Promise<Response> => {
      fetchCalls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation timed out.', 'TimeoutError'));
        });
      });
    };
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const started = Date.now();
    try {
      await fplClient.getFixtures(1);
      throw new Error('Expected getFixtures to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(FPLClientError);
      expect((error as FPLClientError).code).toBe('UNKNOWN_ERROR');
    }
    // 1 initial attempt + 3 retries, each aborting ~20ms in.
    expect(fetchCalls).toBe(4);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  isolatedTest('429 honors the Retry-After header before retrying', async () => {
    process.env.FPL_RETRY_MAX_DELAY_MS = '1500';
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': '1' },
        });
      }
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    const started = Date.now();
    const fixtures = await fplClient.getFixtures(1);
    const elapsed = Date.now() - started;

    expect(fixtures).toEqual([]);
    expect(calls).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  isolatedTest('caps a multi-minute Retry-After so workers are not parked', async () => {
    process.env.FPL_RETRY_MAX_DELAY_MS = '10';
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': '120' },
        });
      }
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    const started = Date.now();
    await fplClient.getFixtures(1);

    expect(calls).toBe(2);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  isolatedTest('500 succeeds on retry', async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      if (calls < 3) {
        return new Response('boom', { status: 500, statusText: 'Internal Server Error' });
      }
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    const fixtures = await fplClient.getFixtures(1);
    expect(fixtures).toEqual([]);
    expect(calls).toBe(3);
  });

  isolatedTest(
    'runs the entry-summary ordering hook immediately before every retry attempt',
    async () => {
      let calls = 0;
      const attempts: number[] = [];
      const hookInflight: number[] = [];
      globalThis.fetch = mock(async () => {
        calls += 1;
        if (calls === 1) {
          return new Response('retry', { status: 503, statusText: 'Service Unavailable' });
        }
        return new Response(
          JSON.stringify({
            id: 123,
            name: 'Retry XI',
            player_first_name: 'Retry',
            player_last_name: 'Manager',
            summary_overall_rank: 456_789,
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;

      const summary = await fplClient.getEntrySummary(123, {
        beforeAttempt: (attempt) => {
          attempts.push(attempt);
          hookInflight.push(getFplAdmissionStats().inflight);
        },
      });

      expect(summary.summary_overall_rank).toBe(456_789);
      expect(calls).toBe(2);
      expect(attempts).toEqual([0, 1]);
      expect(hookInflight).toEqual([1, 1]);
    },
  );

  isolatedTest(
    're-admits each real HTTP retry and does not hold a lease during backoff',
    async () => {
      let calls = 0;
      let inflightDuringBackoff = -1;
      let observeBackoff: (() => void) | null = null;
      const backoffObserved = new Promise<void>((resolve) => {
        observeBackoff = resolve;
      });
      globalThis.fetch = mock(async () => {
        calls += 1;
        if (calls === 1) {
          setTimeout(() => {
            inflightDuringBackoff = getFplAdmissionStats().inflight;
            observeBackoff?.();
          }, 50);
          return new Response('retry', { status: 500, headers: { 'Retry-After': '0.2' } });
        }
        return new Response('[]', { status: 200 });
      }) as unknown as typeof fetch;

      process.env.FPL_RETRY_MAX_DELAY_MS = '500';
      await expect(fplClient.getFixtures(1)).resolves.toEqual([]);
      await backoffObserved;
      expect(calls).toBe(2);
      expect(inflightDuringBackoff).toBe(0);
      // Two attempts consume two bucket tokens; releasing a lease does not
      // refund a token, which keeps retry traffic visible to the global rate cap.
      expect(getFplAdmissionStats().tokens).toBeLessThan(3);
      expect(getFplAdmissionStats().inflight).toBe(0);
    },
  );

  isolatedTest(
    'does not allow callers outside the watcher to request critical priority',
    async () => {
      const fetchMock = mock(async () => new Response('{}', { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        fplClient.getEntrySummary(123, {
          priority: 'deadline-critical',
          maxRetries: 0,
        }),
      ).rejects.toMatchObject({ code: 'FPL_INVALID_PRIORITY' });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  isolatedTest('aborts a blocked pre-attempt hook at the logical request deadline', async () => {
    process.env.FPL_REQUEST_DEADLINE_MS = '25';
    const fetchMock = mock(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    let hookWasAborted = false;

    const started = Date.now();
    await expect(
      fplClient.getEntrySummary(123, {
        beforeAttempt: (_attempt, context) => {
          return new Promise<void>((_resolve, reject) => {
            context.signal.addEventListener(
              'abort',
              () => {
                hookWasAborted = true;
                reject(context.signal.reason);
              },
              { once: true },
            );
          });
        },
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_ERROR' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(hookWasAborted).toBeTrue();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  isolatedTest(
    'does not start an HTTP attempt after a synchronous hook spends the deadline',
    async () => {
      process.env.FPL_REQUEST_DEADLINE_MS = '5';
      const fetchMock = mock(async () => new Response('{}', { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        fplClient.getEntrySummary(123, {
          maxRetries: 0,
          beforeAttempt: () => {
            const deadline = Date.now() + 20;
            while (Date.now() < deadline) {
              // Deliberately block the event loop to exercise the post-hook check.
            }
          },
        }),
      ).rejects.toMatchObject({ code: 'UNKNOWN_ERROR' });

      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  isolatedTest('persistent 5xx exhausts retries and surfaces the last status', async () => {
    const fetchMock = mock(
      async () => new Response('boom', { status: 503, statusText: 'Service Unavailable' }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await fplClient.getFixtures(1);
      throw new Error('Expected getFixtures to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(FPLClientError);
      expect((error as FPLClientError).status).toBe(503);
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  isolatedTest('non-retryable statuses are returned without retrying', async () => {
    const fetchMock = mock(async () => new Response(null, { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(fplClient.getEntryCup(123)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  isolatedTest('hung 200 body is retried and succeeds on the next attempt', async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      if (calls === 1) {
        // Headers look fine; body consume fails (stall/truncation).
        const stalled = new ReadableStream({
          pull() {
            throw new Error('body stalled');
          },
        });
        return new Response(stalled, { status: 200 });
      }
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    const fixtures = await fplClient.getFixtures(1);
    expect(fixtures).toEqual([]);
    expect(calls).toBe(2);
  });

  isolatedTest('hung 429 body still surfaces 429 after retries exhaust', async () => {
    process.env.FPL_REQUEST_TIMEOUT_MS = '50';
    const fetchMock = mock(async () => {
      const stalled = new ReadableStream({
        pull() {
          throw new Error('rate-limit body stalled');
        },
      });
      return new Response(stalled, { status: 429, statusText: 'Too Many Requests' });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await fplClient.getFixtures(1);
      throw new Error('Expected getFixtures to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(FPLClientError);
      expect((error as FPLClientError).status).toBe(429);
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  isolatedTest('stale 429 is not returned after a later 2xx body stalls', async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('rate limited', { status: 429 });
      }
      // Subsequent attempts look successful at the header layer but body fails.
      const stalled = new ReadableStream({
        pull() {
          throw new Error('body stalled after prior 429');
        },
      });
      return new Response(stalled, { status: 200 });
    }) as unknown as typeof fetch;

    try {
      await fplClient.getFixtures(1);
      throw new Error('Expected getFixtures to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(FPLClientError);
      // Must not surface the earlier 429 once a 2xx was observed.
      expect((error as FPLClientError).status).toBeUndefined();
      expect((error as FPLClientError).code).toBe('UNKNOWN_ERROR');
    }
    expect(calls).toBe(4);
  });

  isolatedTest('hung 429 body still honors Retry-After before the next attempt', async () => {
    process.env.FPL_RETRY_MAX_DELAY_MS = '1500';
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      if (calls === 1) {
        const stalled = new ReadableStream({
          pull() {
            throw new Error('rate-limit body stalled');
          },
        });
        return new Response(stalled, {
          status: 429,
          headers: { 'Retry-After': '1' },
        });
      }
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    const started = Date.now();
    const fixtures = await fplClient.getFixtures(1);
    const elapsed = Date.now() - started;

    expect(fixtures).toEqual([]);
    expect(calls).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  isolatedTest('sends a descriptive User-Agent on every request', async () => {
    let seenUserAgent: string | null = null;
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      seenUserAgent = (init?.headers as Record<string, string>)['User-Agent'] ?? null;
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    await fplClient.getFixtures(1);
    expect(seenUserAgent).toMatch(/letletme-data\/1\.0\.0/);
  });

  // Bun 1.2 has no runtime serial-test API. Keep a compatible fallback that
  // executes the same cases one by one, while Bun 1.3+ retains per-case names.
  if (!serialTest) {
    test('runs FPL resilience cases serially on older Bun runtimes', async () => {
      for (const { body } of fallbackCases) await runWithIsolatedState(body);
    }, 20_000);
  }
});
