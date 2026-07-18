import { beforeEach, describe, expect, mock, test } from 'bun:test';

type AddCall = { name: string; data: Record<string, unknown>; opts: Record<string, unknown> };

const addCalls: AddCall[] = [];

mock.module('../../src/queues/entry-sync.queue', () => ({
  ENTRY_SYNC_DEFAULT_CHUNK_SIZE: 100,
  ENTRY_SYNC_DEFAULT_CONCURRENCY: 5,
  ENTRY_SYNC_DEFAULT_THROTTLE_MS: 150,
  getEntrySyncQueue: () => ({
    name: 'entry-sync-p2',
    add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
      addCalls.push({ name, data, opts });
      return { id: (opts.jobId as string | undefined) ?? 'generated-id' };
    },
  }),
}));

const { enqueueEntryPicksSyncJob } = await import('../../src/jobs/entry-sync-enqueue');

describe('entry-sync enqueue runId propagation', () => {
  beforeEach(() => {
    addCalls.length = 0;
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
});
