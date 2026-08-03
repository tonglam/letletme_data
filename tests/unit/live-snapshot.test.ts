import { describe, expect, mock, test } from 'bun:test';
import type Redis from 'ioredis';

import {
  createLiveSnapshotCache,
  LIVE_SNAPSHOT_STAGING_TTL_SECONDS,
  type LiveSnapshotCachePayload,
  type LiveSnapshotPublishOptions,
} from '../../src/cache/live-snapshot-cache';
import {
  parseLiveSnapshotMeta,
  resolveLiveSnapshotPersistence,
  shouldSkipQueuedLiveSnapshot,
  type LiveSnapshotMeta,
} from '../../src/domain/live-snapshot';
import {
  prepareLiveSnapshot,
  syncLiveSnapshot,
  type LiveSnapshotReferenceData,
} from '../../src/services/live-snapshot.service';
import type { RawFPLFixture } from '../../src/types';
import { mockEventLiveResponseFixture } from '../fixtures/event-lives.fixtures';
import { mockRawFPLFixture1 } from '../fixtures/fixtures.fixtures';

class FakeRedis {
  readonly strings = new Map<string, string>();
  readonly hashes = new Map<string, Map<string, string>>();
  readonly ttls = new Map<string, number>();
  incompleteHlenPrefix: string | null = null;
  deleteStagingBeforeEvalPrefix: string | null = null;
  metaBeforeFreshnessEval: string | null = null;
  readonly wrongTypeHashKeys = new Set<string>();

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<'OK'> {
    this.strings.set(key, value);
    return 'OK';
  }

  async hset(key: string, fields: Record<string, string>): Promise<number> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    let created = 0;
    for (const [field, value] of Object.entries(fields)) {
      if (!hash.has(field)) created += 1;
      hash.set(field, value);
    }
    this.hashes.set(key, hash);
    return created;
  }

  multi() {
    const commands: Array<() => Promise<unknown>> = [];
    const chain = {
      hset: (key: string, fields: Record<string, string>) => {
        commands.push(() => this.hset(key, fields));
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

  async hlen(key: string): Promise<number> {
    if (this.wrongTypeHashKeys.has(key)) {
      throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    }
    const actual = this.hashes.get(key)?.size ?? 0;
    return this.incompleteHlenPrefix && key.startsWith(this.incompleteHlenPrefix)
      ? Math.max(0, actual - 1)
      : actual;
  }

  async hmget(key: string, ...fields: string[]): Promise<(string | null)[]> {
    if (this.wrongTypeHashKeys.has(key)) {
      throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    }
    const hash = this.hashes.get(key);
    return fields.map((field) => hash?.get(field) ?? null);
  }

  async exists(...keys: string[]): Promise<number> {
    return keys.filter((key) => this.hashes.has(key) || this.strings.has(key)).length;
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.hashes.delete(key)) deleted += 1;
      if (this.strings.delete(key)) deleted += 1;
      this.ttls.delete(key);
    }
    return deleted;
  }

  async eval(script: string, numberOfKeys: number, ...args: string[]): Promise<number> {
    const keys = args.slice(0, numberOfKeys);
    const argv = args.slice(numberOfKeys);

    if (script.includes('local removed = 0')) {
      return this.del(...keys);
    }

    if (script.includes('current.checkedAt > ARGV[2]')) {
      if (this.metaBeforeFreshnessEval !== null) {
        this.strings.set(keys[0], this.metaBeforeFreshnessEval);
        this.metaBeforeFreshnessEval = null;
      }
      const currentRaw = this.strings.get(keys[0]);
      const current = parseLiveSnapshotMeta(currentRaw ?? null);
      if (current && current.checkedAt > argv[1]) return 0;
      this.strings.set(keys[0], argv[0]);
      return 1;
    }

    const stagedCount = Number(argv[0]);
    const emptyCount = Number(argv[1]);

    if (this.deleteStagingBeforeEvalPrefix) {
      const key = keys
        .slice(0, stagedCount)
        .find((candidate) => candidate.startsWith(this.deleteStagingBeforeEvalPrefix!));
      if (key) this.hashes.delete(key);
    }
    const stagingKeys = keys.slice(0, stagedCount);
    if (stagingKeys.some((key) => !this.hashes.has(key))) {
      throw new Error('missing live snapshot staging key');
    }

    const metaKey = keys[stagedCount * 2 + emptyCount];
    if (this.metaBeforeFreshnessEval !== null) {
      this.strings.set(metaKey, this.metaBeforeFreshnessEval);
      this.metaBeforeFreshnessEval = null;
    }
    const currentRaw = this.strings.get(metaKey);
    const current = parseLiveSnapshotMeta(currentRaw ?? null);
    if (current && current.checkedAt > argv[3]) return -1;

    const targetKeys = keys.slice(stagedCount, stagedCount * 2);
    for (let index = 0; index < stagedCount; index += 1) {
      this.hashes.set(targetKeys[index], new Map(this.hashes.get(stagingKeys[index])!));
      this.ttls.delete(targetKeys[index]);
      this.hashes.delete(stagingKeys[index]);
      this.ttls.delete(stagingKeys[index]);
    }
    for (const key of keys.slice(stagedCount * 2, stagedCount * 2 + emptyCount)) {
      await this.del(key);
    }
    this.strings.set(metaKey, argv[2]);
    return stagedCount;
  }

  parsedMeta(key: string): LiveSnapshotMeta {
    const value = this.strings.get(key);
    if (!value) throw new Error(`Missing metadata ${key}`);
    return JSON.parse(value) as LiveSnapshotMeta;
  }

  stagingKeys(): string[] {
    return [...this.hashes.keys()].filter((key) => key.includes(':staging:'));
  }
}

