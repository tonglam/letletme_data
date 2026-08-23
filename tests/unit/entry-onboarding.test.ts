import { describe, expect, mock, test } from 'bun:test';

import {
  runEntryOnboarding,
  type EntryOnboardingDependencies,
} from '../../src/services/entry-onboarding.service';
import type { MyFplSnapshotPublication } from '../../src/services/my-fpl-snapshot-publication.service';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

const activePublication = (
  kind: 'PROVISIONAL' | 'FINAL' = 'PROVISIONAL',
): MyFplSnapshotPublication => ({
  seasonId: TEST_SEASON.seasonId,
  eventId: 20,
  revision: 7,
  snapshotDate: '2026-08-23',
  sourceCheckedAt: new Date('2026-08-23T02:00:00.000Z'),
  publishedAt: new Date('2026-08-23T02:05:00.000Z'),
  kind,
  expectedEntryCount: 10,
  readyEntryCount: 10,
  emptyEntryCount: 0,
  expectedTournamentCount: 1,
  readyTournamentCount: 1,
  contentSha256: 'a'.repeat(64),
  overrideActor: null,
  overrideReason: null,
  idempotencyKey: null,
});

function createDependencies(
  options: {
    startedEvent?: number | null;
    active?: MyFplSnapshotPublication | null;
    failPhase?: number;
    finalizedResultEventIds?: readonly number[];
  } = {},
) {
  const calls: string[] = [];
  const entryInfoTargetEventIds: (number | undefined)[] = [];
  let phase = 0;
  const captureSnapshot = mock(async () => {
    calls.push('capture');
    return {
      status: 'published' as const,
      publication: { ...activePublication(), revision: 8, contentSha256: 'b'.repeat(64) },
    };
  });
  const dispatchOutbox = mock(async () => {
    calls.push('outbox');
    return { claimed: 1, delivered: 1, superseded: 0, failed: 0 };
  });
  const dependencies: EntryOnboardingDependencies = {
    runPhase: async (_runId, jobs) => {
      phase += 1;
      calls.push(`phase-${phase}-start`);
      if (options.failPhase === phase) throw new Error(`phase ${phase} failed`);
      const queued = await Promise.all(jobs);
      calls.push(`phase-${phase}-done`);
      return queued;
    },
    enqueueEntryInfo: async (_season, _source, jobOptions) => {
      calls.push('enqueue-info');
      entryInfoTargetEventIds.push(jobOptions.eventId);
      return { id: jobOptions.jobId };
    },
    enqueueEntryPicks: async (_season, _source, jobOptions) => {
      calls.push('enqueue-picks');
      return { id: jobOptions.jobId };
    },
    enqueueEntryResults: async (_season, _source, jobOptions) => {
      calls.push('enqueue-results');
      return { id: jobOptions.jobId };
    },
    enqueueEntryTransfers: async (_season, _source, jobOptions) => {
      calls.push('enqueue-transfers');
      return { id: jobOptions.jobId };
    },
    findEntry: async (_season, entryId) => {
      calls.push('find-entry');
      return { id: entryId, startedEvent: options.startedEvent ?? 1 };
    },
    listFinalizedResultEventIds: async () => {
      calls.push('list-finalized-results');
      return options.finalizedResultEventIds ?? [];
    },
    getActivePublication: async () => {
      calls.push('active-publication');
      return options.active === undefined ? activePublication() : options.active;
    },
    captureSnapshot,
    dispatchOutbox,
  };
  return { calls, entryInfoTargetEventIds, dependencies, captureSnapshot, dispatchOutbox };
}

