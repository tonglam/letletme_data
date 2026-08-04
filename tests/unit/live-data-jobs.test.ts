import { beforeEach, describe, expect, mock, test } from 'bun:test';

type AddCall = { name: string; data: Record<string, unknown>; opts: Record<string, unknown> };

const addCalls: AddCall[] = [];
const waitingJobs: Array<{
  name: string;
  data: { eventId: number; persistEventLives?: boolean };
}> = [];
const getJobsCalls: string[][] = [];

mock.module('../../src/queues/live-data.queue', () => ({
  LIVE_JOBS: {
    LIVE_SNAPSHOT: 'live-snapshot',
    EVENT_LIVES_CACHE: 'event-lives-cache',
    EVENT_LIVES_DB: 'event-lives-db',
    EVENT_LIVE_SUMMARY: 'event-live-summary',
    EVENT_LIVE_EXPLAIN: 'event-live-explain',
    LIVE_FIXTURE_CACHE: 'live-fixture-cache',
    LIVE_BONUS_CACHE: 'live-bonus-cache',
    EVENT_OVERALL_RESULT: 'event-overall-result',
    LIVE_SCORES: 'live-scores',
  },
  getLiveDataQueue: () => ({
    name: 'live-data-p3',
    add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
      addCalls.push({ name, data, opts });
      return { id: (opts.jobId as string | undefined) ?? 'generated-id' };
    },
    getJobs: async (states: string[]) => {
      getJobsCalls.push(states);
      return waitingJobs;
    },
  }),
}));

mock.module('../../src/domain/job-priority', () => ({
  getLiveDataJobPriority: () => 'p3',
}));

const { enqueueEventLivesCacheUpdate, enqueueEventLivesDbSync, enqueueLiveSnapshot } = await import(
  '../../src/jobs/live-data.jobs'
);

describe('live-data cron duplicate suppression', () => {
  beforeEach(() => {
    addCalls.length = 0;
    waitingJobs.length = 0;
    getJobsCalls.length = 0;
  });

  test('persistent compatibility alias skips a pending persistent snapshot', async () => {
    waitingJobs.push({
      name: 'live-snapshot',
      data: { eventId: 12, persistEventLives: true },
    });

    const job = await enqueueEventLivesDbSync(12, 'cron');
    expect(job).toBeNull();
    expect(addCalls).toHaveLength(0);
    expect(getJobsCalls).toEqual([['waiting', 'delayed', 'active']]);
  });

  test('cron snapshot skips an active prior minute despite its explicit minute job ID', async () => {
    waitingJobs.push({ name: 'live-snapshot', data: { eventId: 12 } });

    const job = await enqueueLiveSnapshot(12, 'cron', {
      now: new Date('2025-08-15T20:01:00.000Z'),
    });
    expect(job).toBeNull();
    expect(addCalls).toHaveLength(0);
    expect(getJobsCalls).toEqual([['waiting', 'delayed', 'active']]);
  });

  test('cron persistence tick is not dropped behind a cache-only snapshot', async () => {
    waitingJobs.push({
      name: 'live-snapshot',
      data: { eventId: 12, persistEventLives: false },
    });

    const job = await enqueueLiveSnapshot(12, 'cron', {
      persistEventLives: true,
      now: new Date('2025-08-15T20:10:00.000Z'),
    });

    expect(job).not.toBeNull();
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0].data.persistEventLives).toBe(true);
  });

  test('pending persistence snapshot supersedes another persistence tick', async () => {
    waitingJobs.push({
      name: 'live-snapshot',
      data: { eventId: 12, persistEventLives: true },
    });

    const job = await enqueueLiveSnapshot(12, 'cron', {
      persistEventLives: true,
      now: new Date('2025-08-15T20:10:00.000Z'),
    });

    expect(job).toBeNull();
    expect(addCalls).toHaveLength(0);
  });

  test('manual source always enqueues even when a waiting job exists', async () => {
    waitingJobs.push({ name: 'live-snapshot', data: { eventId: 12 } });

    const job = await enqueueEventLivesCacheUpdate(12, 'manual');
    expect(job).not.toBeNull();
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0]).toMatchObject({
      name: 'event-lives-cache',
      data: { eventId: 12, persistEventLives: false },
      opts: { jobId: 'event-lives-cache-e12-manual' },
    });
    expect(getJobsCalls).toHaveLength(0);
  });

  test('DB compatibility alias publishes one persistent snapshot', async () => {
    const job = await enqueueEventLivesDbSync(12, 'manual');

    expect(job).not.toBeNull();
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0]).toMatchObject({
      name: 'event-lives-db',
      data: { eventId: 12, persistEventLives: true },
      opts: { jobId: 'event-lives-db-e12-manual' },
    });
  });

  test('canonical producer uses old-worker-compatible queue names during rollout', async () => {
    await enqueueLiveSnapshot(12, 'cron', {
      now: new Date('2025-08-15T20:01:00.000Z'),
    });
    await enqueueLiveSnapshot(13, 'cron', {
      persistEventLives: true,
      now: new Date('2025-08-15T20:10:00.000Z'),
    });

    expect(addCalls.map((call) => call.name)).toEqual(['event-lives-cache', 'event-lives-db']);
    expect(addCalls.map((call) => call.opts.jobId)).toEqual([
      'live-snapshot-e12-202508152001-cache',
      'live-snapshot-e13-202508152010-persist',
    ]);
  });

  test('legacy and canonical names share duplicate suppression semantics', async () => {
    waitingJobs.push({
      name: 'event-lives-db',
      data: { eventId: 12, persistEventLives: true },
    });

    const cacheJob = await enqueueLiveSnapshot(12, 'cron', {
      now: new Date('2025-08-15T20:01:00.000Z'),
    });
    const persistenceJob = await enqueueLiveSnapshot(12, 'cron', {
      persistEventLives: true,
      now: new Date('2025-08-15T20:10:00.000Z'),
    });

    expect(cacheJob).toBeNull();
    expect(persistenceJob).toBeNull();
    expect(addCalls).toHaveLength(0);
  });
});