function liveRawFixture(overrides: Partial<RawFPLFixture> = {}): RawFPLFixture {
  return {
    ...mockRawFPLFixture1,
    event: 1,
    started: true,
    finished: false,
    finished_provisional: false,
    minutes: 54,
    team_h_score: 2,
    team_a_score: 1,
    stats: [
      ...mockRawFPLFixture1.stats,
      {
        identifier: 'bps',
        h: [
          { element: 350, value: 45 },
          { element: 567, value: 5 },
        ],
        a: [{ element: 234, value: 28 }],
      },
    ],
    ...overrides,
  };
}

function referenceData(): LiveSnapshotReferenceData {
  return {
    nameById: new Map([
      [4, 'Burnley'],
      [12, 'Liverpool'],
    ]),
    shortNameById: new Map([
      [4, 'BUR'],
      [12, 'LIV'],
    ]),
    positionById: new Map([
      [4, 16],
      [12, 1],
    ]),
    playerTeamById: new Map([
      [350, 12],
      [234, 4],
      [567, 12],
    ]),
  };
}

function cachePayload(score = 2, checkedAt = new Date('2025-08-15T20:00:00.000Z')) {
  const prepared = prepareLiveSnapshot(
    1,
    mockEventLiveResponseFixture,
    [liveRawFixture({ team_h_score: score })],
    referenceData(),
    [1],
  );
  const payload: LiveSnapshotCachePayload = {
    eventId: 1,
    state: prepared.state,
    eventLives: prepared.eventLives.eventLives,
    fixtures: prepared.fixtures,
    liveFixtures: prepared.fixtureViews.legacy,
    liveFixturesV2: prepared.fixtureViews.v2,
    liveBonus: prepared.liveBonus,
    liveBonusV2: prepared.liveBonusV2,
    checkedAt,
  };
  return { payload, prepared };
}

function cacheWith(redis: FakeRedis) {
  return createLiveSnapshotCache({
    getRedisClient: async () => redis as unknown as Redis,
    getSeason: async () => '2526',
  });
}