describe('entry onboarding coordinator', () => {
  test('waits for parent creation before event jobs and publishes only after the second barrier', async () => {
    const { calls, entryInfoTargetEventIds, dependencies } = createDependencies();

    const result = await runEntryOnboarding(
      TEST_SEASON,
      {
        entryId: 42,
        eventId: 20,
        entryInfoTargetEventId: 19,
        attemptKey: 'attempt-a1',
      },
      dependencies,
    );

    expect(calls).toEqual([
      'enqueue-info',
      'phase-1-start',
      'phase-1-done',
      'find-entry',
      'list-finalized-results',
      'enqueue-picks',
      'enqueue-results',
      'enqueue-transfers',
      'phase-2-start',
      'phase-2-done',
      'active-publication',
      'capture',
      'outbox',
    ]);
    expect(entryInfoTargetEventIds).toEqual([19]);
    expect(result).toMatchObject({
      eventId: 20,
      stages: {
        eventDataStatus: 'completed',
        picksJobId: 'entry-onboarding-attempt-a1-entry-picks-e20-42',
        resultsJobIds: ['entry-onboarding-attempt-a1-entry-results-e20-42'],
        transfersJobId: 'entry-onboarding-attempt-a1-entry-transfers-e20-42',
      },
      snapshot: { status: 'published', revision: 8, contentSha256: 'b'.repeat(64) },
    });
  });

  test('syncs only entry info before the first deadline', async () => {
    const { calls, dependencies, captureSnapshot } = createDependencies();

    const result = await runEntryOnboarding(
      TEST_SEASON,
      { entryId: 42, entryInfoTargetEventId: 0, attemptKey: 'preseason-a1' },
      dependencies,
    );

    expect(calls).toEqual(['enqueue-info', 'phase-1-start', 'phase-1-done', 'find-entry']);
    expect(result).toMatchObject({
      eventId: null,
      stages: { eventDataStatus: 'skipped', eventDataSkipReason: 'PRESEASON' },
      snapshot: { status: 'skipped', reason: 'PRESEASON' },
    });
    expect(captureSnapshot).not.toHaveBeenCalled();
  });

  test('publishes a late-starting entry as EMPTY without event child jobs', async () => {
    const { calls, dependencies } = createDependencies({ startedEvent: 21 });

    const result = await runEntryOnboarding(
      TEST_SEASON,
      { entryId: 42, eventId: 20, entryInfoTargetEventId: 19, attemptKey: 'late-a1' },
      dependencies,
    );

    expect(calls).not.toContain('enqueue-picks');
    expect(calls).not.toContain('enqueue-results');
    expect(calls).not.toContain('enqueue-transfers');
    expect(calls).toContain('capture');
    expect(result).toMatchObject({
      stages: { eventDataStatus: 'skipped', eventDataSkipReason: 'NOT_STARTED' },
      snapshot: { status: 'published' },
    });
  });

  test('backfills rich results from startedEvent through the current event before capture', async () => {
    const { calls, dependencies } = createDependencies({
      startedEvent: 18,
      finalizedResultEventIds: [18, 19],
    });

    const result = await runEntryOnboarding(
      TEST_SEASON,
      {
        entryId: 42,
        eventId: 20,
        entryInfoTargetEventId: 19,
        attemptKey: 'midseason-a1',
      },
      dependencies,
    );

    expect(calls.filter((call) => call === 'enqueue-results')).toHaveLength(3);
    expect(calls.indexOf('phase-2-done')).toBeLessThan(calls.indexOf('capture'));
    expect(result.stages.resultsJobIds).toEqual([
      'entry-onboarding-midseason-a1-entry-results-e18-42',
      'entry-onboarding-midseason-a1-entry-results-e19-42',
      'entry-onboarding-midseason-a1-entry-results-e20-42',
    ]);
  });

  test('leaves FINAL immutable after completing required entry data', async () => {
    const { dependencies, captureSnapshot, dispatchOutbox } = createDependencies({
      active: activePublication('FINAL'),
    });

    const result = await runEntryOnboarding(
      TEST_SEASON,
      { entryId: 42, eventId: 20, entryInfoTargetEventId: 20, attemptKey: 'final-a1' },
      dependencies,
    );

    expect(result.snapshot).toEqual({
      status: 'skipped',
      reason: 'IMMUTABLE_FINAL',
      revision: 7,
      contentSha256: 'a'.repeat(64),
    });
    expect(captureSnapshot).not.toHaveBeenCalled();
    expect(dispatchOutbox).not.toHaveBeenCalled();
  });

  test('propagates child barrier failure without capturing or publishing', async () => {
    const { dependencies, captureSnapshot, dispatchOutbox } = createDependencies({ failPhase: 2 });

    await expect(
      runEntryOnboarding(
        TEST_SEASON,
        {
          entryId: 42,
          eventId: 20,
          entryInfoTargetEventId: 19,
          attemptKey: 'failure-a1',
        },
        dependencies,
      ),
    ).rejects.toThrow('phase 2 failed');
    expect(captureSnapshot).not.toHaveBeenCalled();
    expect(dispatchOutbox).not.toHaveBeenCalled();
  });

  test('uses distinct child IDs for each parent attempt', async () => {
    const first = createDependencies({ active: null });
    const second = createDependencies({ active: null });

    const firstResult = await runEntryOnboarding(
      TEST_SEASON,
      { entryId: 42, eventId: 20, entryInfoTargetEventId: 19, attemptKey: 'parent-a1' },
      first.dependencies,
    );
    const secondResult = await runEntryOnboarding(
      TEST_SEASON,
      { entryId: 42, eventId: 20, entryInfoTargetEventId: 19, attemptKey: 'parent-a2' },
      second.dependencies,
    );

    expect(firstResult.stages.entryInfoJobId).not.toBe(secondResult.stages.entryInfoJobId);
    expect(firstResult.stages.picksJobId).not.toBe(secondResult.stages.picksJobId);
    expect(firstResult.snapshot).toMatchObject({ status: 'skipped', reason: 'NO_PUBLICATION' });
  });
});
