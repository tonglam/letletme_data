import { afterEach, describe, expect, mock, test } from 'bun:test';

import { fplClient } from '../../src/clients/fpl';
import { FPLClientError } from '../../src/utils/errors';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('FPL entry cup client', () => {
  test('returns null when an entry has no cup data', async () => {
    globalThis.fetch = mock(async () => new Response(null, { status: 404 })) as typeof fetch;

    await expect(fplClient.getEntryCup(123)).resolves.toBeNull();
  });

  test('continues to throw upstream failures', async () => {
    globalThis.fetch = mock(
      async () => new Response(null, { status: 503, statusText: 'Service Unavailable' }),
    ) as typeof fetch;

    try {
      await fplClient.getEntryCup(123);
      throw new Error('Expected getEntryCup to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(FPLClientError);
      expect((error as FPLClientError).status).toBe(503);
    }
  });
});
