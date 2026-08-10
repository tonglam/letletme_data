import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { TEST_SEASON } from '../fixtures/seasons.fixtures';

type AddCall = { name: string; data: Record<string, unknown>; opts: Record<string, unknown> };

const addCalls: AddCall[] = [];
const pendingJobs: Array<{
  id: string;
  name: string;
  data: Record<string, unknown>;
}> = [];
let returnedJobData: Record<string, unknown> | undefined;
let currentEventId = 12;

mock.module('../../src/queues/entry-sync.queue', () => ({
  ENTRY_SYNC_DEFAULT_CHUNK_SIZE: 100,
  ENTRY_SYNC_DEFAULT_CONCURRENCY: 5,
  ENTRY_SYNC_DEFAULT_THROTTLE_MS: 150,
  getEntrySyncQueue: () => ({
    name: 'entry-sync-p2',
    getJobs: async () => pendingJobs,
    add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
      addCalls.push({ name, data, opts });
      return {
        id: (opts.jobId as string | undefined) ?? 'generated-id',
        name,
        data: returnedJobData ?? data,
      };
    },
  }),
}));

mock.module('../../src/services/events.service', () => ({
  getCurrentEvent: async () => ({ id: currentEventId }),
  getNextEvent: async () => ({ id: currentEventId + 1 }),
}));

const { logger } = await import('../../src/utils/logger');
const { enqueueEntryPicksSyncJob, retainEntrySyncChainOptions } = await import(
  '../../src/jobs/entry-sync-enqueue'
);

describe('entry-sync enqueue runId propagation', () => {
  beforeEach(() => {
    addCalls.length = 0;
    pendingJobs.length = 0;
    returnedJobData = undefined;
    currentEventId = 12;
  });

  test('uses provided runId in chunk job ID', async () => {
    const job = await enqueueEntryPicksSyncJob(TEST_SEASON, 'cron', {
      chunkOffset: 0,
      runId: 'chain-xyz',
    });

    expect(job).not.toBeNull();
    expect(job!.id).toBe('entry-picks-2627-chain-xyz-chunk-0');
    expect(addCalls[0].data.runId).toBe('chain-xyz');
  });

  test('propagates runId with event-scoped chunk key', async () => {
    const job = await enqueueEntryPicksSyncJob(TEST_SEASON, 'cron', {
      chunkOffset: 100,
      eventId: 20,
      runId: 'chain-abc',
    });

    expect(job).not.toBeNull();
    expect(job!.id).toBe('entry-picks-2627-chain-abc-chunk-100-event-20');
  });

  test('keeps the manual queue key stable across correlated continuation chunks', async () => {
    const root = await enqueueEntryPicksSyncJob(TEST_SEASON, 'manual', { chunkOffset: 0 });
    const rootData = addCalls[0].data;
    const continuation = await enqueueEntryPicksSyncJob(TEST_SEASON, 'manual', {
      chunkOffset: 100,
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

    const job = await enqueueEntryPicksSyncJob(TEST_SEASON, 'manual', { chunkOffset: 0 });

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

  test('does not reuse a removed v2 continuation without season and queue identity', async () => {
    pendingJobs.push({
      id: 'entry-picks-manual-chunk-500',
      name: 'entry-picks',
      data: { source: 'manual', runId: 'manual' },
    });

    const job = await enqueueEntryPicksSyncJob(TEST_SEASON, 'manual', { chunkOffset: 0 });

    expect(job!.id).toBe('entry-picks-2627-manual-chunk-0');
    expect(addCalls).toHaveLength(1);
  });

  test('logs the stored run id when BullMQ deduplicates an add', async () => {
    const infoSpy = spyOn(logger, 'info').mockImplementation(() => undefined);
    returnedJobData = { runId: 'stored-run' };

    await enqueueEntryPicksSyncJob(TEST_SEASON, 'cron', { chunkOffset: 0, runId: 'new-run' });

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'stored-run' }),
      'Entry sync job enqueued',
    );
    infoSpy.mockRestore();
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

  test('carries settlement removal through a deterministic cron continuation', async () => {
    const root = await enqueueEntryPicksSyncJob(TEST_SEASON, 'cron', {
      runId: 'daily-scan',
      removeOnSettle: true,
    });
    const rootData = addCalls[0].data;
    const continuation = await enqueueEntryPicksSyncJob(TEST_SEASON, 'cron', {
      afterEntryId: 500,
      ...retainEntrySyncChainOptions(rootData),
    });

    expect(root.id).toBe('entry-picks-2627-daily-scan-chunk-0');
    expect(continuation.id).toBe('entry-picks-2627-daily-scan-chunk-500');
    expect(rootData.removeOnSettle).toBe(true);
    expect(addCalls[0].opts).toMatchObject({ removeOnComplete: true, removeOnFail: true });
    expect(addCalls[1].data.removeOnSettle).toBe(true);
    expect(addCalls[1].opts).toMatchObject({ removeOnComplete: true, removeOnFail: true });
  });
});
