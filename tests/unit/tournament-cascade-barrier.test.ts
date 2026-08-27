import { afterEach, describe, expect, it, mock } from 'bun:test';

const store = new Map<string, string>();

/**
 * Simulate cascade barrier Lua scripts used by tournament-sync.jobs.ts.
 * Script selection is by KEYS count / shape.
 */
function evalScript(numKeys: number, args: string[]): number {
  // noteCascadeStructureComplete: this slot + pending + successful role slots + ttl
  if (numKeys > 3) {
    const thisSlot = args[0];
    const pendingKey = args[1];
    const roleSlots = args.slice(2, numKeys);
    const ttl = args[numKeys];
    void ttl;

    if (store.has(thisSlot)) {
      return -2;
    }
    store.set(thisSlot, '1');

    let done = 0;
    for (const okKey of roleSlots) {
      if (store.has(okKey)) {
        done += 1;
      }
    }
    if (done >= roleSlots.length) {
      store.set(pendingKey, '1');
      return 0;
    }
    return roleSlots.length - done;
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

const fakeRedis = {
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
};

mock.module('../../src/cache/singleton', () => ({ redisSingleton: fakeRedis }));
mock.module('../../src/queues/redis', () => ({ queueRedisSingleton: fakeRedis }));

const {
  createCascadeId,
  initCascadeStructureBarrier,
  noteCascadeStructureJobComplete,
  tryClaimCascadeRefreshEnqueue,
  markCascadeRefreshEnqueued,
  releaseCascadeRefreshEnqueueClaim,
  CASCADE_COMPLETION_BARRIER_JOBS,
  CASCADE_BARRIER_TTL_SECONDS,
} = await import('../../src/jobs/tournament-sync.jobs');

describe('cascade completion barrier (FP-07)', () => {
  afterEach(() => {
    store.clear();
  });

  it('keeps the barrier beyond the post-match recovery horizon', () => {
    expect(CASCADE_BARRIER_TTL_SECONDS).toBeGreaterThan(24 * 60 * 60);
  });

  it('waits for structure and terminal enrichment before allowing publication', async () => {
    const cascadeId = createCascadeId();
    expect(cascadeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(CASCADE_COMPLETION_BARRIER_JOBS).toEqual([
      'tournament-points-race',
      'tournament-battle-race',
      'tournament-knockout',
      'tournament-transfers-post',
      'tournament-cup-results',
      'tournament-selection-stats',
    ]);

    await initCascadeStructureBarrier(cascadeId);

    await noteCascadeStructureJobComplete(cascadeId, 'tournament-points-race');
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe('not-pending');

    await noteCascadeStructureJobComplete(cascadeId, 'tournament-battle-race');
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe('not-pending');

    await noteCascadeStructureJobComplete(cascadeId, 'tournament-knockout');
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe('not-pending');

    await noteCascadeStructureJobComplete(cascadeId, 'tournament-transfers-post');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-cup-results');
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe('not-pending');

    await noteCascadeStructureJobComplete(cascadeId, 'tournament-selection-stats');
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe('claimed');
  });

  it('is idempotent for the same jobKey', async () => {
    const cascadeId = createCascadeId();
    await initCascadeStructureBarrier(cascadeId);

    await noteCascadeStructureJobComplete(cascadeId, 'tournament-points-race');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-points-race');

    await noteCascadeStructureJobComplete(cascadeId, 'tournament-battle-race');
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe('not-pending');

    await noteCascadeStructureJobComplete(cascadeId, 'tournament-knockout');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-transfers-post');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-cup-results');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-selection-stats');
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe('claimed');
  });

  it('rejects enqueue-failed markers and never publishes a partial cascade', async () => {
    const cascadeId = createCascadeId();
    await initCascadeStructureBarrier(cascadeId);

    await expect(
      noteCascadeStructureJobComplete(cascadeId, 'enqueue-failed:tournament-points-race' as never),
    ).rejects.toThrow('Unknown tournament cascade completion role');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-battle-race');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-knockout');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-transfers-post');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-cup-results');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-selection-stats');

    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe('not-pending');
  });

  it('reports lease-busy and already-enqueued atomically', async () => {
    const cascadeId = createCascadeId();
    await initCascadeStructureBarrier(cascadeId);
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-points-race');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-battle-race');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-knockout');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-transfers-post');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-cup-results');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-selection-stats');

    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe('claimed');
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe('lease-busy');

    await releaseCascadeRefreshEnqueueClaim(cascadeId);
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe('claimed');
    await markCascadeRefreshEnqueued(cascadeId);
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe('already-enqueued');
  });

  it('does not rely on a shared DECR counter (role slots only)', async () => {
    const cascadeId = createCascadeId();
    // No init — still works because completion counts slot keys only
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-points-race');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-battle-race');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-knockout');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-transfers-post');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-cup-results');
    await noteCascadeStructureJobComplete(cascadeId, 'tournament-selection-stats');
    expect(await tryClaimCascadeRefreshEnqueue(cascadeId)).toBe('claimed');
  });
});
