import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

import {
  inferDataSyncWorkSummary,
  resolveBullMqAttemptQueueWaitMs,
  resolveDataSyncAttempt,
  runDataSyncAttempt,
  type DataSyncAttemptContext,
  type DataSyncAttemptReport,
} from '../../src/utils/data-sync-attempt';
import { beginFplLogicalRequest } from '../../src/utils/fpl-request-metrics';
import { logger } from '../../src/utils/logger';

afterEach(() => {
  mock.restore();
  delete process.env.DATA_SYNC_ATTEMPT_REPORTING_ENABLED;
});

function reportsFrom(spy: { mock: { calls: unknown[][] } }): DataSyncAttemptReport[] {
  return spy.mock.calls
    .map((call) => call[0] as DataSyncAttemptReport)
    .filter((payload) => payload?.event === 'data_sync_attempt');
}

describe('data sync attempt reporting', () => {
  test('accounts for delayed retries that reset BullMQ attemptsMade', () => {
    expect(resolveDataSyncAttempt('cron', 0, 2)).toEqual({ attempt: 3, source: 'retry' });
    expect(resolveDataSyncAttempt('cron', 2, 2)).toEqual({ attempt: 5, source: 'retry' });
    expect(resolveDataSyncAttempt('cron', 1)).toEqual({ attempt: 2, source: 'retry' });
    expect(resolveDataSyncAttempt('cron', 0)).toEqual({ attempt: 1, source: 'cron' });
  });

  test('does not include earlier attempts in BullMQ retry queue wait', () => {
    expect(
      resolveBullMqAttemptQueueWaitMs(
        { timestamp: 1_000, processedOn: 1_250, attemptsMade: 0 },
        1_251,
      ),
    ).toBe(250);
    expect(
      resolveBullMqAttemptQueueWaitMs(
        { timestamp: 1_000, processedOn: 8_000, attemptsMade: 2 },
        8_004,
      ),
    ).toBe(4);
  });

  test('excludes an explicitly scheduled retry delay from queue wait', () => {
    expect(
      resolveBullMqAttemptQueueWaitMs(
        { timestamp: 1_000, processedOn: 601_250, attemptsMade: 0, delay: 600_000 },
        601_251,
      ),
    ).toBe(250);
  });

  test('normalizes the result shapes returned by core and entry sync services', () => {
    expect(inferDataSyncWorkSummary({ count: 20, errors: 2 })).toEqual({
      requiredUnits: 22,
      reusedUnits: 0,
      succeededUnits: 20,
      failedUnits: 2,
    });
    expect(inferDataSyncWorkSummary({ totalCount: 38, totalErrors: 2 })).toEqual({
      requiredUnits: 40,
      reusedUnits: 0,
      succeededUnits: 38,
      failedUnits: 2,
    });
    expect(inferDataSyncWorkSummary({ totalEntries: 75, synced: 70, errors: 5 })).toEqual({
      requiredUnits: 75,
      reusedUnits: 0,
      succeededUnits: 70,
      failedUnits: 5,
    });
    expect(inferDataSyncWorkSummary({ totalEntries: 75, updated: 70, skipped: 5 })).toEqual({
      requiredUnits: 75,
      reusedUnits: 5,
      succeededUnits: 70,
      failedUnits: 0,
    });
    expect(inferDataSyncWorkSummary({ enqueued: 12 })).toEqual({
      requiredUnits: 12,
      reusedUnits: 0,
      succeededUnits: 12,
      failedUnits: 0,
    });
    expect(inferDataSyncWorkSummary({ count: 0, outcome: 'noop' })).toEqual({
      outcome: 'noop',
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
    });
    expect(
      inferDataSyncWorkSummary({
        totalEntries: 75,
        updated: 70,
        skipped: 5,
        requiredUnits: 75,
        reusedUnits: 0,
        succeededUnits: 70,
        failedUnits: 5,
      }),
    ).toEqual({
      requiredUnits: 75,
      reusedUnits: 0,
      succeededUnits: 70,
      failedUnits: 5,
    });
  });

  test('emits one bounded report with inferred work and FPL metrics', async () => {
    const infoSpy = spyOn(logger, 'info').mockImplementation(() => undefined as never);

    await runDataSyncAttempt(
      {
        queue: 'entry-sync',
        jobName: 'entry-picks',
        runId: 'run-1',
        source: 'cron',
        targetEventId: 7,
        queueWaitMs: 15.9,
      },
      async () => {
        const request = beginFplLogicalRequest(
          'https://fantasy.premierleague.com/api/entry/123/event/7/picks/',
        );
        request.recordAttempt('429');
        request.recordAttempt('2xx');
        request.finish();
        return { total: 2, success: 1, failed: 1, reusedUnits: 3 };
      },
    );

    const reports = reportsFrom(infoSpy);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      event: 'data_sync_attempt',
      schemaVersion: 1,
      queue: 'entry-sync',
      jobName: 'entry-picks',
      runId: 'run-1',
      source: 'cron',
      attempt: 1,
      targetEventId: 7,
      outcome: 'partial',
      queueWaitMs: 15,
      requiredUnits: 2,
      reusedUnits: 3,
      succeededUnits: 1,
      failedUnits: 1,
      fpl: {
        logicalRequests: 1,
        attempts: 2,
        retries: 1,
        byEndpoint: { entry_picks: 1 },
        attemptsByOutcome: { '429': 1, '2xx': 1 },
        finalOutcomes: { '2xx': 1 },
      },
    });
    expect(JSON.stringify(reports[0])).not.toContain('fantasy.premierleague.com');
    expect(JSON.stringify(reports[0])).not.toContain('/entry/123/');
  });

  test('emits once on failure and rethrows the original error', async () => {
    const infoSpy = spyOn(logger, 'info').mockImplementation(() => undefined as never);

    await expect(
      runDataSyncAttempt(
        {
          queue: 'data-sync',
          jobName: 'teams',
          runId: 'run-failed',
          source: 'api',
          attempt: 2,
        },
        async () => {
          throw new Error('upstream payload contained a private name');
        },
      ),
    ).rejects.toThrow('upstream payload contained a private name');

    const reports = reportsFrom(infoSpy);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      runId: 'run-failed',
      source: 'retry',
      attempt: 2,
      outcome: 'failed',
      failedUnits: 0,
    });
    expect(JSON.stringify(reports[0])).not.toContain('private name');
  });

  test('keeps first-attempt API traffic distinct from operator manual traffic', async () => {
    const infoSpy = spyOn(logger, 'info').mockImplementation(() => undefined as never);

    await runDataSyncAttempt(
      {
        queue: 'data-sync',
        jobName: 'teams',
        runId: 'api-run',
        source: 'api',
      },
      async () => ({ count: 20, errors: 0 }),
    );

    expect(reportsFrom(infoSpy)[0]?.source).toBe('api');
  });

  test('records a target event resolved by an unscoped sync result', async () => {
    const infoSpy = spyOn(logger, 'info').mockImplementation(() => undefined as never);

    await runDataSyncAttempt(
      {
        queue: 'data-sync',
        jobName: 'player-stats',
        runId: 'current-player-stats',
        source: 'cron',
      },
      async () => ({ count: 700, errors: 0, eventId: 12 }),
    );

    expect(reportsFrom(infoSpy)[0]).toMatchObject({
      jobName: 'player-stats',
      targetEventId: 12,
    });
  });

  test('records a target resolved inside an unscoped attempt, including failures', async () => {
    const infoSpy = spyOn(logger, 'info').mockImplementation(() => undefined as never);
    const context: DataSyncAttemptContext = {
      queue: 'entry-sync',
      jobName: 'entry-results',
      runId: 'current-entry-results',
      source: 'cron' as const,
    };

    await expect(
      runDataSyncAttempt(context, async () => {
        context.targetEventId = 13;
        throw new Error('entry result failed after event resolution');
      }),
    ).rejects.toThrow('entry result failed after event resolution');

    expect(reportsFrom(infoSpy)[0]).toMatchObject({
      jobName: 'entry-results',
      targetEventId: 13,
      outcome: 'failed',
    });
  });

  test('isolates concurrent top-level attempt metrics', async () => {
    const infoSpy = spyOn(logger, 'info').mockImplementation(() => undefined as never);

    await Promise.all([
      runDataSyncAttempt(
        { queue: 'data-sync', jobName: 'fixtures', runId: 'fixtures-run', source: 'cron' },
        async () => {
          const request = beginFplLogicalRequest('https://fantasy.premierleague.com/api/fixtures/');
          await Promise.resolve();
          request.recordAttempt('2xx');
          request.finish();
          return { total: 1, success: 1 };
        },
      ),
      runDataSyncAttempt(
        {
          queue: 'entry-sync',
          jobName: 'entry-transfers',
          runId: 'transfers-run',
          source: 'manual',
        },
        async () => {
          const request = beginFplLogicalRequest(
            'https://fantasy.premierleague.com/api/entry/456/transfers/',
          );
          request.recordAttempt('5xx');
          request.finish();
          return { total: 1, failed: 1 };
        },
      ),
    ]);

    const reports = reportsFrom(infoSpy);
    expect(reports).toHaveLength(2);
    const fixtures = reports.find((report) => report.runId === 'fixtures-run');
    const transfers = reports.find((report) => report.runId === 'transfers-run');
    expect(fixtures?.fpl.byEndpoint.fixtures).toBe(1);
    expect(fixtures?.fpl.byEndpoint.entry_transfers).toBe(0);
    expect(transfers?.fpl.byEndpoint.fixtures).toBe(0);
    expect(transfers?.fpl.byEndpoint.entry_transfers).toBe(1);
  });

  test('can be disabled without creating a metrics context or report', async () => {
    process.env.DATA_SYNC_ATTEMPT_REPORTING_ENABLED = 'false';
    const infoSpy = spyOn(logger, 'info').mockImplementation(() => undefined as never);

    const value = await runDataSyncAttempt(
      { queue: 'data-sync', jobName: 'events', runId: 'disabled', source: 'cron' },
      async () => 'ok',
    );

    expect(value).toBe('ok');
    expect(reportsFrom(infoSpy)).toHaveLength(0);
  });
});
