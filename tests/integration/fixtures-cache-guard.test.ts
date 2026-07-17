import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { fixturesCache } from '../../src/cache/fixtures-cache';
import { redisSingleton } from '../../src/cache/singleton';
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
});
