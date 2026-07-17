import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { fplClient } from '../../src/clients/fpl';
import { FPLClientError } from '../../src/utils/errors';

const originalFetch = globalThis.fetch;
const ENV_KEYS = [
  'FPL_REQUEST_TIMEOUT_MS',
  'FPL_RETRY_BASE_DELAY_MS',
  'FPL_RETRY_MAX_DELAY_MS',
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
  }
  // Keep retry waits in the millisecond range for tests.
  process.env.FPL_RETRY_BASE_DELAY_MS = '1';
  process.env.FPL_RETRY_MAX_DELAY_MS = '50';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('FPL client resilience (FP-18)', () => {
  test('hung socket aborts after the timeout and exhausts retries', async () => {
    process.env.FPL_REQUEST_TIMEOUT_MS = '20';
    const fetchMock = mock(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation timed out.', 'TimeoutError'));
          });
        }),
    );
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
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('429 honors the Retry-After header before retrying', async () => {
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

  test('caps a multi-minute Retry-After so workers are not parked', async () => {
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

  test('500 succeeds on retry', async () => {
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

  test('persistent 5xx exhausts retries and surfaces the last status', async () => {
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

  test('non-retryable statuses are returned without retrying', async () => {
    const fetchMock = mock(async () => new Response(null, { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(fplClient.getEntryCup(123)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('hung 200 body is retried and succeeds on the next attempt', async () => {
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

  test('hung 429 body still surfaces 429 after retries exhaust', async () => {
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

  test('stale 429 is not returned after a later 2xx body stalls', async () => {
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

  test('hung 429 body still honors Retry-After before the next attempt', async () => {
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

  test('sends a descriptive User-Agent on every request', async () => {
    let seenUserAgent: string | null = null;
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      seenUserAgent = (init?.headers as Record<string, string>)['User-Agent'] ?? null;
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    await fplClient.getFixtures(1);
    expect(seenUserAgent).toMatch(/letletme-data\/1\.0\.0/);
  });
});
