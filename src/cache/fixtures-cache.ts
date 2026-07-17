import type { Redis } from 'ioredis';

import { logDebug, logError } from '../utils/logger';
import { finalizeSeasonCacheWrite, getActiveCacheSeason } from './cache-season';
import { parseHashValues } from './hash-read';
import { redisSingleton } from './singleton';

import type { TeamFixture } from '../domain/fixtures';
import type { Fixture } from '../types';

type TeamInfo = { name: string; shortName: string };

async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';

  do {
    const [nextCursor, found] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    if (found.length > 0) {
      keys.push(...found);
    }
    cursor = nextCursor;
  } while (cursor !== '0');

  return keys;
}

function toTeamFixture(
  fixture: Fixture,
  teamId: number,
  teamById: Map<number, TeamInfo>,
  dgw: boolean,
): TeamFixture {
  const wasHome = fixture.teamH === teamId;
  const againstId = wasHome ? fixture.teamA : fixture.teamH;
  const teamScore = wasHome ? (fixture.teamHScore ?? 0) : (fixture.teamAScore ?? 0);
  const againstScore = wasHome ? (fixture.teamAScore ?? 0) : (fixture.teamHScore ?? 0);
  const difficulty = (wasHome ? fixture.teamHDifficulty : fixture.teamADifficulty) ?? 0;

  let result = '';
  if (fixture.finished) {
    if (teamScore > againstScore) result = 'W';
    else if (teamScore < againstScore) result = 'L';
    else result = 'D';
  }

  return {
    event: fixture.event!,
    teamId,
    teamName: teamById.get(teamId)?.name ?? '',
    teamShortName: teamById.get(teamId)?.shortName ?? '',
    againstTeamId: againstId,
    againstTeamName: teamById.get(againstId)?.name ?? '',
    againstTeamShortName: teamById.get(againstId)?.shortName ?? '',
    difficulty,
    kickoffTime: fixture.kickoffTime ? fixture.kickoffTime.toISOString() : null,
    started: fixture.started ?? false,
    finished: fixture.finished,
    wasHome,
    teamScore,
    againstTeamScore: againstScore,
    score: `${teamScore}-${againstScore}`,
    result,
    bgw: false,
    dgw,
  };
}

// Returns Map<teamId, Map<eventId, TeamFixture>> — unscheduled fixtures (event=null) are excluded
function buildFixturesByTeam(
  teamIds: number[],
  fixtures: Fixture[],
  teamById: Map<number, TeamInfo>,
): Map<number, Map<number, TeamFixture>> {
  // Group raw fixtures per team per event first (to detect DGW)
  const rawMap = new Map<number, Map<number, Fixture[]>>(teamIds.map((id) => [id, new Map()]));
  for (const fixture of fixtures) {
    if (fixture.event === null) continue;
    for (const teamId of [fixture.teamH, fixture.teamA]) {
      const eventMap = rawMap.get(teamId);
      if (!eventMap) continue;
      if (!eventMap.has(fixture.event)) eventMap.set(fixture.event, []);
      eventMap.get(fixture.event)!.push(fixture);
    }
  }

  // Transform to TeamFixture, marking DGW where a team has 2 fixtures in the same event
  const result = new Map<number, Map<number, TeamFixture>>();
  for (const [teamId, eventMap] of rawMap) {
    const teamFixtureMap = new Map<number, TeamFixture>();
    for (const [eventId, eventFixtures] of eventMap) {
      const dgw = eventFixtures.length > 1;
      teamFixtureMap.set(eventId, toTeamFixture(eventFixtures[0], teamId, teamById, dgw));
    }
    result.set(teamId, teamFixtureMap);
  }
  return result;
}

