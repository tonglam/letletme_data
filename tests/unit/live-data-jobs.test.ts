import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { TEST_SEASON } from '../fixtures/seasons.fixtures';

type AddCall = { name: string; data: Record<string, unknown>; opts: Record<string, unknown> };

const addCalls: AddCall[] = [];
const waitingJobs: Array<{
  id?: string;
  state?: 'waiting' | 'delayed' | 'active' | 'paused';
  name: string;
  data: {
    seasonId: number;
    eventId: number;
    finalizeEvent?: boolean;
    matchObservationOnly?: boolean;
    promoteActiveEvent?: boolean;
    checkpointKind?: 'desk' | 'detail';
    source?: string;
    obligationId?: string;
    obligationGeneration?: number;
  };
}> = [];
const existingJobIds = new Set<string>();

mock.module('../../src/queues/live-data.queue', () => ({
  LIVE_JOBS: {
    LIVE_SNAPSHOT: 'live-snapshot',
    LIVE_MATCH_CHECKPOINT: 'live-match-checkpoint',
    LIVE_FINAL_RETENTION: 'live-final-retention',
  },
  liveDataQueue: {
    name: 'live-data',
    add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
      addCalls.push({ name, data, opts });
      const job = {
        id: (opts.jobId as string | undefined) ?? 'generated-id',
        name,
        data: data as (typeof waitingJobs)[number]['data'],
        state: opts.delay ? ('delayed' as const) : ('waiting' as const),
      };
      waitingJobs.push(job);
      return job;
    },
    getJob: async (jobId: string) => {
      const pending = waitingJobs.find((job) => job.id === jobId);
      if (pending) return { ...pending, getState: async () => pending.state ?? 'waiting' };
      return existingJobIds.has(jobId) ? { id: jobId, getState: async () => 'completed' } : null;
    },
    getJobs: async (states: string[]) =>
      waitingJobs.filter((job) => states.includes(job.state ?? 'waiting')),
  },
}));

const {
  enqueueLiveActiveSnapshot,
  enqueueLiveMatchCheckpoint,
  enqueueLiveSnapshot,
  enqueueLiveFinalRetention,
  liveSnapshotMinuteBucket,
} = await import('../../src/jobs/live-data.jobs');

