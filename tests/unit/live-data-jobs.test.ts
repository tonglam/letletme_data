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
    checkpointKind?: 'desk' | 'detail';
  };
}> = [];
const existingJobIds = new Set<string>();

mock.module('../../src/queues/live-data.queue', () => ({
  LIVE_JOBS: {
    LIVE_SNAPSHOT: 'live-snapshot',
    LIVE_MATCH_CHECKPOINT: 'live-match-checkpoint',
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
    getJob: async (jobId: string) =>
      existingJobIds.has(jobId) ? { id: jobId, getState: async () => 'completed' } : null,
    getJobs: async (states: string[]) =>
      waitingJobs.filter((job) => states.includes(job.state ?? 'waiting')),
  },
}));

const {
  enqueueLiveActiveSnapshot,
  enqueueLiveMatchCheckpoint,
  enqueueLiveSnapshot,
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

  test('uses a deterministic 30-second identity bucket while publication cadence stays in V2', async () => {
    const now = new Date('2026-08-09T12:34:56.000Z');
    expect(liveSnapshotMinuteBucket(now)).toBe('20260809123430');

    const job = await enqueueLiveSnapshot(TEST_SEASON, 12, 'cron', { now });
    expect(job?.id).toBe('live-snapshot-2627-e12-20260809123430-v2');
    expect(addCalls[0]?.data).not.toHaveProperty('persistEventLives');
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

  test('creates a delayed successor when an active checkpoint coalesced a newer desired marker', async () => {
    const job = await enqueueLiveMatchCheckpoint(
      TEST_SEASON,
      12,
      'desk',
      '00000000-0000-4000-8000-000000000012',
      12,
      { successor: true, delayMs: 30_500 },
    );

    expect(job.id).toStartWith('live-match-checkpoint-2627-e12-desk-v2-successor-');
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

    expect(first.id).toStartWith('live-match-checkpoint-2627-e12-detail-v2-successor-');
    expect(second.id).toBe(first.id);
    expect(addCalls).toHaveLength(1);
  });
});