describe('prepareLiveSnapshot', () => {
  test('derives coherent live views and fixture-scoped bonus from one upstream pair', () => {
    const { prepared } = cachePayload();

    expect(prepared.state).toBe('live');
    expect(prepared.eventLives.eventLives).toHaveLength(3);
    expect(prepared.fixtureViews.legacy['12'].Playing[0]).not.toHaveProperty('fixtureId');
    expect(prepared.fixtureViews.v2['12'].Playing[0].fixtureId).toBe(1);
    expect(prepared.fixtureViews.v2['4'].Playing[0].againstId).toBe(12);
    expect(prepared.liveBonusV2).toEqual({
      '4': { '234': 2 },
      '12': { '350': 3, '567': 1 },
    });
    // Preserve the frozen legacy contract while V2 uses fixture-scoped BPS.
    expect(prepared.liveBonus).toEqual({
      '4': { '234': 1 },
      '12': { '350': 3 },
    });
  });

  test('rejects mixed events and missing fixture reference data', () => {
    expect(() =>
      prepareLiveSnapshot(
        1,
        mockEventLiveResponseFixture,
        [liveRawFixture({ event: 2 })],
        referenceData(),
        [1],
      ),
    ).toThrow('mixed event 2');

    const references = referenceData();
    references.nameById.delete(12);
    expect(() =>
      prepareLiveSnapshot(1, mockEventLiveResponseFixture, [liveRawFixture()], references, [1]),
    ).toThrow('team metadata for IDs: 12');
  });

  test('rejects duplicate live element IDs before deriving publishable views', () => {
    expect(() =>
      prepareLiveSnapshot(
        1,
        {
          elements: [
            ...mockEventLiveResponseFixture.elements,
            mockEventLiveResponseFixture.elements[0],
          ],
        },
        [liveRawFixture()],
        referenceData(),
        [1],
      ),
    ).toThrow('duplicate element IDs for event 1');
  });

  test('rejects a truncated live element response against the player baseline', () => {
    const missingElement = mockEventLiveResponseFixture.elements.at(-1)!;
    expect(() =>
      prepareLiveSnapshot(
        1,
        { elements: mockEventLiveResponseFixture.elements.slice(0, -1) },
        [liveRawFixture()],
        referenceData(),
        [1],
      ),
    ).toThrow(
      `Player identity mismatch for live snapshot event 1; missing expected IDs: ${missingElement.id}; unexpected IDs: none`,
    );
  });

  test('rejects a partially transformed fixture response', () => {
    expect(() =>
      prepareLiveSnapshot(
        1,
        mockEventLiveResponseFixture,
        [liveRawFixture(), liveRawFixture({ id: 2, code: 2, team_h_difficulty: 6 })],
        referenceData(),
        [1, 2],
      ),
    ).toThrow('Incomplete fixture transformation for live snapshot event 1; missing IDs: 2');
  });

  test('rejects a truncated fixture response against the persisted identity baseline', () => {
    expect(() =>
      prepareLiveSnapshot(
        1,
        mockEventLiveResponseFixture,
        [liveRawFixture()],
        referenceData(),
        [1, 2],
      ),
    ).toThrow(
      'Fixture identity mismatch for live snapshot event 1; missing expected IDs: 2; unexpected IDs: none',
    );
  });
});

describe('queued live snapshot window policy', () => {
  test('skips only cache-only cron work after the match window closes', () => {
    expect(shouldSkipQueuedLiveSnapshot('cron', false, false)).toBe(true);
    expect(shouldSkipQueuedLiveSnapshot('cron', true, false)).toBe(false);
    expect(shouldSkipQueuedLiveSnapshot('cron', false, true)).toBe(false);
    expect(shouldSkipQueuedLiveSnapshot('manual', false, false)).toBe(false);
    expect(shouldSkipQueuedLiveSnapshot('cascade', true, false)).toBe(false);
  });

  test('routes every legacy live-view job through the coherent publisher', () => {
    expect(resolveLiveSnapshotPersistence('live-snapshot', false)).toBe(false);
    expect(resolveLiveSnapshotPersistence('live-snapshot', true)).toBe(true);
    expect(resolveLiveSnapshotPersistence('event-lives-db')).toBe(true);
    for (const jobName of [
      'event-lives-cache',
      'live-fixture-cache',
      'live-bonus-cache',
      'live-scores',
    ]) {
      expect(resolveLiveSnapshotPersistence(jobName)).toBe(false);
    }
    expect(resolveLiveSnapshotPersistence('event-live-summary')).toBeNull();
  });
});

