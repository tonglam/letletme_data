import { beforeEach, describe, expect, mock, test } from 'bun:test';

type AddCall = { name: string; data: Record<string, unknown>; opts: Record<string, unknown> };

const addCalls: AddCall[] = [];

mock.module('../../src/queues/data-sync.queue', () => ({
  getDataSyncQueue: () => ({
    name: 'data-sync-p1',
    add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
      addCalls.push({ name, data, opts });
      return { id: (opts.jobId as string | undefined) ?? 'generated-id' };
    },
  }),
}));

const { enqueueTeamsSyncJob } = await import('../../src/jobs/data-sync-enqueue');

describe('data-sync enqueue correlation', () => {
  beforeEach(() => {
    addCalls.length = 0;
  });

  test('keeps a deterministic queue ID but gives settled executions distinct run IDs', async () => {
    await enqueueTeamsSyncJob('api');
    await enqueueTeamsSyncJob('api');

    expect(addCalls).toHaveLength(2);
    expect(addCalls[0]?.opts.jobId).toBe('teams-api');
    expect(addCalls[1]?.opts.jobId).toBe('teams-api');
    expect(addCalls[0]?.data.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(addCalls[1]?.data.runId).not.toBe(addCalls[0]?.data.runId);
  });
});
