import { afterEach, describe, expect, it, mock } from 'bun:test';

const store = new Map<string, string>();

/**
 * Minimal Redis mock that implements the cascade barrier Lua script used by
 * noteCascadeStructureJobComplete (SET NX + DECR + optional pending).
 */
function evalBarrierScript(
  _script: string,
  _numKeys: number,
  slotKey: string,
  remainingKey: string,
  pendingKey: string,
  ttl: string,
): number {
  if (store.has(slotKey)) {
    return -2;
  }
  store.set(slotKey, '1');
  const remaining = Number(store.get(remainingKey) ?? '0') - 1;
  if (remaining === 0) {
    store.delete(remainingKey);
    store.set(pendingKey, '1');
    return 0;
  }
  if (remaining < 0) {
    store.delete(remainingKey);
    return -1;
  }
  store.set(remainingKey, String(remaining));
  void ttl;
  return remaining;
}

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
      eval: async (script: string, numKeys: number, ...args: string[]): Promise<number> => {
        const [slotKey, remainingKey, pendingKey, ttl] = args;
        return evalBarrierScript(script, numKeys, slotKey, remainingKey, pendingKey, ttl);
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

  it('preserves refresh enqueue across failed queue.add then retry', async () => {
    const cascadeId = createCascadeId(35);
    await initCascadeStructureBarrier(cascadeId);
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-points-race');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-battle-race');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-knockout');

    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe(true);
    await releaseCascadeRefreshEnqueueClaim(cascadeId);

    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe(true);
    await markCascadeRefreshEnqueued(cascadeId);

    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe(false);
  });

  it('atomically claims slot and decrements (Lua path — no stranded SET NX)', async () => {
    const cascadeId = createCascadeId(36);
    await initCascadeStructureBarrier(cascadeId);

    // One atomic eval per job — if it returns, remaining is consistent.
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-points-race');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-battle-race');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-knockout');

    // Pending must be set even though we never issued a separate SET pending
    // outside the script.
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe(true);
  });
});
