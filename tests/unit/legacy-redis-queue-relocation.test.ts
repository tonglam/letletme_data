import { describe, expect, test } from 'bun:test';

import {
  expectedRuntimeQueueNames,
  inspectLegacyRedisQueues,
  inspectRuntimeRedisQueues,
  relocateLegacyRedisQueues,
  type LegacyQueueRelocationRedis,
} from '../../src/cache/legacy-cleanup';

function redisGlob(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replaceAll('*', '.*').replaceAll('?', '.')}$`);
}

type FakeValue = { dump: Buffer; ttl: number; type: 'string' | 'list'; list: Buffer[] };
type FakeInputValue = {
  value: string;
  ttl?: number;
  type?: 'string' | 'list';
  list?: readonly string[];
};

class FakeRedis implements LegacyQueueRelocationRedis {
  readonly values = new Map<string, FakeValue>();

  constructor(
    values: Record<string, FakeInputValue> = {},
    private readonly rewriteDumpOnRestore = false,
  ) {
    for (const [key, value] of Object.entries(values)) {
      this.values.set(key, {
        dump: Buffer.from(value.value),
        ttl: value.ttl ?? -1,
        type: value.type ?? 'string',
        list: (value.list ?? []).map((item) => Buffer.from(item)),
      });
    }
  }

  async scan(
    cursor: string,
    _matchToken: 'MATCH',
    pattern: string,
    _countToken: 'COUNT',
    count: number,
  ): Promise<[string, string[]]> {
    const matches = [...this.values.keys()].filter((key) => redisGlob(pattern).test(key)).sort();
    const offset = Number(cursor);
    const next = offset + count;
    return [next >= matches.length ? '0' : String(next), matches.slice(offset, next)];
  }

  async unlink(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.values.delete(key)) removed += 1;
    }
    return removed;
  }

  async dumpBuffer(key: string): Promise<Buffer | null> {
    const value = this.values.get(key);
    return value ? Buffer.from(value.dump) : null;
  }

  async type(key: string): Promise<string> {
    return this.values.get(key)?.type ?? 'none';
  }

  async callBuffer(command: string, ...args: (string | number | Buffer)[]): Promise<unknown> {
    const key = String(args[0]);
    const value = this.values.get(key);
    if (!value) return null;
    if (command === 'LRANGE') return value.list.map((item) => Buffer.from(item));
    if (command !== 'GET') throw new Error(`Unsupported fake command ${command}`);
    const serialized = value.dump.toString();
    return Buffer.from(serialized.startsWith('restored:') ? serialized.slice(9) : serialized);
  }

  async pttl(key: string): Promise<number> {
    return this.values.get(key)?.ttl ?? -2;
  }

  async restore(key: string, ttlMilliseconds: number, serializedValue: Buffer): Promise<'OK'> {
    if (this.values.has(key)) throw new Error('BUSYKEY');
    this.values.set(key, {
      dump: this.rewriteDumpOnRestore
        ? Buffer.from(`restored:${serializedValue.toString()}`)
        : Buffer.from(serializedValue),
      ttl: ttlMilliseconds === 0 ? -1 : ttlMilliseconds,
      type: 'string',
      list: [],
    });
    return 'OK';
  }
}

class ExpiringStalledCheckRedis extends FakeRedis {
  override async scan(
    cursor: string,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<[string, string[]]> {
    const result = await super.scan(cursor, matchToken, pattern, countToken, count);
    for (const key of result[1]) {
      if (key.endsWith(':stalled-check')) this.values.delete(key);
    }
    return result;
  }
}

class DelayedFakeRedis extends FakeRedis {
  activeReads = 0;
  maxActiveReads = 0;

  override async callBuffer(
    command: string,
    ...args: (string | number | Buffer)[]
  ): Promise<unknown> {
    this.activeReads += 1;
    this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads);
    await new Promise((resolve) => setTimeout(resolve, 2));
    try {
      return await super.callBuffer(command, ...args);
    } finally {
      this.activeReads -= 1;
    }
  }
}

const SOURCE_VALUES = {
  'bull:data-sync:meta': { value: 'data-meta' },
  'bull:data-sync:completed': { value: 'completed', ttl: 20_000 },
  'llm:v3:data:fpl:core:2627:active': { value: 'must-not-copy' },
} as const;

describe('legacy Redis queue relocation', () => {
  test('dry-runs an exact payload manifest without mutating either endpoint', async () => {
    const source = new FakeRedis(SOURCE_VALUES);
    const target = new FakeRedis();

    const result = await relocateLegacyRedisQueues(source, target);

    expect(result.dryRun).toBe(true);
    expect(result.matchedKeys).toBe(2);
    expect(result.pendingKeys).toBe(2);
    expect(result.copiedKeys).toBe(0);
    expect(result.keyManifestSha256).toHaveLength(64);
    expect(result.payloadManifestSha256).toHaveLength(64);
    expect(source.values.size).toBe(3);
    expect(target.values.size).toBe(0);
  });

  test('copies values and TTLs, verifies them, and is idempotent', async () => {
    const source = new FakeRedis(SOURCE_VALUES);
    const target = new FakeRedis({}, true);

    const execution = await relocateLegacyRedisQueues(source, target, { dryRun: false });
    const verification = await relocateLegacyRedisQueues(source, target);
    const replay = await relocateLegacyRedisQueues(source, target, { dryRun: false });
    const targetManifest = await inspectLegacyRedisQueues(target);

    expect(execution.copiedKeys).toBe(2);
    expect(execution.alreadyPresentKeys).toBe(0);
    expect(verification.pendingKeys).toBe(0);
    expect(verification.alreadyPresentKeys).toBe(2);
    expect(replay.copiedKeys).toBe(0);
    expect(replay.alreadyPresentKeys).toBe(2);
    expect(targetManifest.payloadManifestSha256).toBe(execution.payloadManifestSha256);
    expect(target.values.get('bull:data-sync:meta')?.ttl).toBe(-1);
    expect(target.values.get('bull:data-sync:completed')?.ttl).toBe(20_000);
    expect(target.values.has('llm:v3:data:fpl:core:2627:active')).toBe(false);
  });

  test('defines the complete expected queue topology for both runtime modes', () => {
    expect(expectedRuntimeQueueNames(false)).toEqual([
      'data-sync',
      'entry-sync',
      'league-sync',
      'live-data',
      'tournament-setup',
      'tournament-sync',
      'understat-player-sync',
      'understat-team-sync',
    ]);
    expect(expectedRuntimeQueueNames(true)).toHaveLength(26);
    expect(expectedRuntimeQueueNames(true)).toContain('data-sync-p0');
    expect(expectedRuntimeQueueNames(true)).not.toContain('data-sync');
  });

  test('runtime manifests ignore only positively expiring BullMQ leases', async () => {
    const first = new FakeRedis({
      ...SOURCE_VALUES,
      'bull:data-sync:stalled-check': { value: 'first-lease', ttl: 5_000 },
      'bull:data-sync:job-1:lock': { value: 'first-lock', ttl: 120_000 },
    });
    const second = new FakeRedis({
      ...SOURCE_VALUES,
      'bull:data-sync:stalled-check': { value: 'second-lease', ttl: 1_000 },
      'bull:data-sync:job-1:lock': { value: 'second-lock', ttl: 60_000 },
    });

    const firstExact = await inspectLegacyRedisQueues(first);
    const secondExact = await inspectLegacyRedisQueues(second);
    const firstRuntime = await inspectRuntimeRedisQueues(first, {
      expectedQueueNames: ['data-sync'],
    });
    const secondRuntime = await inspectRuntimeRedisQueues(second, {
      expectedQueueNames: ['data-sync'],
    });

    expect(firstExact.payloadManifestSha256).not.toBe(secondExact.payloadManifestSha256);
    expect(firstRuntime.payloadManifestSha256).toBe(secondRuntime.payloadManifestSha256);
    expect(firstRuntime.keyManifestSha256).toBe(secondRuntime.keyManifestSha256);
    expect(firstRuntime.ignoredEphemeralKeys).toEqual([
      'bull:data-sync:job-1:lock',
      'bull:data-sync:stalled-check',
    ]);
    expect(firstRuntime.keys).not.toContain('bull:data-sync:stalled-check');
  });

  test('hashes queue payloads concurrently without changing manifest order', async () => {
    const values = Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [
        `bull:data-sync:job-${String(index).padStart(2, '0')}`,
        { value: `payload-${index}` },
      ]),
    );
    const serial = await inspectLegacyRedisQueues(new FakeRedis(values), {
      logicalHashConcurrency: 1,
    });
    const concurrentRedis = new DelayedFakeRedis(values);
    const concurrent = await inspectLegacyRedisQueues(concurrentRedis, {
      logicalHashConcurrency: 4,
    });

    expect(concurrent).toEqual(serial);
    expect(concurrentRedis.maxActiveReads).toBe(4);
    await expect(
      inspectLegacyRedisQueues(concurrentRedis, { logicalHashConcurrency: 65 }),
    ).rejects.toThrow('Invalid legacy Redis cleanup bound');
  });

  test('runtime inspection tolerates a stalled-check lease expiring after scan', async () => {
    const redis = new ExpiringStalledCheckRedis({
      ...SOURCE_VALUES,
      'bull:data-sync:stalled-check': { value: 'expiring-lease', ttl: 1 },
    });

    const manifest = await inspectRuntimeRedisQueues(redis, {
      expectedQueueNames: ['data-sync'],
    });

    expect(manifest.keyCount).toBe(2);
    expect(manifest.ignoredEphemeralKeys).toEqual(['bull:data-sync:stalled-check']);
  });

  test('fails closed on persistent leases and active jobs after shutdown', async () => {
    const persistentLease = new FakeRedis({
      ...SOURCE_VALUES,
      'bull:data-sync:stalled-check': { value: 'persistent', ttl: -1 },
    });
    await expect(
      inspectRuntimeRedisQueues(persistentLease, { expectedQueueNames: ['data-sync'] }),
    ).rejects.toThrow('runtime lease is not expiring');

    const activeJob = new FakeRedis({
      ...SOURCE_VALUES,
      'bull:data-sync:active': {
        value: 'active-list',
        type: 'list',
        list: ['job-1'],
      },
      'bull:data-sync:job-1:lock': { value: 'lock', ttl: 120_000 },
    });
    await expect(
      inspectRuntimeRedisQueues(activeJob, { expectedQueueNames: ['data-sync'] }),
    ).rejects.toThrow('jobs remain active after worker shutdown');
  });

  test('fails closed on an empty, wrong, or metadata-only queue database', async () => {
    await expect(
      inspectRuntimeRedisQueues(new FakeRedis(), { expectedQueueNames: ['data-sync'] }),
    ).rejects.toThrow('queue topology is incomplete');

    await expect(
      inspectRuntimeRedisQueues(new FakeRedis(SOURCE_VALUES), {
        expectedQueueNames: ['entry-sync'],
      }),
    ).rejects.toThrow('queue topology is incomplete');

    await expect(
      inspectRuntimeRedisQueues(
        new FakeRedis({ 'bull:data-sync:meta': { value: 'metadata-only' } }),
        { expectedQueueNames: ['data-sync'] },
      ),
    ).rejects.toThrow('queue topology is incomplete');
  });

  test('fails closed on a conflicting target payload', async () => {
    const source = new FakeRedis(SOURCE_VALUES);
    const target = new FakeRedis({
      'bull:data-sync:meta': { value: 'different' },
    });

    await expect(relocateLegacyRedisQueues(source, target, { dryRun: false })).rejects.toThrow(
      'payload conflict',
    );
    expect(target.values.get('bull:data-sync:meta')?.dump.toString()).toBe('different');
  });

  test('fails closed when the queue target contains an unexpected legacy key', async () => {
    const source = new FakeRedis(SOURCE_VALUES);
    const target = new FakeRedis({
      'bull:entry-sync:meta': { value: 'unexpected' },
    });

    await expect(relocateLegacyRedisQueues(source, target)).rejects.toThrow('unexpected legacy');
  });
});
