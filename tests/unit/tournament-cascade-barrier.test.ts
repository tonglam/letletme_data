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
      del: async (...keys: string[]) => {
        let n = 0;
        for (const key of keys) {
          if (store.delete(key)) n += 1;
        }
        return n;
      },
      exists: async (...keys: string[]) => keys.filter((k) => store.has(k)).length,
    }),
  },
}));

const {
  createCascadeId,
  initCascadeStructureBarrier,
  noteCascadeStructureJobComplete,
  tryClaimCascadeRefreshEnqueue,
  markCascadeRefreshEnqueued,
  releaseCascadeRefreshEnqueueClaim,
  CASCADE_STRUCTURE_BARRIER_JOBS,
} = await import('../../src/jobs/tournament-sync.jobs');

describe('cascade structure barrier (FP-07)', () => {
  afterEach(() => {
    store.clear();
  });

  it('tracks three structure jobs and allows refresh claim only after the last', async () => {
    const cascadeId = createCascadeId(33);
    expect(CASCADE_STRUCTURE_BARRIER_JOBS).toHaveLength(3);

    await initCascadeStructureBarrier(cascadeId);

    await noteCascadeStructureJobComplete(cascadeId, 'tournament-points-race');
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe(false);

    await noteCascadeStructureJobComplete(cascadeId, 'tournament-battle-race');
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe(false);

    await noteCascadeStructureJobComplete(cascadeId, 'tournament-knockout');
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe(true);
  });

  it('is idempotent for the same jobKey (retry must not double-DECR)', async () => {
    const cascadeId = createCascadeId(34);
    await initCascadeStructureBarrier(cascadeId);

    await noteCascadeStructureJobComplete(cascadeId, 'tournament-points-race');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-points-race'); // retry

    await noteCascadeStructureJobComplete(cascadeId, 'tournament-battle-race');
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe(false);

    await noteCascadeStructureJobComplete(cascadeId, 'tournament-knockout');
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe(true);
  });

  it('preserves refresh enqueue across failed queue.add then retry (Codex P2)', async () => {
    const cascadeId = createCascadeId(35);
    await initCascadeStructureBarrier(cascadeId);
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-points-race');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-battle-race');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-knockout');

    // First attempt claims lease then fails before markCascadeRefreshEnqueued
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe(true);
    await releaseCascadeRefreshEnqueueClaim(cascadeId);

    // Retry (e.g. structure job re-run after crash) can claim again
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe(true);
    await markCascadeRefreshEnqueued(cascadeId);

    // Fully done — further retries no-op
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe(false);
  });
});
