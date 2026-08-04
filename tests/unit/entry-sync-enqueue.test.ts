import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

type AddCall = { name: string; data: Record<string, unknown>; opts: Record<string, unknown> };

const addCalls: AddCall[] = [];
const pendingJobs: Array<{
  id: string;
  name: string;
  data: Record<string, unknown>;
}> = [];
let returnedJobData: Record<string, unknown> | undefined;

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

const { logger } = await import('../../src/utils/logger');
const { enqueueEntryPicksSyncJob } = await import('../../src/jobs/entry-sync-enqueue');

describe('entry-sync enqueue runId propagation', () => {
  beforeEach(() => {
    addCalls.length = 0;
    pendingJobs.length = 0;
    returnedJobData = undefined;
  });

  test('uses provided runId in chunk job ID', async () => {
    const job = await enqueueEntryPicksSyncJob('cron', {
      chunkOffset: 0,
      runId: 'chain-xyz',
    });

    expect(job).not.toBeNull();
    expect(job!.id).toBe('entry-picks-chain-xyz-chunk-0');
    expect(addCalls[0].data.runId).toBe('chain-xyz');
  });

  test('propagates runId with event-scoped chunk key', async () => {
    const job = await enqueueEntryPicksSyncJob('cron', {
      chunkOffset: 100,
      eventId: 20,
      runId: 'chain-abc',
    });

    expect(job).not.toBeNull();
    expect(job!.id).toBe('entry-picks-chain-abc-chunk-100-event-20');
  });

  test('keeps the manual queue key stable across correlated continuation chunks', async () => {
    const root = await enqueueEntryPicksSyncJob('manual', { chunkOffset: 0 });
    const rootData = addCalls[0].data;
    const continuation = await enqueueEntryPicksSyncJob('manual', {
      chunkOffset: 100,
      runId: rootData.runId as string,
      queueKey: rootData.queueKey as string,
    });

    expect(root!.id).toBe('entry-picks-manual-chunk-0');
    expect(rootData.queueKey).toBe('manual');
    expect(continuation!.id).toBe('entry-picks-manual-chunk-100');
    expect(addCalls[1].data.runId).toBe(rootData.runId);
    expect(addCalls[1].data.queueKey).toBe('manual');
  });

  test('reuses an active continuation for a repeated manual root trigger', async () => {
    pendingJobs.push({
      id: 'entry-picks-manual-chunk-500',
      name: 'entry-picks',
      data: { source: 'manual', queueKey: 'manual', runId: 'existing-run' },
    });

    const job = await enqueueEntryPicksSyncJob('manual', { chunkOffset: 0 });

    expect(job!.id).toBe('entry-picks-manual-chunk-500');
    expect(addCalls).toHaveLength(0);
  });

  test('reuses a legacy manual continuation that predates queue keys', async () => {
    pendingJobs.push({
      id: 'entry-picks-manual-chunk-500',
      name: 'entry-picks',
      data: { source: 'manual', runId: 'manual' },
    });

    const job = await enqueueEntryPicksSyncJob('manual', { chunkOffset: 0 });

    expect(job!.id).toBe('entry-picks-manual-chunk-500');
    expect(addCalls).toHaveLength(0);
  });

  test('logs the stored run id when BullMQ deduplicates an add', async () => {
    const infoSpy = spyOn(logger, 'info').mockImplementation(() => undefined);
    returnedJobData = { runId: 'stored-run' };

    await enqueueEntryPicksSyncJob('cron', { chunkOffset: 0, runId: 'new-run' });

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'stored-run' }),
      'Entry sync job enqueued',
    );
    infoSpy.mockRestore();
  });
});