describe('Live Points V2 snapshot enqueue', () => {
  beforeEach(() => {
    addCalls.length = 0;
    waitingJobs.length = 0;
    existingJobIds.clear();
  });

  test('uses one V2 job contract and never carries the removed persistence flag', async () => {
    const job = await enqueueLiveSnapshot(TEST_SEASON, 12, 'manual', { finalizeEvent: true });

    expect(job!.id).toBe('live-snapshot-2627-e12-manual-v2');
    expect(addCalls[0]).toMatchObject({
      name: 'live-snapshot',
      data: {
        seasonId: 2026,
        seasonCode: '2627',
        eventId: 12,
        source: 'manual',
        finalizeEvent: true,
      },
    });
    expect(addCalls[0]?.data).not.toHaveProperty('persistEventLives');
  });

  test('suppresses a cron duplicate for the same season, event, and finalization level', async () => {
    waitingJobs.push({
      name: 'live-snapshot',
      data: { seasonId: TEST_SEASON.seasonId, eventId: 12 },
    });

    await expect(enqueueLiveSnapshot(TEST_SEASON, 12, 'cron')).resolves.toBeNull();
    expect(addCalls).toHaveLength(0);
  });

  test('does not let an ordinary job suppress finalization', async () => {
    waitingJobs.push({
      name: 'live-snapshot',
      data: { seasonId: TEST_SEASON.seasonId, eventId: 12 },
    });

    const job = await enqueueLiveSnapshot(TEST_SEASON, 12, 'cron', { finalizeEvent: true });

    expect(job).not.toBeNull();
    expect(addCalls[0]?.data.finalizeEvent).toBe(true);
  });

  test('keeps Match-only observations independent from full Live Points jobs', async () => {
    waitingJobs.push({
      name: 'live-snapshot',
      data: { seasonId: TEST_SEASON.seasonId, eventId: 12, matchObservationOnly: true },
    });

    const full = await enqueueLiveSnapshot(TEST_SEASON, 12, 'cron');
    expect(full).not.toBeNull();
    expect(full?.id).toContain('-v2');
  });

  test('coalesces a pending Match-only observation without blocking another Match-only tick', async () => {
    waitingJobs.push({
      name: 'live-snapshot',
      data: { seasonId: TEST_SEASON.seasonId, eventId: 12, matchObservationOnly: true },
    });

    await expect(
      enqueueLiveSnapshot(TEST_SEASON, 12, 'cron', { matchObservationOnly: true }),
    ).resolves.toBeNull();
    expect(addCalls).toHaveLength(0);
  });

  test('uses a deterministic 30-second identity bucket while publication cadence stays in V2', async () => {
    const now = new Date('2026-08-09T12:34:56.000Z');
    expect(liveSnapshotMinuteBucket(now)).toBe('20260809123430');

    const job = await enqueueLiveSnapshot(TEST_SEASON, 12, 'cron', { now });
    expect(job?.id).toBe('live-snapshot-2627-e12-20260809123430-v2');
    expect(addCalls[0]?.data).not.toHaveProperty('persistEventLives');
  });

  test('marks a Match-only scheduler job with the V3 identity', async () => {
    const now = new Date('2026-08-09T12:34:56.000Z');
    const job = await enqueueLiveSnapshot(TEST_SEASON, 12, 'cron', {
      now,
      matchObservationOnly: true,
    });
    expect(job?.id).toBe('live-snapshot-2627-e12-20260809123430-v3');
    expect(addCalls[0]?.data).toMatchObject({ matchObservationOnly: true });
  });

  test('carries active-event promotion intent through a post-deadline Match-only job', async () => {
    const now = new Date('2026-08-09T12:34:56.000Z');
    const job = await enqueueLiveSnapshot(TEST_SEASON, 12, 'cron', {
      now,
      matchObservationOnly: true,
      promoteActiveEvent: true,
    });
    expect(job?.id).toBe('live-snapshot-2627-e12-20260809123430-v3');
    expect(addCalls[0]?.data).toMatchObject({
      matchObservationOnly: true,
      promoteActiveEvent: true,
    });
  });

  test('active snapshots always use the same V2 lane as ordinary cron snapshots', async () => {
    const job = await enqueueLiveActiveSnapshot(
      TEST_SEASON,
      12,
      new Date('2026-08-09T12:34:56.000Z'),
      'LIVE_ACTIVE',
      new Date('2026-08-09T12:35:26.000Z'),
    );
    expect(job?.id).toBe('live-snapshot-2627-e12-20260809123430-v2');
    expect(addCalls[0]?.data).not.toHaveProperty('persistEventLives');
    expect(addCalls[0]?.data.expectedNextCheckAt).toBe('2026-08-09T12:35:26.000Z');
  });

  test('uses one deterministic daily final-retention bucket and preserves scheduler evidence', async () => {
    const now = new Date('2026-08-09T12:34:56.000Z');
    const job = await enqueueLiveFinalRetention(TEST_SEASON, 12, 'reconcile', {
      now,
      obligationId: 'obligation-retention',
      obligationGeneration: 1,
    });

    expect(job?.id).toBe(
      `live-final-retention-2627-e12-${Math.floor(now.getTime() / (24 * 60 * 60_000))}`,
    );
    expect(addCalls[0]).toMatchObject({
      name: 'live-final-retention',
      data: {
        seasonId: 2026,
        seasonCode: '2627',
        eventId: 12,
        source: 'reconcile',
        obligationId: 'obligation-retention',
        obligationGeneration: 1,
      },
    });
  });

  test('coalesces a pending final-retention bucket', async () => {
    const now = new Date('2026-08-09T12:34:56.000Z');
    waitingJobs.push({
      id: `live-final-retention-2627-e12-${Math.floor(now.getTime() / (24 * 60 * 60_000))}`,
      state: 'delayed',
      name: 'live-final-retention',
      data: { seasonId: TEST_SEASON.seasonId, eventId: 12 },
    });

    const job = await enqueueLiveFinalRetention(TEST_SEASON, 12, 'reconcile', { now });
    expect(job?.id).toBe(waitingJobs[0]?.id);
    expect(addCalls).toHaveLength(0);
  });

  test('creates a delayed successor when an active checkpoint coalesced a newer desired marker', async () => {
    const job = await enqueueLiveMatchCheckpoint(
      TEST_SEASON,
      12,
      'desk',
      '00000000-0000-4000-8000-000000000012',
      12,
      { successor: true, delayMs: 30_500 },
    );

    expect(job.id).toStartWith('live-match-checkpoint-2627-e12-desk-v3-successor-');
    expect(addCalls[0]).toMatchObject({
      name: 'live-match-checkpoint',
      data: {
        checkpointKind: 'desk',
        checkpointGeneration: 12,
      },
      opts: { delay: 30_500 },
    });
  });

  test('reuses one delayed successor across repeated checkpoint reconciliation passes', async () => {
    waitingJobs.push({
      id: 'existing-successor',
      state: 'delayed',
      name: 'live-match-checkpoint',
      data: {
        seasonId: TEST_SEASON.seasonId,
        eventId: 12,
        checkpointKind: 'desk',
      },
    });

    const first = await enqueueLiveMatchCheckpoint(
      TEST_SEASON,
      12,
      'desk',
      '00000000-0000-4000-8000-000000000012',
      12,
    );
    const second = await enqueueLiveMatchCheckpoint(
      TEST_SEASON,
      12,
      'desk',
      '00000000-0000-4000-8000-000000000012',
      12,
    );

    expect(first.id).toBe('existing-successor');
    expect(second.id).toBe('existing-successor');
    expect(addCalls).toHaveLength(0);
  });

  test('an active checkpoint creates exactly one delayed successor', async () => {
    waitingJobs.push({
      id: 'active-checkpoint',
      state: 'active',
      name: 'live-match-checkpoint',
      data: {
        seasonId: TEST_SEASON.seasonId,
        eventId: 12,
        checkpointKind: 'detail',
      },
    });

    const first = await enqueueLiveMatchCheckpoint(
      TEST_SEASON,
      12,
      'detail',
      '00000000-0000-4000-8000-000000000012',
      12,
      { successor: true, delayMs: 30_000 },
    );
    const second = await enqueueLiveMatchCheckpoint(
      TEST_SEASON,
      12,
      'detail',
      '00000000-0000-4000-8000-000000000012',
      12,
      { successor: true, delayMs: 30_000 },
    );

    expect(first.id).toStartWith('live-match-checkpoint-2627-e12-detail-v3-successor-');
    expect(second.id).toBe(first.id);
    expect(addCalls).toHaveLength(1);
  });
});
