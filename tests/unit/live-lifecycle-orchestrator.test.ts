import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  decideLiveLifecycle,
  PICKS_FIRST_PROBE_OFFSET_MS,
  resolveLivePicksCoordinatorDeduplicationId,
  resolveLivePicksEntryDeduplicationId,
  resolveLivePicksRefreshFanout,
  resolveLiveLifecycleDelay,
  shouldPersistLiveLifecycleStatus,
  shouldRefreshOfficialH2H,
} from '../../src/services/live-lifecycle-orchestrator';

describe('live lifecycle decisions', () => {
  test('does not write a PostgreSQL heartbeat for every live publication', () => {
    const base = {
      state: 'LIVE_ACTIVE' as const,
      generation: 9,
      publicationId: 'publication-9',
    };
    expect(shouldPersistLiveLifecycleStatus({ persisted: null, ...base })).toBe(true);
    expect(shouldPersistLiveLifecycleStatus({ persisted: base, ...base })).toBe(false);
    expect(
      shouldPersistLiveLifecycleStatus({
        persisted: base,
        ...base,
        generation: 10,
        publicationId: 'publication-10',
      }),
    ).toBe(false);
    expect(
      shouldPersistLiveLifecycleStatus({
        persisted: base,
        state: 'DAY_SETTLING',
        generation: 10,
        publicationId: 'publication-10',
      }),
    ).toBe(true);
  });

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
    expect(workerSource).not.toContain('live-picks-compatibility');
    expect(workerSource).not.toContain('LIVE_PICKS_COMPATIBILITY_BUCKET_MS');
    expect(workerSource).not.toContain('QueueDrainOnlyError');
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

  test('starts the first picks probe immediately after the deadline', () => {
    expect(PICKS_FIRST_PROBE_OFFSET_MS).toBe(1_000);

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

    expect(decideLiveLifecycle(event, fixtures, new Date('2026-08-15T10:00:00.999Z')).state).toBe(
      'PICKS_WAIT',
    );
    expect(decideLiveLifecycle(event, fixtures, new Date('2026-08-15T10:00:01.000Z')).state).toBe(
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

  test('uses an independent per-entry single-flight identity', () => {
    const first = resolveLivePicksEntryDeduplicationId('2627', 1, 30);
    const sameEntry = resolveLivePicksEntryDeduplicationId('2627', 1, 30);
    const anotherEntry = resolveLivePicksEntryDeduplicationId('2627', 1, 31);
    const nextEvent = resolveLivePicksEntryDeduplicationId('2627', 2, 30);

    expect(first).toBe('live-picks-entry:2627:event-1:entry-30');
    expect(first).not.toBe(resolveLivePicksCoordinatorDeduplicationId('2627', 1));
    expect(sameEntry).toBe(first);
    expect(anotherEntry).not.toBe(first);
    expect(nextEvent).not.toBe(first);
  });

  test('keeps the pending entry set stable across a scheduler restart', () => {
    const established = resolveLivePicksRefreshFanout('2627', 1, [10, 20, 30, 40], []);
    const restarted = resolveLivePicksRefreshFanout('2627', 1, [10, 20, 30, 40], [10, 20]);

    expect(established.entryIds).toEqual([10, 20, 30, 40]);
    expect(restarted.entryIds).toEqual([30, 40]);
  });

  test('does not fan out entries that were accepted as canaries', () => {
    const fanout = resolveLivePicksRefreshFanout('2627', 1, [10, 20, 30, 40], [10, 20]);
    expect(fanout.entryIds).toEqual([30, 40]);
  });
});
