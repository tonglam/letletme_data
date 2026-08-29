import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { TEST_SEASON } from '../fixtures/seasons.fixtures';

type AddCall = { name: string; data: Record<string, unknown>; opts: Record<string, unknown> };

const addCalls: AddCall[] = [];
const waitingJobs: Array<{
  name: string;
  data: { seasonId: number; eventId: number; finalizeEvent?: boolean };
}> = [];
const existingJobIds = new Set<string>();

mock.module('../../src/queues/live-data.queue', () => ({
  LIVE_JOBS: { LIVE_SNAPSHOT: 'live-snapshot' },
  liveDataQueue: {
    name: 'live-data',
    add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
      addCalls.push({ name, data, opts });
      return { id: (opts.jobId as string | undefined) ?? 'generated-id', name, data };
    },
    getJob: async (jobId: string) =>
      existingJobIds.has(jobId) ? { id: jobId, getState: async () => 'completed' } : null,
    getJobs: async () => waitingJobs,
  },
}));

const { enqueueLiveActiveSnapshot, enqueueLiveSnapshot, liveSnapshotMinuteBucket } = await import(
  '../../src/jobs/live-data.jobs'
);

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
    );
    expect(job?.id).toBe('live-snapshot-2627-e12-20260809123430-v2');
    expect(addCalls[0]?.data).not.toHaveProperty('persistEventLives');
  });
});
