import { afterEach, describe, expect, it, mock } from 'bun:test';

const store = new Map<string, string>();

mock.module('../../src/cache/singleton', () => ({
  redisSingleton: {
    getClient: async () => ({
      set: async (
        key: string,
        value: string,
        ...args: Array<string | number>
      ): Promise<string | null> => {
        // Support SET key value EX ttl NX
        const nx = args.includes('NX');
        if (nx && store.has(key)) {
          return null;
        }
        store.set(key, String(value));
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

    expect(await noteCascadeStructureJobComplete(cascadeId, 'tournament-points-race')).toBe(false);
    expect(await noteCascadeStructureJobComplete(cascadeId, 'tournament-battle-race')).toBe(false);
    expect(await noteCascadeStructureJobComplete(cascadeId, 'tournament-knockout')).toBe(true);
  });

  it('is idempotent for the same jobKey (retry must not double-DECR)', async () => {
    const cascadeId = createCascadeId(34);
    await initCascadeStructureBarrier(cascadeId);

    expect(await noteCascadeStructureJobComplete(cascadeId, 'tournament-points-race')).toBe(false);
    // Simulated BullMQ retry of the same job after crash post-success
    expect(await noteCascadeStructureJobComplete(cascadeId, 'tournament-points-race')).toBe(false);

    expect(await noteCascadeStructureJobComplete(cascadeId, 'tournament-battle-race')).toBe(false);
    // Still need knockout — retry of points must not have released early
    expect(await noteCascadeStructureJobComplete(cascadeId, 'tournament-knockout')).toBe(true);
  });
});
