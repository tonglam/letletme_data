import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { TEST_SEASON } from '../fixtures/seasons.fixtures';

type AddCall = { name: string; data: Record<string, unknown>; opts: Record<string, unknown> };

const addCalls: AddCall[] = [];
const pendingJobs: Array<{
  id: string;
  name: string;
  data: Record<string, unknown>;
}> = [];
const completedJobs: typeof pendingJobs = [];
let returnedJobData: Record<string, unknown> | undefined;
let persistedJobData: Record<string, unknown> | undefined;
let persistedJobMissing = false;
const getJobCalls: string[] = [];
let currentEventId = 12;

mock.module('../../src/queues/entry-sync.queue', () => ({
  ENTRY_SYNC_DEFAULT_CHUNK_SIZE: 100,
  ENTRY_SYNC_DEFAULT_CONCURRENCY: 5,
  ENTRY_SYNC_DEFAULT_THROTTLE_MS: 150,
  entrySyncQueue: {
    name: 'entry-sync',
    getJobs: async (states: string[]) =>
      states.includes('completed') ? completedJobs : pendingJobs,
    add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
      addCalls.push({ name, data, opts });
      return {
        id: (opts.jobId as string | undefined) ?? 'generated-id',
        name,
        data: returnedJobData ?? data,
      };
    },
    getJob: async (id: string) => {
      getJobCalls.push(id);
      if (persistedJobMissing) return null;
      const lastCall = addCalls.at(-1);
      if (!lastCall) return null;
      return {
        id,
        name: lastCall.name,
        data: persistedJobData ?? lastCall.data,
      };
    },
  },
}));

mock.module('../../src/services/events.service', () => ({
  getCurrentEvent: async () => ({ id: currentEventId }),
  getNextEvent: async () => ({ id: currentEventId + 1 }),
  selectCachedCurrentEvent: (publication: {
    currentEventId: number | null;
    events: Array<{ id: number }>;
  }) =>
    publication.currentEventId === null
      ? null
      : (publication.events.find((event) => event.id === publication.currentEventId) ?? null),
  selectCachedEventNeighbour: (
    publication: {
      currentEventId: number | null;
      events: Array<{ id: number; deadlineTime?: string | null }>;
      manifest: { sourceCheckedAt: string };
    },
    offset: -1 | 1,
  ) => {
    if (publication.currentEventId === null) {
      if (offset === -1) return null;
      const checkedAt = new Date(publication.manifest.sourceCheckedAt).getTime();
      return (
        [...publication.events]
          .filter(
            (event) =>
              event.deadlineTime !== null &&
              event.deadlineTime !== undefined &&
              new Date(event.deadlineTime).getTime() > checkedAt,
          )
          .sort(
            (left, right) =>
              new Date(left.deadlineTime!).getTime() - new Date(right.deadlineTime!).getTime(),
          )[0] ?? null
      );
    }
    return (
      publication.events.find((event) => event.id === publication.currentEventId! + offset) ?? null
    );
  },
}));

mock.module('../../src/services/queue-run-tracker', () => ({
  trackQueueRunJob: async () => undefined,
}));

const { logger } = await import('../../src/utils/logger');
const { enqueueEntryPicksSyncJob, retainEntrySyncChainOptions } = await import(
  '../../src/jobs/entry-sync-enqueue'
);

