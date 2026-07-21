import { eq } from 'drizzle-orm';
import { liveBonusCache, liveBonusV2Cache, liveFixturesCache } from '../cache/operations';
import { eventLive, players } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import {
  buildPlayingMatches,
  computeFixtureSummedBonusByTeam,
  computeLiveBonusByTeam,
} from '../domain/live-bonus';
import { fixtureRepository } from '../repositories/fixtures';
import type { EventId, TeamId } from '../types/base.type';
import { logDebug, logError, logInfo } from '../utils/logger';
import { getCurrentEvent } from './events.service';

import type { EventLive } from '../domain/event-lives';
import type { LiveBonusByTeam } from '../domain/live-bonus';
import type { Fixture } from '../types';

interface EventLiveWithTeam extends EventLive {
  teamId: TeamId;
}

type LiveBonusV2CacheWriter = {
  set: (eventId: EventId, byTeam: LiveBonusByTeam) => Promise<void>;
};

type FixtureBonusSource = Pick<
  Fixture,
  'finished' | 'finishedProvisional' | 'started' | 'stats' | 'teamA' | 'teamH'
>;

function serializeBonusByTeam(source: Map<TeamId, Map<number, number>>): LiveBonusByTeam {
  const result: Record<string, Record<string, number>> = {};
  for (const [teamId, teamBonus] of source.entries()) {
    const bonusObj: Record<string, number> = {};
    for (const [elementId, bonus] of teamBonus.entries()) {
      bonusObj[elementId.toString()] = bonus;
    }
    if (Object.keys(bonusObj).length > 0) {
      result[teamId.toString()] = bonusObj;
    }
  }
  return result as LiveBonusByTeam;
}

/**
 * Rebuild the fixture-scoped bonus cache from authoritative fixture rows.
 * This path intentionally does not depend on the live-match window: FPL can
 * publish final bonus stats after a fixture has moved to `finished`.
 */
export async function syncLiveBonusV2Cache(
  eventId: EventId,
  options: { fixtures?: readonly FixtureBonusSource[]; cache?: LiveBonusV2CacheWriter } = {},
): Promise<{ eventId: EventId; teamCount: number }> {
  const fixtures = options.fixtures ?? (await fixtureRepository.findByEvent(eventId));
  const byTeam = serializeBonusByTeam(computeFixtureSummedBonusByTeam(fixtures));
  await (options.cache ?? liveBonusV2Cache).set(eventId, byTeam);

  const teamCount = Object.keys(byTeam).length;
  logInfo('Fixture-scoped live bonus cache sync completed', { eventId, teamCount });
  return { eventId, teamCount };
}

/**
 * Load event lives with teamId by joining with players table
 */
