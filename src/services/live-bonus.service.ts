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

interface EventLiveWithTeam extends EventLive {
  teamId: TeamId;
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

    if (matches.length === 0) {
      logDebug('No playing fixtures found, skipping live bonus cache', {
        eventId: resolvedEventId,
      });
      await Promise.all([
        liveBonusCache.clear(resolvedEventId),
        liveBonusV2Cache.clear(resolvedEventId),
      ]);
      return { eventId: resolvedEventId, teamCount: 0 };
    }

    // 2. Load aggregate event lives for the legacy contract and fixture-scoped
    // stats for the additive V2 contract.
    const [eventLives, fixtures] = await Promise.all([
      loadEventLivesWithTeam(resolvedEventId),
      fixtureRepository.findByEvent(resolvedEventId),
    ]);

    // 3. Compute bonus per match (combined bucket) and distribute by team
    const bonusByTeam = computeLiveBonusByTeam(matches, eventLives);
    const bonusV2ByTeam = computeFixtureSummedBonusByTeam(fixtures);

    const serialize = (source: Map<TeamId, Map<number, number>>) => {
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
      return result;
    };

    const byTeam = serialize(bonusByTeam);
    const byTeamV2 = serialize(bonusV2ByTeam);

    // 4. Write both contracts. GraphQL controls its read cutover independently.
    await Promise.all([
      liveBonusCache.set(resolvedEventId, byTeam),
      liveBonusV2Cache.set(resolvedEventId, byTeamV2),
    ]);

    const teamCount = Object.keys(byTeam).length;
    logInfo('Live bonus cache sync completed', {
      eventId: resolvedEventId,
      teamCount,
      v2TeamCount: Object.keys(byTeamV2).length,
    });
    return { eventId: resolvedEventId, teamCount };
  } catch (error) {
    logError('Live bonus cache sync failed', error, { eventId });
    throw error;
  }
}
