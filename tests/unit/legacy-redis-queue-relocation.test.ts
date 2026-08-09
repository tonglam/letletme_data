import { describe, expect, test } from 'bun:test';

import {
  inspectLegacyRedisQueues,
  relocateLegacyRedisQueues,
  type LegacyQueueRelocationRedis,
} from '../../src/cache/legacy-cleanup';

function redisGlob(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replaceAll('*', '.*').replaceAll('?', '.')}$`);
}

type FakeValue = { dump: Buffer; ttl: number };

class FakeRedis implements LegacyQueueRelocationRedis {
  readonly values = new Map<string, FakeValue>();

  constructor(
    values: Record<string, { value: string; ttl?: number }> = {},
    private readonly rewriteDumpOnRestore = false,
  ) {
    for (const [key, value] of Object.entries(values)) {
      this.values.set(key, { dump: Buffer.from(value.value), ttl: value.ttl ?? -1 });
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
    return this.values.has(key) ? 'string' : 'none';
  }

  async callBuffer(command: string, ...args: (string | number | Buffer)[]): Promise<unknown> {
    if (command !== 'GET') throw new Error(`Unsupported fake command ${command}`);
    const key = String(args[0]);
    const value = this.values.get(key);
    if (!value) return null;
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
    });
    return 'OK';
  }
}

const SOURCE_VALUES = {
  'bull:data-sync:meta': { value: 'data-meta' },
  'bull:understat-player-sync:completed': { value: 'completed', ttl: 20_000 },
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
    expect(target.values.get('bull:understat-player-sync:completed')?.ttl).toBe(20_000);
    expect(target.values.has('llm:v3:data:fpl:core:2627:active')).toBe(false);
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
