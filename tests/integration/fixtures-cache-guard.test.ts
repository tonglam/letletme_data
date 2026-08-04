import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { resetActiveSeasonMemo } from '../../src/cache/cache-season';
import { eventLivesCache } from '../../src/cache/event-lives-cache';
import { fixturesCache } from '../../src/cache/fixtures-cache';
import { liveBonusCache, liveBonusV2Cache } from '../../src/cache/live-bonus-cache';
import { liveFixturesCache } from '../../src/cache/live-fixtures-cache';
import { liveSnapshotCache } from '../../src/cache/live-snapshot-cache';
import { redisSingleton } from '../../src/cache/singleton';
import type { EventLive } from '../../src/domain/event-lives';
import type { LiveFixturesByTeam } from '../../src/domain/live-fixtures';
import type { Fixture } from '../../src/types';

/**
 * FP-12 (H8) integration: the FixturesByTeam writer must not wipe the view
 * when the team cache is empty.
 *
 * Fresh deploys sync fixtures before teams; with an empty Team:{season}
 * hash the old code deleted every FixturesByTeam:{season}:* key and rebuilt
 * nothing. The guarded writer skips the delete+rebuild instead.
 *
 * Env-guarded (FP-02 / Codex P1): refuses to run unless RUN_INTEGRATION=1 and
 * Redis DB indexes are non-zero, so a default `bun test` cannot wipe shared
 * fixture caches via finalizeSeasonCacheWrite.
 */

const SEASON = '9899';

function buildFixture(id: number, eventId: number, teamH: number, teamA: number): Fixture {
  return {
    id,
    code: id,
    event: eventId,
    finished: false,
    finishedProvisional: false,
    kickoffTime: null,
    minutes: 0,
    provisionalStartTime: false,
    started: true,
    teamA,
    teamAScore: null,
    teamH,
    teamHScore: null,
    stats: [],
    teamHDifficulty: 3,
    teamADifficulty: 3,
    pulseId: id,
    createdAt: null,
    updatedAt: null,
  };
}

const FIXTURES = [buildFixture(101, 10, 1, 2), buildFixture(102, 10, 3, 4)];

let previousActiveSeason: string | null = null;

beforeAll(async () => {
  const redis = await redisSingleton.getClient();
  previousActiveSeason = await redis.get('Season:active');
});

afterAll(async () => {
  const redis = await redisSingleton.getClient();
  const staleKeys = await redis.keys('*:' + SEASON + ':*');
  if (staleKeys.length > 0) {
    await redis.del(...staleKeys);
  }
  await redis.del(`Team:${SEASON}`);
  if (previousActiveSeason !== null) {
    await redis.set('Season:active', previousActiveSeason);
  } else {
    await redis.del('Season:active');
  }
  resetActiveSeasonMemo();
});