export const fixturesCache = {
  async setByEvent(eventId: number, fixtures: Fixture[], season?: string): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const activeSeason = season ?? (await getActiveCacheSeason());
      const key = `Fixtures:${activeSeason}:${eventId}`;

      const pipeline = redis.pipeline();
      pipeline.del(key);

      if (fixtures.length > 0) {
        const fields: Record<string, string> = {};
        for (const fixture of fixtures) {
          fields[fixture.id.toString()] = JSON.stringify(fixture);
        }
        pipeline.hset(key, fields);
      }

      await pipeline.exec();
      await finalizeSeasonCacheWrite(activeSeason, ['Fixtures']);
      logDebug('Fixtures cache updated by event', {
        eventId,
        count: fixtures.length,
        season: activeSeason,
      });
    } catch (error) {
      logError('Fixtures cache set by event error', error, { eventId });
      throw error;
    }
  },

  async set(fixtures: Fixture[], season?: string): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const activeSeason = season ?? (await getActiveCacheSeason());

      const fixturesByEvent = new Map<number | string, Fixture[]>();
      const unscheduled: Fixture[] = [];

      for (const fixture of fixtures) {
        if (!fixture.event) {
          unscheduled.push(fixture);
        } else {
          if (!fixturesByEvent.has(fixture.event)) {
            fixturesByEvent.set(fixture.event, []);
          }
          fixturesByEvent.get(fixture.event)!.push(fixture);
        }
      }

      const pipeline = redis.pipeline();
      const pattern = `Fixtures:${activeSeason}:*`;
      const existingKeys = await scanKeys(redis, pattern);
      for (const key of existingKeys) {
        pipeline.del(key);
      }

      for (const [eventId, eventFixtures] of fixturesByEvent) {
        const key = `Fixtures:${activeSeason}:${eventId}`;
        const fields: Record<string, string> = {};
        for (const fixture of eventFixtures) {
          fields[fixture.id.toString()] = JSON.stringify(fixture);
        }
        pipeline.hset(key, fields);
      }

      if (unscheduled.length > 0) {
        const key = `Fixtures:${activeSeason}:unscheduled`;
        const fields: Record<string, string> = {};
        for (const fixture of unscheduled) {
          fields[fixture.id.toString()] = JSON.stringify(fixture);
        }
        pipeline.hset(key, fields);
      }

      await pipeline.exec();

      // Write FixturesByTeam:{season}:{teamId} — team IDs and names from Team:{season}
      const teamRaw = await redis.hgetall(`Team:${activeSeason}`);
      const teamById = new Map<number, TeamInfo>();
      for (const [id, json] of Object.entries(teamRaw)) {
        const t = JSON.parse(json) as { name: string; shortName: string };
        teamById.set(Number(id), { name: t.name, shortName: t.shortName });
      }
      const byTeam = buildFixturesByTeam([...teamById.keys()], fixtures, teamById);
      const teamPattern = `FixturesByTeam:${activeSeason}:*`;
      const staleTeamKeys = await scanKeys(redis, teamPattern);
      const teamPipeline = redis.pipeline();
      for (const key of staleTeamKeys) {
        teamPipeline.del(key);
      }
      for (const [teamId, eventMap] of byTeam) {
        const teamKey = `FixturesByTeam:${activeSeason}:${teamId}`;
        const fields: Record<string, string> = {};
        for (const [eventId, teamFixture] of eventMap) {
          fields[eventId.toString()] = JSON.stringify(teamFixture);
        }
        if (Object.keys(fields).length > 0) {
          teamPipeline.hset(teamKey, fields);
        }
      }
      await teamPipeline.exec();
      await finalizeSeasonCacheWrite(activeSeason, ['Fixtures', 'FixturesByTeam']);

      logDebug('Fixtures cache updated (all events + teams)', {
        count: fixtures.length,
        scheduled: fixtures.length - unscheduled.length,
        unscheduled: unscheduled.length,
        events: fixturesByEvent.size,
        teams: byTeam.size,
        season: activeSeason,
      });
    } catch (error) {
      logError('Fixtures cache set error', error);
      throw error;
    }
  },

  async clear(): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = await getActiveCacheSeason();
      const pattern = `Fixtures:${season}:*`;
      const keys = await scanKeys(redis, pattern);

      if (keys.length > 0) {
        await redis.del(...keys);
      }

      logDebug('Fixtures cache cleared', { season, keysCleared: keys.length });
    } catch (error) {
      logError('Fixtures cache clear error', error);
      throw error;
    }
  },

  async clearByEvent(eventId: number): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = await getActiveCacheSeason();
      const key = `Fixtures:${season}:${eventId}`;
      await redis.del(key);
      logDebug('Fixtures cache cleared by event', { eventId, season });
    } catch (error) {
      logError('Fixtures cache clear by event error', error, { eventId });
      throw error;
    }
  },

  async clearUnscheduled(): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = await getActiveCacheSeason();
      const key = `Fixtures:${season}:unscheduled`;
      await redis.del(key);
      logDebug('Fixtures cache cleared for unscheduled', { season });
    } catch (error) {
      logError('Fixtures cache clear unscheduled error', error);
      throw error;
    }
  },

  async setByTeam(teamId: number, teamFixtures: TeamFixture[], season?: string): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const activeSeason = season ?? (await getActiveCacheSeason());
      const key = `FixturesByTeam:${activeSeason}:${teamId}`;

      const pipeline = redis.pipeline();
      pipeline.del(key);

      if (teamFixtures.length > 0) {
        const fields: Record<string, string> = {};
        for (const tf of teamFixtures) {
          fields[tf.event.toString()] = JSON.stringify(tf);
        }
        pipeline.hset(key, fields);
      }

      await pipeline.exec();
      await finalizeSeasonCacheWrite(activeSeason, ['FixturesByTeam']);
      logDebug('Fixtures cache updated by team', {
        teamId,
        count: teamFixtures.length,
        season: activeSeason,
      });
    } catch (error) {
      logError('Fixtures cache set by team error', error, { teamId });
      throw error;
    }
  },

  async getByTeam(teamId: number): Promise<TeamFixture[] | null> {
    try {
      const redis = await redisSingleton.getClient();
      const season = await getActiveCacheSeason();
      const key = `FixturesByTeam:${season}:${teamId}`;
      const hash = await redis.hgetall(key);

      if (!hash || Object.keys(hash).length === 0) {
        logDebug('Fixtures cache miss by team', { teamId, season });
        return null;
      }

      const teamFixtures = parseHashValues<TeamFixture>(hash, { key, teamId, season });
      logDebug('Fixtures cache hit by team', { teamId, season, count: teamFixtures.length });
      return teamFixtures;
    } catch (error) {
      logError('Fixtures cache get by team error', error, { teamId });
      return null;
    }
  },

  async clearByTeam(teamId: number): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = await getActiveCacheSeason();
      const key = `FixturesByTeam:${season}:${teamId}`;
      await redis.del(key);
      logDebug('Fixtures cache cleared by team', { teamId, season });
    } catch (error) {
      logError('Fixtures cache clear by team error', error, { teamId });
      throw error;
    }
  },

  async clearAllByTeam(): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = await getActiveCacheSeason();
      const pattern = `FixturesByTeam:${season}:*`;
      const keys = await scanKeys(redis, pattern);

      if (keys.length > 0) {
        await redis.del(...keys);
      }

      logDebug('Fixtures cache cleared (all teams)', { season, keysCleared: keys.length });
    } catch (error) {
      logError('Fixtures cache clear all teams error', error);
      throw error;
    }
  },
};
