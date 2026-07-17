import { afterEach, describe, expect, it, mock } from 'bun:test';

const store = new Map<string, string>();

/**
 * Simulate cascade barrier Lua scripts used by tournament-sync.jobs.ts.
 * Script selection is by KEYS count / shape.
 */
function evalScript(numKeys: number, args: string[]): number {
  // noteCascadeStructureComplete: 8 keys + ttl
  if (numKeys === 8) {
    const thisSlot = args[0];
    const pendingKey = args[1];
    const roleSlots = [
      [args[2], args[3]],
      [args[4], args[5]],
      [args[6], args[7]],
    ];
    const ttl = args[8];
    void ttl;

    if (store.has(thisSlot)) {
      return -2;
    }
    store.set(thisSlot, '1');

    let done = 0;
    for (const [okKey, failKey] of roleSlots) {
      if (store.has(okKey) || store.has(failKey)) {
        done += 1;
      }
    }
    if (done >= 3) {
      store.set(pendingKey, '1');
      return 0;
    }
    return 3 - done;
  }

  // tryClaimCascadeRefresh: 3 keys + lease ttl
  if (numKeys === 3) {
    const doneKey = args[0];
    const pendingKey = args[1];
    const leaseKey = args[2];
    if (store.has(doneKey)) {
      return 2;
    }
    if (!store.has(pendingKey)) {
      return 3;
    }
    if (store.has(leaseKey)) {
      return 4;
    }
    store.set(leaseKey, '1');
    if (store.has(doneKey)) {
      store.delete(leaseKey);
      return 2;
    }
    return 1;
  }

  throw new Error(`Unexpected eval numKeys=${numKeys}`);
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
      expire: async (key: string) => (store.has(key) ? 1 : 0),
      eval: async (_script: string, numKeys: number, ...args: string[]): Promise<number> =>
        evalScript(numKeys, args),
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
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe('not-pending');

    await noteCascadeStructureJobComplete(cascadeId, 'tournament-battle-race');
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe('not-pending');

    await noteCascadeStructureJobComplete(cascadeId, 'tournament-knockout');
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe('claimed');
  });

  it('is idempotent for the same jobKey', async () => {
    const cascadeId = createCascadeId(34);
    await initCascadeStructureBarrier(cascadeId);

    await noteCascadeStructureJobComplete(cascadeId, 'tournament-points-race');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-points-race');

    await noteCascadeStructureJobComplete(cascadeId, 'tournament-battle-race');
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe('not-pending');

    await noteCascadeStructureJobComplete(cascadeId, 'tournament-knockout');
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe('claimed');
  });

  it('counts enqueue-failed slots toward role completion', async () => {
    const cascadeId = createCascadeId(37);
    await initCascadeStructureBarrier(cascadeId);

    await noteCascadeStructureJobComplete(cascadeId, 'enqueue-failed:tournament-points-race');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-battle-race');
    await noteCascadeStructureJobComplete(cascadeId, 'enqueue-failed:tournament-knockout');

    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe('claimed');
  });

  it('reports lease-busy and already-enqueued atomically', async () => {
    const cascadeId = createCascadeId(35);
    await initCascadeStructureBarrier(cascadeId);
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-points-race');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-battle-race');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-knockout');

    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe('claimed');
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe('lease-busy');

    await releaseCascadeRefreshEnqueueClaim(cascadeId);
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe('claimed');
    await markCascadeRefreshEnqueued(cascadeId);
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe('already-enqueued');
  });

  it('does not rely on a shared DECR counter (role slots only)', async () => {
    const cascadeId = createCascadeId(36);
    // No init — still works because completion counts slot keys only
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-points-race');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-battle-race');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-knockout');
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe('claimed');
  });
});
