import { afterEach, describe, expect, it, mock } from 'bun:test';

const store = new Map<string, string>();

mock.module('../../src/cache/singleton', () => ({
  redisSingleton: {
    getClient: async () => ({
      set: async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      },
      decr: async (key: string) => {
        const next = Number(store.get(key) ?? '0') - 1;
        store.set(key, String(next));
        return next;
      },
      del: async (key: string) => {
        store.delete(key);
        return 1;
      },
    }),
  },
}));

const {
  createCascadeId,
  initCascadeStructureBarrier,
  noteCascadeStructureJobComplete,
  CASCADE_STRUCTURE_BARRIER_JOBS,
} = await import('../../src/jobs/tournament-sync.jobs');

describe('cascade structure barrier (FP-07)', () => {
  afterEach(() => {
    store.clear();
  });

  it('tracks three structure jobs and signals only on the last complete', async () => {
    const cascadeId = createCascadeId(33);
    expect(CASCADE_STRUCTURE_BARRIER_JOBS).toHaveLength(3);

    await initCascadeStructureBarrier(cascadeId);

    expect(await noteCascadeStructureJobComplete(cascadeId)).toBe(false);
    expect(await noteCascadeStructureJobComplete(cascadeId)).toBe(false);
    expect(await noteCascadeStructureJobComplete(cascadeId)).toBe(true);
    // Extra completes must not re-trigger
    expect(await noteCascadeStructureJobComplete(cascadeId)).toBe(false);
  });
});