describe('entry-sync enqueue runId propagation', () => {
  beforeEach(() => {
    addCalls.length = 0;
    pendingJobs.length = 0;
    completedJobs.length = 0;
    returnedJobData = undefined;
    persistedJobData = undefined;
    persistedJobMissing = false;
    getJobCalls.length = 0;
    currentEventId = 12;
  });

  test('uses provided runId in chunk job ID', async () => {
    const job = await enqueueEntryPicksSyncJob(TEST_SEASON, 'cron', {
      afterEntryId: 0,
      runId: 'chain-xyz',
    });

    expect(job).not.toBeNull();
    expect(job!.id).toBe('entry-picks-2627-chain-xyz-chunk-0');
    expect(addCalls[0].data.runId).toBe('chain-xyz');
  });

  test('propagates runId with event-scoped chunk key', async () => {
    const job = await enqueueEntryPicksSyncJob(TEST_SEASON, 'cron', {
      afterEntryId: 100,
      eventId: 20,
      runId: 'chain-abc',
    });

    expect(job).not.toBeNull();
    expect(job!.id).toBe('entry-picks-2627-chain-abc-chunk-100-event-20');
  });

  test('keeps the manual queue key stable across correlated continuation chunks', async () => {
    const root = await enqueueEntryPicksSyncJob(TEST_SEASON, 'manual', { afterEntryId: 0 });
    const rootData = addCalls[0].data;
    const continuation = await enqueueEntryPicksSyncJob(TEST_SEASON, 'manual', {
      afterEntryId: 100,
      runId: rootData.runId as string,
      queueKey: rootData.queueKey as string,
    });

    expect(root!.id).toBe('entry-picks-2627-manual-chunk-0');
    expect(rootData.queueKey).toBe('manual');
    expect(continuation!.id).toBe('entry-picks-2627-manual-chunk-100');
    expect(addCalls[1].data.runId).toBe(rootData.runId);
    expect(addCalls[1].data.queueKey).toBe('manual');
  });

  test('reuses an active continuation for a repeated manual root trigger', async () => {
    pendingJobs.push({
      id: 'entry-picks-2627-manual-chunk-500',
      name: 'entry-picks',
      data: {
        seasonId: TEST_SEASON.seasonId,
        seasonCode: TEST_SEASON.seasonCode,
        source: 'manual',
        queueKey: 'manual',
        runId: 'existing-run',
      },
    });

    const job = await enqueueEntryPicksSyncJob(TEST_SEASON, 'manual', { afterEntryId: 0 });

    expect(job!.id).toBe('entry-picks-2627-manual-chunk-500');
    expect(addCalls).toHaveLength(0);
  });

  test('does not reuse a manual scan rooted for a different event', async () => {
    pendingJobs.push({
      id: 'entry-picks-2627-manual-chunk-0-event-12',
      name: 'entry-picks',
      data: {
        seasonId: TEST_SEASON.seasonId,
        seasonCode: TEST_SEASON.seasonCode,
        source: 'manual',
        queueKey: 'manual',
        eventId: 12,
        runId: 'existing-run',
      },
    });

    const job = await enqueueEntryPicksSyncJob(TEST_SEASON, 'manual', { eventId: 13 });

    expect(job!.id).toBe('entry-picks-2627-manual-chunk-0-event-13');
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0].data.eventId).toBe(13);
  });

  test('reuses an unscoped root trigger for a resolved continuation', async () => {
    pendingJobs.push({
      id: 'entry-picks-2627-manual-chunk-500',
      name: 'entry-picks',
      data: {
        seasonId: TEST_SEASON.seasonId,
        seasonCode: TEST_SEASON.seasonCode,
        source: 'manual',
        queueKey: 'manual',
        eventId: 12,
        runId: 'existing-run',
      },
    });

    const job = await enqueueEntryPicksSyncJob(TEST_SEASON, 'manual');

    expect(job!.id).toBe('entry-picks-2627-manual-chunk-500');
    expect(addCalls).toHaveLength(0);
  });

  test('does not reuse a resolved continuation after the current event advances', async () => {
    pendingJobs.push({
      id: 'entry-picks-2627-manual-chunk-500-event-12',
      name: 'entry-picks',
      data: {
        seasonId: TEST_SEASON.seasonId,
        seasonCode: TEST_SEASON.seasonCode,
        source: 'manual',
        queueKey: 'manual',
        eventId: 12,
        runId: 'existing-run',
      },
    });
    currentEventId = 13;

    const job = await enqueueEntryPicksSyncJob(TEST_SEASON, 'manual');

    expect(job!.id).toBe('entry-picks-2627-manual-chunk-0');
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0].data.eventId).toBeUndefined();
  });

  test('does not reuse a malformed continuation without season and queue identity', async () => {
    pendingJobs.push({
      id: 'entry-picks-manual-chunk-500',
      name: 'entry-picks',
      data: { source: 'manual', runId: 'manual' },
    });

    const job = await enqueueEntryPicksSyncJob(TEST_SEASON, 'manual', { afterEntryId: 0 });

    expect(job!.id).toBe('entry-picks-2627-manual-chunk-0');
    expect(addCalls).toHaveLength(1);
  });

  test('logs the stored run id when BullMQ deduplicates an add', async () => {
    const infoSpy = spyOn(logger, 'info').mockImplementation(() => undefined);
    persistedJobData = { runId: 'stored-run' };

    const job = await enqueueEntryPicksSyncJob(TEST_SEASON, 'cron', {
      entryIds: [10, 20],
      eventId: 20,
      jobId: 'entry-picks-2627-live-refresh-20-123',
      runId: 'new-run',
      queueKey: 'live-picks-20',
      deduplicationId: 'live-picks-refresh:2627:event-20:cohort',
      deduplicationCadenceMs: 600_000,
    });

    expect(job.data.runId).toBe('stored-run');
    expect(getJobCalls).toEqual(['entry-picks-2627-live-refresh-20-123']);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'stored-run' }),
      'Entry sync job enqueued',
    );
    infoSpy.mockRestore();
  });

  test('fails closed when a Redis-deduplicated job cannot be hydrated', async () => {
    persistedJobMissing = true;

    await expect(
      enqueueEntryPicksSyncJob(TEST_SEASON, 'cron', {
        entryIds: [10, 20],
        eventId: 20,
        jobId: 'entry-picks-2627-live-refresh-20-123',
        queueKey: 'live-picks-20',
        deduplicationId: 'live-picks-refresh:2627:event-20:cohort',
        deduplicationCadenceMs: 600_000,
      }),
    ).rejects.toThrow('Entry sync deduplicated job could not be loaded from Redis');
  });

  test('uses a stable keyset cursor and preserves retry continuation', async () => {
    const job = await enqueueEntryPicksSyncJob(TEST_SEASON, 'cron', {
      afterEntryId: 450,
      resumeAfterEntryId: 450,
      eventId: 20,
      runId: 'chain-keyset',
    });

    expect(job!.id).toBe('entry-picks-2627-chain-keyset-chunk-450-event-20');
    expect(addCalls[0].data.afterEntryId).toBe(450);
    expect(addCalls[0].data.resumeAfterEntryId).toBe(450);
  });

  test('scopes exact failed-ID retries to their originating scan', async () => {
    const first = await enqueueEntryPicksSyncJob(TEST_SEASON, 'cron', {
      entryIds: [10, 20],
      eventId: 20,
      retryCount: 1,
      runId: 'scan-a',
    });
    const second = await enqueueEntryPicksSyncJob(TEST_SEASON, 'cron', {
      entryIds: [10, 20],
      eventId: 20,
      retryCount: 1,
      runId: 'scan-b',
    });

    expect(first.id).not.toBe(second.id);
    expect(addCalls[0].data.runId).toBe('scan-a');
    expect(addCalls[1].data.runId).toBe('scan-b');
  });

  test('deduplicates concurrent API entry lists only for the active lifecycle', async () => {
    const first = await enqueueEntryPicksSyncJob(TEST_SEASON, 'api', {
      entryIds: [20, 10],
      eventId: 20,
    });
    const second = await enqueueEntryPicksSyncJob(TEST_SEASON, 'api', {
      entryIds: [10, 20],
      eventId: 20,
    });

    expect(first.id).not.toBe(second.id);
    expect(first.id).toMatch(/^entry-picks-2627-entry-list-[0-9a-f]{8}-run-/);
    expect(second.id).toMatch(/^entry-picks-2627-entry-list-[0-9a-f]{8}-run-/);
    expect(addCalls[0].opts.deduplication).toEqual(addCalls[1].opts.deduplication);
    expect(addCalls[0].opts.deduplication).toEqual({
      id: expect.stringMatching(/^entry-picks-2627-entry-list-[0-9a-f]{8}$/),
    });
    expect(addCalls[0].opts.removeOnComplete).toBeUndefined();
    expect(addCalls[0].opts.removeOnFail).toBeUndefined();
  });

  test('does not lifecycle-dedupe coordinator-owned or exact retry jobs', async () => {
    await enqueueEntryPicksSyncJob(TEST_SEASON, 'api', {
      entryIds: [10],
      eventId: 20,
      jobId: 'entry-onboarding-attempt-entry-picks-10',
      runId: 'entry-onboarding-attempt',
    });
    await enqueueEntryPicksSyncJob(TEST_SEASON, 'api', {
      entryIds: [10],
      eventId: 20,
      retryCount: 1,
      runId: 'entry-onboarding-attempt',
    });

    expect(addCalls[0].opts.jobId).toBe('entry-onboarding-attempt-entry-picks-10');
    expect(addCalls[0].opts.deduplication).toBeUndefined();
    expect(addCalls[1].opts.deduplication).toBeUndefined();
  });

  test('keeps explicit cron fan-out single-flight until the job settles', async () => {
    await enqueueEntryPicksSyncJob(TEST_SEASON, 'cron', {
      entryIds: [10, 20],
      eventId: 20,
      jobId: 'entry-picks-2627-live-refresh-20-123',
      queueKey: 'live-picks-20',
      deduplicationId: 'live-picks-refresh:2627:event-20',
      deduplicationCadenceMs: 600_000,
    });

    expect(addCalls[0].opts.deduplication).toEqual({
      id: 'live-picks-refresh:2627:event-20',
    });
    expect(addCalls[0].data.deduplicationId).toBe('live-picks-refresh:2627:event-20');
  });

  test('reuses a non-terminal legacy event fan-out after its old TTL elapsed', async () => {
    pendingJobs.push({
      id: 'entry-picks-2627-live-refresh-20-old',
      name: 'entry-picks',
      data: {
        seasonId: TEST_SEASON.seasonId,
        seasonCode: TEST_SEASON.seasonCode,
        source: 'cron',
        eventId: 20,
        queueKey: 'live-picks-20',
        triggeredAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        entryIds: [10, 20],
        runId: 'old-run',
      },
    });

    const job = await enqueueEntryPicksSyncJob(TEST_SEASON, 'cron', {
      entryIds: [10, 20],
      eventId: 20,
      jobId: 'entry-picks-2627-live-refresh-20-new',
      queueKey: 'live-picks-20',
      deduplicationId: 'live-picks-refresh:2627:event-20',
      deduplicationCadenceMs: 600_000,
    });

    expect(job.id).toBe('entry-picks-2627-live-refresh-20-old');
    expect(addCalls).toHaveLength(0);
  });

  test('reuses the latest completed event fan-out during the restart cadence window', async () => {
    completedJobs.push({
      id: 'entry-picks-2627-live-refresh-20-complete',
      name: 'entry-picks',
      data: {
        seasonId: TEST_SEASON.seasonId,
        seasonCode: TEST_SEASON.seasonCode,
        source: 'cron',
        eventId: 20,
        queueKey: 'live-picks-20',
        deduplicationId: 'live-picks-refresh:2627:event-20',
        triggeredAt: new Date(Date.now() - 60_000).toISOString(),
        entryIds: [10, 20],
        runId: 'completed-run',
      },
    });

    const job = await enqueueEntryPicksSyncJob(TEST_SEASON, 'cron', {
      entryIds: [10, 20],
      eventId: 20,
      jobId: 'entry-picks-2627-live-refresh-20-new',
      queueKey: 'live-picks-20',
      deduplicationId: 'live-picks-refresh:2627:event-20',
      deduplicationCadenceMs: 600_000,
    });

    expect(job.id).toBe('entry-picks-2627-live-refresh-20-complete');
    expect(addCalls).toHaveLength(0);
  });

  test('allows a new event fan-out after the completed cadence window expires', async () => {
    completedJobs.push({
      id: 'entry-picks-2627-live-refresh-20-expired',
      name: 'entry-picks',
      data: {
        seasonId: TEST_SEASON.seasonId,
        seasonCode: TEST_SEASON.seasonCode,
        source: 'cron',
        eventId: 20,
        queueKey: 'live-picks-20',
        deduplicationId: 'live-picks-refresh:2627:event-20',
        triggeredAt: new Date(Date.now() - 600_001).toISOString(),
        entryIds: [10, 20],
        runId: 'expired-run',
      },
    });

    const job = await enqueueEntryPicksSyncJob(TEST_SEASON, 'cron', {
      entryIds: [10, 20],
      eventId: 20,
      jobId: 'entry-picks-2627-live-refresh-20-new',
      queueKey: 'live-picks-20',
      deduplicationId: 'live-picks-refresh:2627:event-20',
      deduplicationCadenceMs: 600_000,
    });

    expect(job.id).toBe('entry-picks-2627-live-refresh-20-new');
    expect(addCalls).toHaveLength(1);
  });

  test('retains failure evidence through a deterministic cron continuation', async () => {
    const freshAfter = '2026-08-25T08:00:00.000Z';
    const root = await enqueueEntryPicksSyncJob(TEST_SEASON, 'cron', {
      runId: 'daily-scan',
      removeOnSettle: true,
      freshAfter,
      freshnessWindowId: 314,
    });
    const rootData = addCalls[0].data;
    const continuation = await enqueueEntryPicksSyncJob(TEST_SEASON, 'cron', {
      afterEntryId: 500,
      ...retainEntrySyncChainOptions(rootData),
    });

    expect(root.id).toBe('entry-picks-2627-daily-scan-chunk-0');
    expect(continuation.id).toBe('entry-picks-2627-daily-scan-chunk-500');
    expect(rootData.removeOnSettle).toBe(false);
    expect(rootData.freshAfter).toBe(freshAfter);
    expect(rootData.freshnessWindowId).toBe(314);
    expect(addCalls[0].opts.removeOnComplete).toBeUndefined();
    expect(addCalls[0].opts.removeOnFail).toBeUndefined();
    expect(addCalls[1].data.removeOnSettle).toBe(false);
    expect(addCalls[1].data.freshAfter).toBe(freshAfter);
    expect(addCalls[1].data.freshnessWindowId).toBe(314);
    expect(addCalls[1].opts.removeOnComplete).toBeUndefined();
    expect(addCalls[1].opts.removeOnFail).toBeUndefined();
  });
});
