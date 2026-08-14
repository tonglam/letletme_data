import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { TEST_SEASON } from '../fixtures/seasons.fixtures';

type AddCall = { name: string; data: Record<string, unknown>; opts: Record<string, unknown> };

const addCalls: AddCall[] = [];
const waitingJobs: Array<{
  name: string;
  data: {
    seasonId: number;
    eventId: number;
    persistEventLives?: boolean;
    finalizeEvent?: boolean;
  };
}> = [];

mock.module('../../src/queues/live-data.queue', () => ({
  LIVE_JOBS: { LIVE_SNAPSHOT: 'live-snapshot' },
  liveDataQueue: {
    name: 'live-data',
    add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
      addCalls.push({ name, data, opts });
      return { id: (opts.jobId as string | undefined) ?? 'generated-id', name, data };
    },
    getJobs: async () => waitingJobs,
  },
}));

const { enqueueLiveSnapshot, liveSnapshotMinuteBucket } = await import(
  '../../src/jobs/live-data.jobs'
);

describe('coherent live-snapshot enqueue', () => {
  beforeEach(() => {
    addCalls.length = 0;
    waitingJobs.length = 0;
  });

  test('carries explicit season identity and one coherent job name', async () => {
    const job = await enqueueLiveSnapshot(TEST_SEASON, 12, 'manual', {
      persistEventLives: true,
      finalizeEvent: true,
    });

    expect(job!.id).toBe('live-snapshot-2627-e12-manual-persist');
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0]).toMatchObject({
      name: 'live-snapshot',
      data: {
        seasonId: 2026,
        seasonCode: '2627',
        eventId: 12,
        source: 'manual',
        persistEventLives: true,
        finalizeEvent: true,
      },
    });
  });

  test('suppresses a cron duplicate for the same season, event, and authority level', async () => {
    waitingJobs.push({
      name: 'live-snapshot',
      data: { seasonId: TEST_SEASON.seasonId, eventId: 12, persistEventLives: true },
    });

    await expect(
      enqueueLiveSnapshot(TEST_SEASON, 12, 'cron', { persistEventLives: true }),
    ).resolves.toBeNull();
    expect(addCalls).toHaveLength(0);
  });

  test('does not let a cache-only or different-season job suppress durable work', async () => {
    waitingJobs.push(
      {
        name: 'live-snapshot',
        data: { seasonId: TEST_SEASON.seasonId, eventId: 12, persistEventLives: false },
      },
      {
        name: 'live-snapshot',
        data: { seasonId: 2025, eventId: 12, persistEventLives: true },
      },
    );

    const job = await enqueueLiveSnapshot(TEST_SEASON, 12, 'cron', {
      persistEventLives: true,
      now: new Date('2026-08-09T12:34:56.000Z'),
    });
    expect(job).not.toBeNull();
    expect(addCalls).toHaveLength(1);
  });

  test('does not let an ordinary durable job suppress finalization', async () => {
    waitingJobs.push({
      name: 'live-snapshot',
      data: { seasonId: TEST_SEASON.seasonId, eventId: 12, persistEventLives: true },
    });

    const job = await enqueueLiveSnapshot(TEST_SEASON, 12, 'cron', {
      persistEventLives: true,
      finalizeEvent: true,
    });

    expect(job).not.toBeNull();
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0]?.data.finalizeEvent).toBe(true);
  });

  test('suppresses a duplicate while finalization is pending', async () => {
    waitingJobs.push({
      name: 'live-snapshot',
      data: {
        seasonId: TEST_SEASON.seasonId,
        eventId: 12,
        persistEventLives: true,
        finalizeEvent: true,
      },
    });

    await expect(
      enqueueLiveSnapshot(TEST_SEASON, 12, 'cron', {
        persistEventLives: true,
        finalizeEvent: true,
      }),
    ).resolves.toBeNull();
    expect(addCalls).toHaveLength(0);
  });

  test('uses a deterministic 30-second bucket and separates cache from durable work', async () => {
    const now = new Date('2026-08-09T12:34:56.000Z');
    expect(liveSnapshotMinuteBucket(now)).toBe('20260809123430');

    const cacheOnly = await enqueueLiveSnapshot(TEST_SEASON, 12, 'cron', { now });
    const durable = await enqueueLiveSnapshot(TEST_SEASON, 12, 'cron', {
      now,
      persistEventLives: true,
    });
    expect(cacheOnly?.id).toBe('live-snapshot-2627-e12-20260809123430-cache');
    expect(durable?.id).toBe('live-snapshot-2627-e12-20260809123430-persist');
  });
});