describe('live snapshot cache publication', () => {
  test('atomically publishes all views and only advances revision for football changes', async () => {
    const redis = new FakeRedis();
    const cache = cacheWith(redis);
    const first = await cache.publish(cachePayload().payload);

    expect(first.changed).toBe(true);
    expect(redis.stagingKeys()).toEqual([]);
    expect(redis.hashes.has('EventLive:2526:1')).toBe(true);
    expect(redis.hashes.has('Fixtures:2526:1')).toBe(true);
    expect(redis.hashes.has('LiveFixture:2526:1')).toBe(true);
    expect(redis.hashes.has('LiveFixtureV2:2526:1')).toBe(true);
    expect(redis.hashes.has('LiveBonus:2526:1')).toBe(true);
    expect(redis.hashes.has('LiveBonusV2:2526:1')).toBe(true);
    expect(redis.ttls.has('Fixtures:2526:1')).toBe(false);

    const second = await cache.publish(
      cachePayload(2, new Date('2025-08-15T20:01:00.000Z')).payload,
    );
    expect(second.changed).toBe(false);
    expect(second.meta.revision).toBe(first.meta.revision);
    expect(second.meta.publishedAt).toBe(first.meta.publishedAt);
    expect(second.meta.checkedAt).toBe('2025-08-15T20:01:00.000Z');

    const third = await cache.publish(
      cachePayload(3, new Date('2025-08-15T20:02:00.000Z')).payload,
    );
    expect(third.changed).toBe(true);
    expect(third.meta.revision).not.toBe(first.meta.revision);
    expect(third.meta.publishedAt).toBe('2025-08-15T20:02:00.000Z');
  });

  test('keeps the prior complete revision and cleans staging keys on a partial write', async () => {
    const redis = new FakeRedis();
    const cache = cacheWith(redis);
    const first = await cache.publish(cachePayload().payload);
    const oldFixtures = new Map(redis.hashes.get('Fixtures:2526:1'));

    redis.incompleteHlenPrefix = 'Fixtures:2526:1:staging:';
    await expect(cache.publish(cachePayload(4).payload)).rejects.toThrow(
      'Incomplete live snapshot staging hash Fixtures:2526:1',
    );

    expect(redis.hashes.get('Fixtures:2526:1')).toEqual(oldFixtures);
    expect(redis.parsedMeta('LiveSnapshotMeta:2526:1').revision).toBe(first.meta.revision);
    expect(redis.stagingKeys()).toEqual([]);
  });

  test('does not partially publish when a verified staging key disappears before commit', async () => {
    const redis = new FakeRedis();
    const cache = cacheWith(redis);
    const first = await cache.publish(cachePayload().payload);
    const publishedKeys = [
      'EventLive:2526:1',
      'Fixtures:2526:1',
      'LiveFixture:2526:1',
      'LiveFixtureV2:2526:1',
      'LiveBonus:2526:1',
      'LiveBonusV2:2526:1',
    ];
    const previousViews = new Map(
      publishedKeys.map((key) => [key, new Map(redis.hashes.get(key))]),
    );

    redis.deleteStagingBeforeEvalPrefix = 'LiveFixtureV2:2526:1:staging:';
    await expect(cache.publish(cachePayload(4).payload)).rejects.toThrow(
      'missing live snapshot staging key',
    );

    for (const key of publishedKeys) {
      expect(redis.hashes.get(key)).toEqual(previousViews.get(key)!);
    }
    expect(redis.parsedMeta('LiveSnapshotMeta:2526:1').revision).toBe(first.meta.revision);
    expect(redis.stagingKeys()).toEqual([]);
  });

  test('repairs a missing required view even when the content revision is unchanged', async () => {
    const redis = new FakeRedis();
    const cache = cacheWith(redis);
    const first = await cache.publish(cachePayload().payload);
    redis.hashes.delete('LiveFixtureV2:2526:1');

    const repaired = await cache.publish(cachePayload().payload);
    expect(repaired.changed).toBe(true);
    expect(repaired.meta.revision).toBe(first.meta.revision);
    expect(redis.hashes.has('LiveFixtureV2:2526:1')).toBe(true);
  });

  test('repairs a missing populated optional view even when the revision is unchanged', async () => {
    const redis = new FakeRedis();
    const cache = cacheWith(redis);
    const first = await cache.publish(cachePayload().payload);
    redis.hashes.delete('LiveBonusV2:2526:1');

    const repaired = await cache.publish(cachePayload().payload);
    expect(repaired.changed).toBe(true);
    expect(repaired.meta.revision).toBe(first.meta.revision);
    expect(redis.hashes.has('LiveBonusV2:2526:1')).toBe(true);
  });

  test('repairs a partial populated view even when its Redis key still exists', async () => {
    const redis = new FakeRedis();
    const cache = cacheWith(redis);
    const first = await cache.publish(cachePayload().payload);
    const eventLive = redis.hashes.get('EventLive:2526:1');
    eventLive?.delete(eventLive.keys().next().value!);

    const repaired = await cache.publish(cachePayload().payload);
    expect(repaired.changed).toBe(true);
    expect(repaired.meta.revision).toBe(first.meta.revision);
    expect(redis.hashes.get('EventLive:2526:1')?.size).toBe(
      cachePayload().payload.eventLives.length,
    );
  });

  test('repairs a same-length view whose contents no longer match its revision', async () => {
    const redis = new FakeRedis();
    const cache = cacheWith(redis);
    const first = await cache.publish(cachePayload().payload);
    redis.hashes.get('Fixtures:2526:1')?.set('1', '{"independentWriter":true}');

    const repaired = await cache.publish(cachePayload().payload);
    expect(repaired.changed).toBe(true);
    expect(repaired.meta.revision).toBe(first.meta.revision);
    expect(redis.hashes.get('Fixtures:2526:1')?.get('1')).not.toContain('independentWriter');
  });

  test('replaces a wrong-type populated view instead of wedging publication', async () => {
    const redis = new FakeRedis();
    const cache = cacheWith(redis);
    const first = await cache.publish(cachePayload().payload);
    redis.wrongTypeHashKeys.add('LiveFixtureV2:2526:1');

    const repaired = await cache.publish(cachePayload().payload);
    expect(repaired.changed).toBe(true);
    expect(repaired.meta.revision).toBe(first.meta.revision);
    expect(redis.hashes.has('LiveFixtureV2:2526:1')).toBe(true);
  });

  test('replaces schema-invalid metadata instead of treating it as a freshness fence', async () => {
    const redis = new FakeRedis();
    const cache = cacheWith(redis);
    await cache.publish(cachePayload().payload);
    redis.strings.set(
      'LiveSnapshotMeta:2526:1',
      JSON.stringify({
        ...redis.parsedMeta('LiveSnapshotMeta:2526:1'),
        publishedAt: '9999-99-99T99:99:99.999Z',
        checkedAt: '9999-99-99T99:99:99.999Z',
      }),
    );

    const repaired = await cache.publish(
      cachePayload(4, new Date('2025-08-15T20:01:00.000Z')).payload,
    );

    expect(repaired).toMatchObject({ changed: true, stale: false });
    expect(redis.parsedMeta('LiveSnapshotMeta:2526:1').checkedAt).toBe('2025-08-15T20:01:00.000Z');
  });

  test('metadata-only refresh replaces a decoded primitive introduced after its read', async () => {
    const redis = new FakeRedis();
    const cache = cacheWith(redis);
    const first = await cache.publish(cachePayload().payload);
    redis.metaBeforeFreshnessEval = '7';

    const refreshed = await cache.publish(
      cachePayload(2, new Date('2025-08-15T20:01:00.000Z')).payload,
    );

    expect(refreshed).toMatchObject({ changed: false, stale: false });
    expect(refreshed.meta.revision).toBe(first.meta.revision);
    expect(redis.parsedMeta('LiveSnapshotMeta:2526:1').checkedAt).toBe('2025-08-15T20:01:00.000Z');
  });

  test('keeps the old revision when durable persistence fails before commit and retries it', async () => {
    const redis = new FakeRedis();
    const cache = cacheWith(redis);
    const first = await cache.publish(cachePayload().payload);
    const oldFixtures = new Map(redis.hashes.get('Fixtures:2526:1'));
    const changedPayload = cachePayload(4).payload;

    await expect(
      cache.publish(changedPayload, {
        beforeCommit: async () => {
          const stagingKeys = redis.stagingKeys();
          expect(stagingKeys.length).toBeGreaterThan(0);
          expect(
            stagingKeys.every((key) => redis.ttls.get(key) === LIVE_SNAPSHOT_STAGING_TTL_SECONDS),
          ).toBe(true);
          throw new Error('fixture persistence unavailable');
        },
      }),
    ).rejects.toThrow('fixture persistence unavailable');

    expect(redis.hashes.get('Fixtures:2526:1')).toEqual(oldFixtures);
    expect(redis.parsedMeta('LiveSnapshotMeta:2526:1').revision).toBe(first.meta.revision);
    expect(redis.stagingKeys()).toEqual([]);

    const persist = mock(async () => {});
    const retried = await cache.publish(changedPayload, { beforeCommit: persist });
    expect(retried.changed).toBe(true);
    expect(retried.meta.revision).not.toBe(first.meta.revision);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  test('rejects an older publisher without replacing newer views', async () => {
    const redis = new FakeRedis();
    const cache = cacheWith(redis);
    const newer = await cache.publish(
      cachePayload(3, new Date('2025-08-15T20:00:02.000Z')).payload,
    );
    const beforeCommit = mock(async () => {});

    const stale = await cache.publish(
      cachePayload(4, new Date('2025-08-15T20:00:01.000Z')).payload,
      { beforeCommit },
    );

    expect(stale).toMatchObject({ changed: false, stale: true });
    expect(stale.meta.revision).toBe(newer.meta.revision);
    expect(beforeCommit).not.toHaveBeenCalled();
    expect(JSON.parse(redis.hashes.get('Fixtures:2526:1')!.get('1')!)).toMatchObject({
      teamHScore: 3,
    });
    expect(redis.stagingKeys()).toEqual([]);
  });

  test('retires metadata and every coordinated live view atomically', async () => {
    const redis = new FakeRedis();
    const cache = cacheWith(redis);
    await cache.publish(cachePayload().payload);

    const retired = await cache.retire(1);

    expect(retired).toEqual({ eventId: 1, removedKeys: 7 });
    for (const prefix of [
      'EventLive',
      'Fixtures',
      'LiveFixture',
      'LiveFixtureV2',
      'LiveBonus',
      'LiveBonusV2',
      'LiveSnapshotMeta',
    ]) {
      expect(await redis.exists(`${prefix}:2526:1`)).toBe(0);
    }
  });
});

describe('syncLiveSnapshot', () => {
  test('does not publish or persist a response with duplicate live element IDs', async () => {
    const publish = mock(async () => {
      throw new Error('publish must not be called');
    });
    const persistFixtures = mock(async () => []);
    const persistEventLives = mock(async () => []);

    await expect(
      syncLiveSnapshot(1, {
        persistEventLives: true,
        dependencies: {
          getEventLive: async () => ({
            elements: [
              ...mockEventLiveResponseFixture.elements,
              mockEventLiveResponseFixture.elements[0],
            ],
          }),
          getFixtures: async () => [liveRawFixture()],
          getExpectedFixtureIds: async () => [1],
          getReferenceData: async () => referenceData(),
          serialize: async (_eventId, operation) => operation(new Date('2025-08-15T20:00:00.000Z')),
          publish,
          persistFixtures,
          persistEventLives,
        },
      }),
    ).rejects.toThrow('duplicate element IDs for event 1');

    expect(publish).not.toHaveBeenCalled();
    expect(persistFixtures).not.toHaveBeenCalled();
    expect(persistEventLives).not.toHaveBeenCalled();
  });

  test('fetches independent inputs concurrently and persists changed fixtures before commit', async () => {
    const calls: string[] = [];
    const publish = mock(
      async (payload: LiveSnapshotCachePayload, options: LiveSnapshotPublishOptions = {}) => {
        calls.push('publish-stage');
        expect(payload.checkedAt).toEqual(new Date('2025-08-15T20:00:00.000Z'));
        await options.beforeCommit?.();
        calls.push('publish-commit');
        return {
          changed: true,
          stale: false,
          meta: {
            schemaVersion: 1 as const,
            season: '2526',
            eventId: payload.eventId,
            revision: 'a'.repeat(24),
            state: payload.state,
            publishedAt: '2025-08-15T20:00:00.000Z',
            checkedAt: '2025-08-15T20:00:00.000Z',
            eventLiveCount: payload.eventLives.length,
            fixtureCount: payload.fixtures.length,
            fixtureTeamCount: Object.keys(payload.liveFixturesV2).length,
            bonusTeamCount: Object.keys(payload.liveBonusV2).length,
          },
        };
      },
    );
    let started = 0;
    const markStart = <T>(name: string, value: T): Promise<T> => {
      calls.push(name);
      started += 1;
      return Promise.resolve(value);
    };
    const persistFixtures = mock(async () => {
      calls.push('persist-fixtures');
      return [];
    });
    const persistEventLives = mock(async () => {
      calls.push('persist-event-lives');
      return [];
    });

    const result = await syncLiveSnapshot(1, {
      persistEventLives: true,
      dependencies: {
        serialize: async (_eventId, operation) => {
          calls.push('serialize-enter');
          const value = await operation(new Date('2025-08-15T20:00:00.000Z'));
          calls.push('serialize-exit');
          return value;
        },
        getEventLive: () => markStart('fetch-live', mockEventLiveResponseFixture),
        getFixtures: () => markStart('fetch-fixtures', [liveRawFixture()]),
        getExpectedFixtureIds: () => markStart('fetch-expected', [1]),
        getReferenceData: () => markStart('fetch-reference', referenceData()),
        publish,
        persistFixtures,
        persistEventLives,
      },
    });

    expect(started).toBe(4);
    expect(calls[0]).toBe('serialize-enter');
    expect(calls.slice(1, 5).sort()).toEqual([
      'fetch-expected',
      'fetch-fixtures',
      'fetch-live',
      'fetch-reference',
    ]);
    expect(calls.indexOf('publish-stage')).toBeLessThan(calls.indexOf('persist-fixtures'));
    expect(calls.indexOf('persist-fixtures')).toBeLessThan(calls.indexOf('publish-commit'));
    expect(calls.indexOf('publish-commit')).toBeLessThan(calls.indexOf('persist-event-lives'));
    expect(calls.at(-1)).toBe('serialize-exit');
    expect(result).toMatchObject({
      changed: true,
      stale: false,
      revision: 'a'.repeat(24),
      state: 'live',
      persistedFixtures: true,
      persistedEventLives: true,
    });
  });

  test('skips unchanged fixture upserts while retaining the sparse event-live checkpoint', async () => {
    const persistFixtures = mock(async () => []);
    const persistEventLives = mock(async () => []);

    const result = await syncLiveSnapshot(1, {
      persistEventLives: true,
      dependencies: {
        getEventLive: async () => mockEventLiveResponseFixture,
        getFixtures: async () => [liveRawFixture()],
        getExpectedFixtureIds: async () => [1],
        getReferenceData: async () => referenceData(),
        serialize: async (_eventId, operation) => operation(new Date('2025-08-15T20:10:00.000Z')),
        publish: async (payload) => ({
          changed: false,
          stale: false,
          meta: {
            schemaVersion: 1 as const,
            season: '2526',
            eventId: payload.eventId,
            revision: 'b'.repeat(24),
            state: payload.state,
            publishedAt: '2025-08-15T20:00:00.000Z',
            checkedAt: '2025-08-15T20:10:00.000Z',
            eventLiveCount: payload.eventLives.length,
            fixtureCount: payload.fixtures.length,
            fixtureTeamCount: Object.keys(payload.liveFixturesV2).length,
            bonusTeamCount: Object.keys(payload.liveBonusV2).length,
          },
        }),
        persistFixtures,
        persistEventLives,
      },
    });

    expect(persistFixtures).not.toHaveBeenCalled();
    expect(persistEventLives).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      changed: false,
      stale: false,
      persistedFixtures: false,
      persistedEventLives: true,
    });
  });

  test('does not persist stale event-live checkpoints', async () => {
    const persistFixtures = mock(async () => []);
    const persistEventLives = mock(async () => []);

    const result = await syncLiveSnapshot(1, {
      persistEventLives: true,
      dependencies: {
        getEventLive: async () => mockEventLiveResponseFixture,
        getFixtures: async () => [liveRawFixture()],
        getExpectedFixtureIds: async () => [1],
        getReferenceData: async () => referenceData(),
        serialize: async (_eventId, operation) => operation(new Date('2025-08-15T20:00:00.000Z')),
        publish: async (payload) => ({
          changed: false,
          stale: true,
          meta: {
            schemaVersion: 1 as const,
            season: '2526',
            eventId: payload.eventId,
            revision: 'c'.repeat(24),
            state: payload.state,
            publishedAt: '2025-08-15T20:00:01.000Z',
            checkedAt: '2025-08-15T20:00:01.000Z',
            eventLiveCount: payload.eventLives.length,
            fixtureCount: payload.fixtures.length,
            fixtureTeamCount: Object.keys(payload.liveFixturesV2).length,
            bonusTeamCount: Object.keys(payload.liveBonusV2).length,
          },
        }),
        persistFixtures,
        persistEventLives,
      },
    });

    expect(persistFixtures).not.toHaveBeenCalled();
    expect(persistEventLives).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      changed: false,
      stale: true,
      persistedFixtures: false,
      persistedEventLives: false,
    });
  });
});
