import { afterEach, describe, expect, mock, test } from 'bun:test';

import { fplClient } from '../../src/clients/fpl';
import {
  beginFplLogicalRequest,
  classifyFplEndpoint,
  getFplRequestMetricsSnapshot,
  runWithFplRequestMetrics,
} from '../../src/utils/fpl-request-metrics';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.FPL_RETRY_BASE_DELAY_MS;
  delete process.env.FPL_RETRY_MAX_DELAY_MS;
  delete process.env.FPL_REQUEST_DEADLINE_MS;
  delete process.env.FPL_REQUEST_TIMEOUT_MS;
});

describe('FPL request metrics', () => {
  test('classifies only bounded endpoint labels without retaining identifiers', () => {
    expect(classifyFplEndpoint('https://fantasy.premierleague.com/api/entry/123/')).toBe(
      'entry_summary',
    );
    expect(
      classifyFplEndpoint('https://fantasy.premierleague.com/api/entry/123/event/9/picks/'),
    ).toBe('entry_picks');
    expect(
      classifyFplEndpoint('https://fantasy.premierleague.com/api/leagues-classic/456/standings/'),
    ).toBe('league_classic');
    expect(classifyFplEndpoint('not-a-url')).toBe('unknown');
  });

  test('records retry attempts and the final outcome from the real client boundary', async () => {
    process.env.FPL_RETRY_BASE_DELAY_MS = '0';
    process.env.FPL_RETRY_MAX_DELAY_MS = '0';
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      return calls === 1
        ? new Response('rate limited', { status: 429 })
        : new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    await runWithFplRequestMetrics(async () => {
      await fplClient.getFixtures(1);
      const metrics = getFplRequestMetricsSnapshot();
      expect(metrics.logicalRequests).toBe(1);
      expect(metrics.attempts).toBe(2);
      expect(metrics.retries).toBe(1);
      expect(metrics.byEndpoint.fixtures).toBe(1);
      expect(metrics.attemptsByOutcome['429']).toBe(1);
      expect(metrics.attemptsByOutcome['2xx']).toBe(1);
      expect(metrics.finalOutcomes['2xx']).toBe(1);
    });
  });

  test('isolates metrics for concurrent setup contexts', async () => {
    const [summaryMetrics, transferMetrics] = await Promise.all([
      runWithFplRequestMetrics(async () => {
        const request = beginFplLogicalRequest('https://fantasy.premierleague.com/api/entry/101/');
        await Promise.resolve();
        request.recordAttempt('2xx');
        request.finish();
        return getFplRequestMetricsSnapshot();
      }),
      runWithFplRequestMetrics(async () => {
        const request = beginFplLogicalRequest(
          'https://fantasy.premierleague.com/api/entry/202/transfers/',
        );
        request.recordAttempt('5xx');
        request.recordAttempt('network_error');
        request.finish();
        return getFplRequestMetricsSnapshot();
      }),
    ]);

    expect(summaryMetrics.byEndpoint.entry_summary).toBe(1);
    expect(summaryMetrics.byEndpoint.entry_transfers).toBe(0);
    expect(transferMetrics.byEndpoint.entry_summary).toBe(0);
    expect(transferMetrics.byEndpoint.entry_transfers).toBe(1);
    expect(transferMetrics.retries).toBe(1);
    expect(transferMetrics.finalOutcomes.network_error).toBe(1);
  });

  test('reuses a parent collector for nested reporting scopes', async () => {
    const metrics = await runWithFplRequestMetrics(async () => {
      const outer = beginFplLogicalRequest(
        'https://fantasy.premierleague.com/api/entry/101/history/',
      );
      outer.recordAttempt('2xx');
      outer.finish();

      await runWithFplRequestMetrics(async () => {
        const inner = beginFplLogicalRequest(
          'https://fantasy.premierleague.com/api/entry/101/transfers/',
        );
        inner.recordAttempt('2xx');
        inner.finish();
      });

      return getFplRequestMetricsSnapshot();
    });

    expect(metrics.logicalRequests).toBe(2);
    expect(metrics.byEndpoint.entry_history).toBe(1);
    expect(metrics.byEndpoint.entry_transfers).toBe(1);
  });

  test('records a repeated 5xx sequence as one failed logical request', async () => {
    process.env.FPL_RETRY_BASE_DELAY_MS = '0';
    process.env.FPL_RETRY_MAX_DELAY_MS = '0';
    globalThis.fetch = mock(
      async () => new Response('upstream unavailable', { status: 503 }),
    ) as unknown as typeof fetch;

    const metrics = await runWithFplRequestMetrics(async () => {
      await expect(fplClient.getFixtures(1)).rejects.toMatchObject({ status: 503 });
      return getFplRequestMetricsSnapshot();
    });

    expect(metrics.logicalRequests).toBe(1);
    expect(metrics.attempts).toBe(4);
    expect(metrics.retries).toBe(3);
    expect(metrics.attemptsByOutcome['5xx']).toBe(4);
    expect(metrics.finalOutcomes['5xx']).toBe(1);
  });

  test('separates timeout and network-error outcomes', async () => {
    process.env.FPL_RETRY_BASE_DELAY_MS = '0';
    process.env.FPL_RETRY_MAX_DELAY_MS = '0';
    process.env.FPL_REQUEST_DEADLINE_MS = '1000';

    globalThis.fetch = mock(async () => {
      const error = new Error('fixture timeout');
      error.name = 'TimeoutError';
      throw error;
    }) as unknown as typeof fetch;
    const timeoutMetrics = await runWithFplRequestMetrics(async () => {
      await expect(fplClient.getFixtures(1)).rejects.toThrow('Failed to fetch fixtures');
      return getFplRequestMetricsSnapshot();
    });

    globalThis.fetch = mock(async () => {
      throw new TypeError('fixture connection reset');
    }) as unknown as typeof fetch;
    const networkMetrics = await runWithFplRequestMetrics(async () => {
      await expect(fplClient.getFixtures(1)).rejects.toThrow('Failed to fetch fixtures');
      return getFplRequestMetricsSnapshot();
    });

    expect(timeoutMetrics.attemptsByOutcome.timeout).toBe(4);
    expect(timeoutMetrics.finalOutcomes.timeout).toBe(1);
    expect(networkMetrics.attemptsByOutcome.network_error).toBe(4);
    expect(networkMetrics.finalOutcomes.network_error).toBe(1);
  });
});