describe('FixturesByTeam empty-teams guard (FP-12)', () => {
  test('fixtures-before-teams sync keeps existing FixturesByTeam keys', async () => {
    const redis = await redisSingleton.getClient();

    // Given: a populated FixturesByTeam view and NO team metadata
    await redis.hset(`FixturesByTeam:${SEASON}:1`, '10', '{"id":1,"preExisting":true}');
    await redis.del(`Team:${SEASON}`);

    // When: fixtures sync runs before teams have landed
    await fixturesCache.set(FIXTURES, SEASON);

    // Then: the pre-existing view survived — no wipe
    const view = await redis.hgetall(`FixturesByTeam:${SEASON}:1`);
    expect(view['10']).toBe('{"id":1,"preExisting":true}');

    // And: the Fixtures:{season} per-event keys were still written
    const eventKeys = await redis.hgetall(`Fixtures:${SEASON}:10`);
    expect(Object.keys(eventKeys).sort()).toEqual(['101', '102']);
  });

  test('sync with teams present rebuilds the FixturesByTeam view', async () => {
    const redis = await redisSingleton.getClient();

    // Given: team metadata plus a stale field from the previous test
    await redis.hset(
      `Team:${SEASON}`,
      '1',
      JSON.stringify({ name: 'Alpha', shortName: 'ALP' }),
      '2',
      JSON.stringify({ name: 'Beta', shortName: 'BET' }),
      '3',
      JSON.stringify({ name: 'Gamma', shortName: 'GAM' }),
      '4',
      JSON.stringify({ name: 'Delta', shortName: 'DEL' }),
    );

    // When: fixtures sync runs with teams available
    await fixturesCache.set(FIXTURES, SEASON);

    // Then: the view was rebuilt from the fixtures — stale field gone
    const teamOne = await redis.hgetall(`FixturesByTeam:${SEASON}:1`);
    expect(teamOne['10']).toBeDefined();
    expect(JSON.parse(teamOne['10'])).toMatchObject({ againstTeamId: 2 });
    expect(teamOne['10']).not.toContain('preExisting');

    const teamThree = await redis.hgetall(`FixturesByTeam:${SEASON}:3`);
    expect(JSON.parse(teamThree['10'])).toMatchObject({ againstTeamId: 4 });
  });

  test('removing one reassigned fixture preserves other unscheduled fixtures', async () => {
    const redis = await redisSingleton.getClient();
    await redis.set('Season:active', SEASON);
    resetActiveSeasonMemo();
    await redis.hset(
      `Fixtures:${SEASON}:unscheduled`,
      '90101',
      'reassigned',
      '90102',
      'still-unscheduled',
    );

    await fixturesCache.removeUnscheduledFixtureIds([90101, 90101, -1]);

    expect(await redis.hget(`Fixtures:${SEASON}:unscheduled`, '90101')).toBeNull();
    expect(await redis.hget(`Fixtures:${SEASON}:unscheduled`, '90102')).toBe('still-unscheduled');
  });

  test('full refreshes and compatibility helpers preserve snapshot-owned event hashes', async () => {
    const redis = await redisSingleton.getClient();
    await redis.set('Season:active', SEASON);
    await redis.set(
      `LiveSnapshotMeta:${SEASON}:10`,
      JSON.stringify({
        schemaVersion: 1,
        season: SEASON,
        eventId: 10,
        revision: 'a'.repeat(24),
        state: 'settled',
        publishedAt: '2026-08-03T00:00:00.000Z',
        checkedAt: '2026-08-03T00:00:00.000Z',
        eventLiveCount: 1,
        fixtureCount: 1,
        fixtureTeamCount: 1,
        bonusTeamCount: 1,
      }),
    );

    const sentinels = {
      [`Fixtures:${SEASON}:10`]: ['snapshot-fixture', 'fixture-v1'],
      [`EventLive:${SEASON}:10`]: ['snapshot-player', 'event-live-v1'],
      [`LiveFixture:${SEASON}:10`]: ['snapshot-team', 'live-fixture-v1'],
      [`LiveFixtureV2:${SEASON}:10`]: ['snapshot-team', 'live-fixture-v2-v1'],
      [`LiveBonus:${SEASON}:10`]: ['snapshot-team', 'live-bonus-v1'],
      [`LiveBonusV2:${SEASON}:10`]: ['snapshot-team', 'live-bonus-v2-v1'],
    } as const;
    for (const [key, [field, value]] of Object.entries(sentinels)) {
      await redis.del(key);
      await redis.hset(key, field, value);
    }

    const refreshedEvent10 = buildFixture(201, 10, 1, 2);
    const refreshedEvent11 = buildFixture(202, 11, 3, 4);
    await fixturesCache.set([refreshedEvent10, refreshedEvent11], SEASON);
    await eventLivesCache.set(10, [{ eventId: 10, elementId: 1 } as EventLive]);
    await liveFixturesCache.set(10, {
      '1': { Not_Start: [], Playing: [], Finished: [] },
    } as LiveFixturesByTeam);
    await liveBonusCache.set(10, { '1': { '1': 3 } });
    await liveBonusV2Cache.set(10, { '1': { '1': 3 } });
    expect(Object.keys(await redis.hgetall(`Fixtures:${SEASON}:11`))).toEqual(['202']);
    await Promise.all([
      fixturesCache.clear(),
      liveFixturesCache.clear(10),
      liveBonusCache.clear(10),
      liveBonusV2Cache.clear(10),
    ]);

    for (const [key, [field, value]] of Object.entries(sentinels)) {
      expect(await redis.hget(key, field)).toBe(value);
      expect(await redis.hlen(key)).toBe(1);
    }
    expect(await redis.exists(`Fixtures:${SEASON}:11`)).toBe(0);

    // A fixture event move retires metadata and every coordinated view in one
    // Redis script. Ordinary writers can rebuild the now-unmanaged cache.
    expect(await liveSnapshotCache.retire(10)).toEqual({ eventId: 10, removedKeys: 7 });
    for (const prefix of [
      'Fixtures',
      'EventLive',
      'LiveFixture',
      'LiveFixtureV2',
      'LiveBonus',
      'LiveBonusV2',
      'LiveSnapshotMeta',
    ]) {
      expect(await redis.exists(`${prefix}:${SEASON}:10`)).toBe(0);
    }
    await fixturesCache.setByEvent(10, [refreshedEvent10], SEASON);
    expect(Object.keys(await redis.hgetall(`Fixtures:${SEASON}:10`))).toEqual(['201']);
  });
});
