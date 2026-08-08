import { describe, expect, test } from 'bun:test';
import type Redis from 'ioredis';

import { createUnderstatCache, UNDERSTAT_ACTIVE_SEASON_KEY } from '../../src/cache/understat-cache';

class FakeRedis {
  readonly strings = new Map<string, string>();
  readonly hashes = new Map<string, Map<string, string>>();
  readonly ttls = new Map<string, number>();
  readonly hsetCalls: number[] = [];
  failNextTransaction = false;

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async hlen(key: string): Promise<number> {
    return this.hashes.get(key)?.size ?? 0;
  }

  private async del(key: string): Promise<number> {
    const existed = this.hashes.delete(key) || this.strings.delete(key);
    this.ttls.delete(key);
    return existed ? 1 : 0;
  }

  private async hset(key: string, values: Record<string, string>): Promise<number> {
    this.hsetCalls.push(Object.keys(values).length);
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    for (const [field, value] of Object.entries(values)) hash.set(field, value);
    this.hashes.set(key, hash);
    return Object.keys(values).length;
  }

  pipeline() {
    const commands: Array<() => Promise<unknown>> = [];
    const chain = {
      del: (key: string) => {
        commands.push(() => this.del(key));
        return chain;
      },
      hset: (key: string, values: Record<string, string>) => {
        commands.push(() => this.hset(key, values));
        return chain;
      },
      expire: (key: string, seconds: number) => {
        commands.push(async () => {
          this.ttls.set(key, seconds);
          return 1;
        });
        return chain;
      },
      exec: async () => {
        const results: Array<[null, unknown]> = [];
        for (const command of commands) results.push([null, await command()]);
        return results;
      },
    };
    return chain;
  }

  multi() {
    const commands: Array<() => Promise<unknown>> = [];
    const chain = {
      set: (key: string, value: string) => {
        commands.push(async () => {
          this.strings.set(key, value);
          return 'OK';
        });
        return chain;
      },
      persist: (key: string) => {
        commands.push(async () => {
          this.ttls.delete(key);
          return 1;
        });
        return chain;
      },
      expire: (key: string, seconds: number) => {
        commands.push(async () => {
          this.ttls.set(key, seconds);
          return 1;
        });
        return chain;
      },
      exec: async () => {
        if (this.failNextTransaction) {
          this.failNextTransaction = false;
          return [[new Error('transaction failed'), null] as [Error, null]];
        }
        const results: Array<[null, unknown]> = [];
        for (const command of commands) results.push([null, await command()]);
        return results;
      },
    };
    return chain;
  }
}

const teamSnapshot = {
  teams: [{ team: { id: 1 }, season: { season: '2627', teamId: 1 } }],
  matches: [{ id: 10 }],
  teamMatchRows: [{ stat: { teamId: 1 }, match: { id: 10 } }],
  splits: [{ teamId: 1, dimension: 'result' }],
};

const playerSnapshot = {
  players: [{ player: { id: 100 }, season: { season: '2627', playerId: 100 } }],
  memberships: [{ playerId: 100, teamId: 1 }],
  matchStats: [{ stat: { playerId: 100 }, match: { id: 10 } }],
};

describe('Understat generation cache', () => {
  test('publishes team and player manifests independently', async () => {
    const redis = new FakeRedis();
    const cache = createUnderstatCache({ getRedisClient: async () => redis as unknown as Redis });
    await cache.publishTeam('2627', 'team-run', teamSnapshot as never);
    await cache.publishPlayer('2627', 'player-run', playerSnapshot as never);
    expect((await cache.getManifest('2627', 'team'))?.revision).toBe('team-run');
    expect((await cache.getManifest('2627', 'player'))?.revision).toBe('player-run');
  });

  test('keeps the old manifest when the atomic switch fails', async () => {
    const redis = new FakeRedis();
    const cache = createUnderstatCache({ getRedisClient: async () => redis as unknown as Redis });
    await cache.publishTeam('2627', 'first', teamSnapshot as never);
    redis.failNextTransaction = true;
    await expect(cache.publishTeam('2627', 'second', teamSnapshot as never)).rejects.toThrow(
      'transaction failed',
    );
    expect((await cache.getManifest('2627', 'team'))?.revision).toBe('first');
  });

  test('retires only the explicit previous generation for 24 hours', async () => {
    const redis = new FakeRedis();
    const cache = createUnderstatCache({ getRedisClient: async () => redis as unknown as Redis });
    await cache.publishTeam('2627', 'first', teamSnapshot as never);
    await cache.publishTeam('2627', 'second', teamSnapshot as never);
    expect(redis.ttls.get('Understat:Team:2627:first')).toBe(86_400);
    expect(redis.ttls.has('Understat:Team:2627:second')).toBe(false);
  });

  test('does not change the active season when publishing a historical backfill', async () => {
    const redis = new FakeRedis();
    redis.strings.set(UNDERSTAT_ACTIVE_SEASON_KEY, '2728');
    const cache = createUnderstatCache({
      getRedisClient: async () => redis as unknown as Redis,
      getActiveSeason: () => '2728',
    });

    await cache.publishTeam('2627', 'historical-team-run', teamSnapshot as never);

    expect(redis.strings.get(UNDERSTAT_ACTIVE_SEASON_KEY)).toBe('2728');
    expect((await cache.getManifest('2627', 'team'))?.revision).toBe('historical-team-run');
  });

  test('chunks large generation hashes into bounded Redis writes', async () => {
    const redis = new FakeRedis();
    const cache = createUnderstatCache({ getRedisClient: async () => redis as unknown as Redis });
    const players = Array.from({ length: 80 }, (_, index) => ({
      player: { id: index + 1 },
      season: { season: '2627', playerId: index + 1 },
    }));
    const memberships = players.map((row) => ({ playerId: row.player.id, teamId: 1 }));
    const matchStats = players.flatMap((row) =>
      Array.from({ length: 100 }, (_, index) => ({
        stat: { playerId: row.player.id, payload: 'x'.repeat(250) },
        match: { id: index + 1 },
      })),
    );

    await cache.publishPlayer('2627', 'large-player-run', {
      players,
      memberships,
      matchStats,
    } as never);

    expect(redis.hsetCalls.length).toBeGreaterThan(3);
    expect((await cache.getManifest('2627', 'player'))?.revision).toBe('large-player-run');
  });
});
