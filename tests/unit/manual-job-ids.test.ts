import { beforeEach, describe, expect, mock, test } from 'bun:test';

type AddCall = { name: string; data: Record<string, unknown>; opts: Record<string, unknown> };

const liveDataAddCalls: AddCall[] = [];
const entrySyncAddCalls: AddCall[] = [];

mock.module('../../src/queues/live-data.queue', () => ({
  LIVE_JOBS: {
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
    name: 'live-data-p1',
    add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
      liveDataAddCalls.push({ name, data, opts });
      return { id: (opts.jobId as string | undefined) ?? 'generated-id' };
    },
  }),
}));

mock.module('../../src/queues/entry-sync.queue', () => ({
  ENTRY_SYNC_DEFAULT_CHUNK_SIZE: 100,
  ENTRY_SYNC_DEFAULT_CONCURRENCY: 5,
  ENTRY_SYNC_DEFAULT_THROTTLE_MS: 150,
  getEntrySyncQueue: () => ({
    name: 'entry-sync-p2',
    add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
      entrySyncAddCalls.push({ name, data, opts });
      return { id: (opts.jobId as string | undefined) ?? 'generated-id' };
    },
  }),
}));

const { enqueueEventLivesDbSync, enqueueEventLivesCacheUpdate } = await import(
  '../../src/jobs/live-data.jobs'
);
const { enqueueEntryPicksSyncJob } = await import('../../src/jobs/entry-sync-enqueue');
const { stableHash } = await import('../../src/utils/stable-hash');

describe('live-data manual job IDs', () => {
  beforeEach(() => {
    liveDataAddCalls.length = 0;
  });

  test('manual triggers get a deterministic per-(job, event) ID', async () => {
    const first = await enqueueEventLivesDbSync(10, 'manual');
    const second = await enqueueEventLivesDbSync(10, 'manual');

    expect(first.id).toBe('event-lives-db-e10-manual');
    expect(second.id).toBe('event-lives-db-e10-manual');
    // Repeat trigger hits BullMQ's jobId dedup instead of queueing duplicate work
    expect(liveDataAddCalls[1].opts.jobId).toBe('event-lives-db-e10-manual');
  });

  test('manual jobs clean up on settle so later re-triggers actually re-run', async () => {
    await enqueueEventLivesDbSync(10, 'manual');

    // Deterministic IDs dedupe across retained jobs too — without immediate cleanup,
    // a completed manual job would swallow re-triggers for the retention window.
    expect(liveDataAddCalls[0].opts.removeOnComplete).toBe(true);
    expect(liveDataAddCalls[0].opts.removeOnFail).toBe(true);
  });

  test('manual IDs differ per job name and event', async () => {
    const dbSync = await enqueueEventLivesDbSync(10, 'manual');
    const cacheUpdate = await enqueueEventLivesCacheUpdate(10, 'manual');
    const otherEvent = await enqueueEventLivesDbSync(11, 'manual');

    expect(dbSync.id).toBe('event-lives-db-e10-manual');
    expect(cacheUpdate.id).toBe('event-lives-cache-e10-manual');
    expect(otherEvent.id).toBe('event-lives-db-e11-manual');
  });

  test('cron runs keep time-based IDs so every tick enqueues', async () => {
    const job = await enqueueEventLivesDbSync(10, 'cron');

    // Time-based suffix (not the deterministic manual ID) — cron ticks are seconds
    // apart in practice, so each cycle gets its own job instead of deduping.
    expect(job.id).toMatch(/^event-lives-db-e10-\d+$/);
    expect(job.id).not.toBe('event-lives-db-e10-manual');
    // Cron jobs keep queue-level retention (no per-job cleanup override)
    expect(liveDataAddCalls[0].opts.removeOnComplete).toBeUndefined();
  });
});

describe('entry-sync entry-list job IDs', () => {
  beforeEach(() => {
    entrySyncAddCalls.length = 0;
  });

  test('entry-list jobs get a deterministic content-based ID', async () => {
    const first = await enqueueEntryPicksSyncJob('api', { entryIds: [3, 1, 2], eventId: 20 });
    const second = await enqueueEntryPicksSyncJob('api', { entryIds: [1, 2, 3], eventId: 20 });

    expect(first.id).toMatch(/^entry-picks-entry-list-[0-9a-f]{8}$/);
    // Same entries in any order dedupe to the same job
    expect(second.id).toBe(first.id as string);
    // Entry-list jobs clean up on settle so repeat API calls after completion re-run
    expect(entrySyncAddCalls[0].opts.removeOnComplete).toBe(true);
    expect(entrySyncAddCalls[0].opts.removeOnFail).toBe(true);
  });

  test('different entry lists or events produce different IDs', async () => {
    const base = await enqueueEntryPicksSyncJob('api', { entryIds: [1, 2], eventId: 20 });
    const otherIds = await enqueueEntryPicksSyncJob('api', { entryIds: [1, 2, 4], eventId: 20 });
    const otherEvent = await enqueueEntryPicksSyncJob('api', { entryIds: [1, 2], eventId: 21 });
    const noEvent = await enqueueEntryPicksSyncJob('api', { entryIds: [1, 2] });

    expect(otherIds.id).not.toBe(base.id as string);
    expect(otherEvent.id).not.toBe(base.id as string);
    expect(noEvent.id).not.toBe(base.id as string);
  });

  test('retryCount distinguishes delayed full-batch retries from the active job', async () => {
    const original = await enqueueEntryPicksSyncJob('api', {
      entryIds: [1, 2],
      eventId: 20,
    });
    const retry = await enqueueEntryPicksSyncJob('api', {
      entryIds: [1, 2],
      eventId: 20,
      retryCount: 1,
    });

    expect(retry.id).not.toBe(original.id as string);
    expect(retry.id).toMatch(/^entry-picks-entry-list-[0-9a-f]{8}$/);
  });

  test('cron chunk jobs keep time-based per-cycle IDs', async () => {
    const job = await enqueueEntryPicksSyncJob('cron', { chunkOffset: 0 });

    expect(job.id).toMatch(/^entry-picks-chunk-0-\d+$/);
  });

  test('manual table-scan chunk jobs get a deterministic ID with settle cleanup', async () => {
    const first = await enqueueEntryPicksSyncJob('manual', { chunkOffset: 0 });
    const second = await enqueueEntryPicksSyncJob('manual', { chunkOffset: 0 });

    expect(first.id).toBe('entry-picks-chunk-0-manual');
    expect(second.id).toBe(first.id as string);
    expect(entrySyncAddCalls[0].opts.removeOnComplete).toBe(true);
    expect(entrySyncAddCalls[0].opts.removeOnFail).toBe(true);
  });
});

describe('stableHash', () => {
  test('is deterministic and returns 8 hex chars', () => {
    expect(stableHash('1,2,3|e20')).toBe(stableHash('1,2,3|e20'));
    expect(stableHash('1,2,3|e20')).toMatch(/^[0-9a-f]{8}$/);
  });

  test('differs on different inputs', () => {
    expect(stableHash('1,2,3|e20')).not.toBe(stableHash('1,2,4|e20'));
    expect(stableHash('')).not.toBe(stableHash('1'));
  });
});
