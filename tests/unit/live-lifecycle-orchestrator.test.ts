import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  decideLiveLifecycle,
  findPicksRefreshEntryIds,
  PICKS_FIRST_PROBE_OFFSET_MS,
  PICKS_REFRESH_INTERVAL_MS,
  resolveLivePicksCoordinatorDeduplicationId,
  resolveLivePicksRefreshClaimedAt,
  resolveLivePicksRefreshDeduplicationId,
  resolveLivePicksRefreshFanout,
  resolveLiveLifecycleDelay,
  shouldRefreshOfficialH2H,
} from '../../src/services/live-lifecycle-orchestrator';

describe('live lifecycle decisions', () => {
  test('standalone scheduler persists lifecycle independently of live publications', () => {
    const source = readFileSync('src/scheduler.ts', 'utf8');
    expect(source).toContain('runIndependentSchedulerStage');
    expect(source).toContain('DATA_GOVERNANCE_JOBS.LIFECYCLE_STATUS');
    expect(source).toContain('DATA_GOVERNANCE_JOBS.PUBLICATION_RECONCILE');
    expect(source).toContain('MAINTENANCE_JOBS.DATA_PUBLICATION_OUTBOX');
    expect(source).toContain('deduplicationId: `governance-lifecycle-');
    expect(source).not.toContain('persistLiveLifecycleStatus(');
    expect(source).not.toContain('reconcileCoreAndMarketPublications(');
    expect(source).not.toContain('dispatchDataPublicationOutbox(');
    expect(source).not.toContain('runPicksProbeAndSync(');
    const workerSource = readFileSync('src/workers/data-governance.worker.ts', 'utf8');
    expect(workerSource).toContain('persistLiveLifecycleStatus(new Date())');
    expect(workerSource).toContain('enqueueLivePicksRefresh(tick.season, tick.currentEvent.id');
    expect(workerSource).toContain('LIVE_PICKS_COMPATIBILITY_BUCKET_MS');
    expect(workerSource).toContain('QueueDrainOnlyError');
    const maintenanceSource = readFileSync('src/jobs/maintenance.jobs.ts', 'utf8');
    expect(maintenanceSource).toContain('isPublicationOutbox');
    const maintenanceWorkerSource = readFileSync('src/workers/maintenance.worker.ts', 'utf8');
    expect(maintenanceWorkerSource).toMatch(/\['maintenance', 'publication-outbox'\]/);
    const lifecycleRepositorySource = readFileSync('src/repositories/live-window.ts', 'utf8');
    expect(lifecycleRepositorySource).toContain('excluded.observed_at');
    const registrySource = readFileSync('src/scheduler/job-registry.ts', 'utf8');
    expect(registrySource).toContain('const decision = decideLiveLifecycle(event, fixtures');
    expect(registrySource).toContain('decision.state ===');
    expect(registrySource).toContain('FINALIZED');
    expect(registrySource).toContain('resolveLiveLifecycleDelay(');
  });

  test('carries a freshness window from the live-picks root into its child scan', () => {
    const jobSource = readFileSync('src/jobs/live-picks.jobs.ts', 'utf8');
    const enqueueSource = readFileSync('src/services/live-lifecycle-orchestrator.ts', 'utf8');
    expect(jobSource).toContain('freshnessWindowId: job.freshnessWindowId');
    expect(enqueueSource).toContain('freshnessWindowId: obligation.freshnessWindowId');
    expect(readFileSync('src/jobs/entry-sync-enqueue.ts', 'utf8')).toContain(
      'freshnessWindowId: options?.freshnessWindowId',
    );
  });

  test('starts the first picks probe 60 minutes after the deadline', () => {
    expect(PICKS_FIRST_PROBE_OFFSET_MS).toBe(60 * 60_000);

    const event = {
      deadlineTime: '2026-08-15T10:00:00.000Z',
      finished: false,
      dataChecked: false,
    };
    const fixtures = [
      {
        started: false,
        finished: false,
        finishedProvisional: false,
        kickoffTime: new Date('2026-08-15T12:00:00.000Z'),
      },
    ];

    expect(decideLiveLifecycle(event, fixtures, new Date('2026-08-15T10:59:59.999Z')).state).toBe(
      'PICKS_WAIT',
    );
    expect(decideLiveLifecycle(event, fixtures, new Date('2026-08-15T11:00:00.000Z')).state).toBe(
      'PICKS_PROBE',
    );
  });

  test('does not start live polling from a scheduled kickoff alone', () => {
    const decision = decideLiveLifecycle(
      { deadlineTime: '2026-08-15T10:00:00.000Z', finished: false, dataChecked: false },
      [
        {
          started: false,
          finished: false,
          finishedProvisional: false,
          kickoffTime: new Date('2026-08-15T12:00:00.000Z'),
        },
      ],
      new Date('2026-08-15T12:00:01.000Z'),
    );

    expect(decision).toMatchObject({
      state: 'PICKS_SYNC',
      shouldFetchLive: true,
      shouldProbePicks: true,
      shouldSyncPicks: true,
      recoverStaleFixtures: false,
      finalizeEvent: false,
    });
  });

  test('accepts a valid live publication as lifecycle evidence before core flags catch up', () => {
    const decision = decideLiveLifecycle(
      { deadlineTime: '2026-08-15T10:00:00.000Z', finished: false, dataChecked: false },
      [
        {
          started: false,
          finished: false,
          finishedProvisional: false,
          kickoffTime: new Date('2026-08-15T12:00:00.000Z'),
        },
      ],
      new Date('2026-08-15T12:00:01.000Z'),
      { publicationActive: true, publicationStarted: true },
    );

    expect(decision).toMatchObject({
      state: 'LIVE_ACTIVE',
      shouldFetchLive: true,
      shouldSyncPicks: true,
    });
  });

  test('enters between fixtures after a quiet revision and keeps the next fixture scheduled', () => {
    const decision = decideLiveLifecycle(
      { deadlineTime: '2026-08-15T10:00:00.000Z', finished: false, dataChecked: false },
      [
        {
          started: true,
          finished: true,
          finishedProvisional: false,
          kickoffTime: new Date('2026-08-15T12:00:00.000Z'),
        },
        {
          started: false,
          finished: false,
          finishedProvisional: false,
          kickoffTime: new Date('2026-08-15T19:00:00.000Z'),
        },
      ],
      new Date('2026-08-15T18:15:00.000Z'),
      { unchangedSince: new Date('2026-08-15T18:00:00.000Z').getTime() - 10 * 60_000 },
    );

    expect(decision).toMatchObject({
      state: 'BETWEEN_FIXTURES',
      shouldFetchLive: true,
      shouldSyncPicks: true,
    });
  });

  test('does not let stale unfinished flags or a last-good publication keep live active', () => {
    const decision = decideLiveLifecycle(
      { deadlineTime: '2026-08-15T10:00:00.000Z', finished: false, dataChecked: false },
      [
        {
          started: true,
          finished: false,
          finishedProvisional: false,
          kickoffTime: new Date('2026-08-15T12:00:00.000Z'),
        },
        {
          started: false,
          finished: false,
          finishedProvisional: false,
          kickoffTime: new Date('2026-08-15T19:00:00.000Z'),
        },
      ],
      new Date('2026-08-15T18:15:00.000Z'),
      {
        matchDayTime: false,
        publicationActive: true,
        publicationStarted: true,
        unchangedSince: new Date('2026-08-15T12:30:00.000Z').getTime(),
      },
    );

    expect(decision).toMatchObject({
      state: 'BETWEEN_FIXTURES',
      shouldFetchLive: true,
      shouldSyncPicks: true,
    });
  });

  test('requests a final durable snapshot before entering finalized state', () => {
    const decision = decideLiveLifecycle(
      { deadlineTime: '2026-08-15T10:00:00.000Z', finished: true, dataChecked: true },
      [
        {
          started: true,
          finished: true,
          finishedProvisional: true,
          kickoffTime: new Date('2026-08-15T12:00:00.000Z'),
        },
      ],
      new Date('2026-08-16T12:00:01.000Z'),
    );

    expect(decision).toMatchObject({
      state: 'FINALIZED',
      shouldFetchLive: true,
      shouldSyncPicks: false,
      finalizeEvent: true,
    });
    expect(shouldRefreshOfficialH2H(decision, true)).toBe(false);
  });

  test('keeps an unfinalized event in GW_REVIEW after the quiet polling window', () => {
    const decision = decideLiveLifecycle(
      { deadlineTime: '2026-08-15T10:00:00.000Z', finished: false, dataChecked: false },
      [
        {
          started: true,
          finished: true,
          finishedProvisional: false,
          kickoffTime: new Date('2026-08-15T12:00:00.000Z'),
        },
      ],
      new Date('2026-08-17T12:00:01.000Z'),
    );

    expect(decision).toMatchObject({
      state: 'GW_REVIEW',
      shouldFetchLive: true,
      shouldSyncPicks: true,
      finalizeEvent: false,
    });
    expect(shouldRefreshOfficialH2H(decision, false)).toBe(true);
    expect(
      resolveLiveLifecycleDelay(
        decision,
        { seasonId: 1, seasonCode: '2627' },
        1,
        new Date('2026-08-17T12:00:01.000Z'),
      ),
    ).toBe(10 * 60_000);
  });

  test('refreshes complete picks again after the bounded live interval', () => {
    const now = Date.parse('2026-08-24T01:00:00.000Z');
    const claims = new Map([
      [1, now - PICKS_REFRESH_INTERVAL_MS + 1],
      [2, now - PICKS_REFRESH_INTERVAL_MS],
    ]);

    expect(findPicksRefreshEntryIds([1, 2, 3], claims, now)).toEqual([2, 3]);
  });

  test('uses a restart-durable fan-out identity distinct from the coordinator', () => {
    const first = resolveLivePicksRefreshDeduplicationId('2627', 1, [30, 10, 20]);
    const reordered = resolveLivePicksRefreshDeduplicationId('2627', 1, [20, 10, 30, 20]);
    const expanded = resolveLivePicksRefreshDeduplicationId('2627', 1, [10, 20, 30, 40]);
    const nextEvent = resolveLivePicksRefreshDeduplicationId('2627', 2, [10, 20, 30]);

    expect(first).toBe('live-picks-entry-sweep:2627:event-1');
    expect(first).not.toBe(resolveLivePicksCoordinatorDeduplicationId('2627', 1));
    expect(reordered).toBe(first);
    expect(expanded).toBe(first);
    expect(nextEvent).not.toBe(first);
  });

  test('keeps the pre-canary cohort identity stable across a scheduler restart', () => {
    const established = resolveLivePicksRefreshFanout('2627', 1, [10, 20, 30, 40], []);
    const restarted = resolveLivePicksRefreshFanout('2627', 1, [10, 20, 30, 40], [10, 20]);

    expect(restarted.deduplicationId).toBe(established.deduplicationId);
    expect(established.entryIds).toEqual([10, 20, 30, 40]);
    expect(restarted.entryIds).toEqual([30, 40]);
  });

  test('preserves a returned job claim time without extending the refresh interval', () => {
    const now = Date.parse('2026-08-25T10:00:00.000Z');
    const nineMinutesAgo = new Date(now - 9 * 60_000).toISOString();

    expect(resolveLivePicksRefreshClaimedAt(nineMinutesAgo, now)).toBe(now - 9 * 60_000);
    expect(resolveLivePicksRefreshClaimedAt('invalid', now)).toBe(now);
    expect(resolveLivePicksRefreshClaimedAt(new Date(now + 60_000).toISOString(), now)).toBe(now);
    expect(resolveLivePicksRefreshClaimedAt(new Date(now - 20 * 60_000).toISOString(), now)).toBe(
      now - PICKS_REFRESH_INTERVAL_MS,
    );
  });
});