async function loadEventLivesWithTeam(eventId: EventId): Promise<EventLiveWithTeam[]> {
  const db = await getDb();
  const result = await db
    .select({
      eventId: eventLive.eventId,
      elementId: eventLive.elementId,
      minutes: eventLive.minutes,
      goalsScored: eventLive.goalsScored,
      assists: eventLive.assists,
      cleanSheets: eventLive.cleanSheets,
      goalsConceded: eventLive.goalsConceded,
      ownGoals: eventLive.ownGoals,
      penaltiesSaved: eventLive.penaltiesSaved,
      penaltiesMissed: eventLive.penaltiesMissed,
      yellowCards: eventLive.yellowCards,
      redCards: eventLive.redCards,
      saves: eventLive.saves,
      bonus: eventLive.bonus,
      bps: eventLive.bps,
      defensiveContribution: eventLive.defensiveContribution,
      starts: eventLive.starts,
      expectedGoals: eventLive.expectedGoals,
      expectedAssists: eventLive.expectedAssists,
      expectedGoalInvolvements: eventLive.expectedGoalInvolvements,
      expectedGoalsConceded: eventLive.expectedGoalsConceded,
      inDreamTeam: eventLive.inDreamTeam,
      totalPoints: eventLive.totalPoints,
      createdAt: eventLive.createdAt,
      teamId: players.teamId,
    })
    .from(eventLive)
    .innerJoin(players, eq(eventLive.elementId, players.id))
    .where(eq(eventLive.eventId, eventId));

  return result.map((row) => ({
    eventId: row.eventId,
    elementId: row.elementId,
    minutes: row.minutes,
    goalsScored: row.goalsScored,
    assists: row.assists,
    cleanSheets: row.cleanSheets,
    goalsConceded: row.goalsConceded,
    ownGoals: row.ownGoals,
    penaltiesSaved: row.penaltiesSaved,
    penaltiesMissed: row.penaltiesMissed,
    yellowCards: row.yellowCards,
    redCards: row.redCards,
    saves: row.saves,
    bonus: row.bonus,
    bps: row.bps,
    defensiveContribution: row.defensiveContribution,
    starts: row.starts,
    expectedGoals: row.expectedGoals,
    expectedAssists: row.expectedAssists,
    expectedGoalInvolvements: row.expectedGoalInvolvements,
    expectedGoalsConceded: row.expectedGoalsConceded,
    inDreamTeam: row.inDreamTeam,
    totalPoints: row.totalPoints,
    createdAt: row.createdAt,
    teamId: row.teamId,
  }));
}

/**
 * LiveBonus: cache-only sync for bonus point calculations based on BPS rankings.
 *
 * Logic:
 * 1. Get playing fixtures from LiveFixture cache (Playing/Finished), one match per fixture
 * 2. Get event_live data with teamId (join with players)
 * 3. Per match, rank the combined bucket (both teams, minutes > 0) by BPS and
 *    award 3/2/1 — max 6 bonus points per match, matching FPL; when FPL has
 *    already assigned bonus for a match, those values are used directly
 * 4. Cache: LiveBonus:{season}:{eventId} -> hash teamId -> {elementId: bonus} JSON
 */
export async function syncLiveBonusCache(
  eventId?: EventId,
): Promise<{ eventId: EventId; teamCount: number }> {
  try {
    const resolvedEventId = eventId ?? (await getCurrentEvent())?.id;
    if (!resolvedEventId) {
      throw new Error('No current event found for live bonus cache');
    }

    logInfo('Starting live bonus cache sync', { eventId: resolvedEventId });

    // 1. Get unique playing matches (per fixture, DGW-safe)
    const liveFixtures = await liveFixturesCache.get(resolvedEventId);
    const matches = buildPlayingMatches(liveFixtures);

    // V2 is derived from persisted fixture stats and must still refresh after
    // the live window closes, when FPL may publish settled bonus values.
    const v2Result = await syncLiveBonusV2Cache(resolvedEventId);

    if (matches.length === 0) {
      logDebug('No playing fixtures found, skipping live bonus cache', {
        eventId: resolvedEventId,
      });
      await liveBonusCache.clear(resolvedEventId);
      return { eventId: resolvedEventId, teamCount: 0 };
    }

    // 2. Load aggregate event lives for the legacy contract.
    const eventLives = await loadEventLivesWithTeam(resolvedEventId);

    // 3. Compute bonus per match (combined bucket) and distribute by team
    const bonusByTeam = computeLiveBonusByTeam(matches, eventLives);
    const byTeam = serializeBonusByTeam(bonusByTeam);

    // 4. V2 was written above; keep the legacy contract available until the
    // GraphQL read cutover is complete.
    await liveBonusCache.set(resolvedEventId, byTeam);

    const teamCount = Object.keys(byTeam).length;
    logInfo('Live bonus cache sync completed', {
      eventId: resolvedEventId,
      teamCount,
      v2TeamCount: v2Result.teamCount,
    });
    return { eventId: resolvedEventId, teamCount };
  } catch (error) {
    logError('Live bonus cache sync failed', error, { eventId });
    throw error;
  }
}
