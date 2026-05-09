import { eq } from 'drizzle-orm';
import { liveBonusCache, liveFixturesCache } from '../cache/operations';
import { eventLive, players } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import type { EventId, TeamId } from '../types/base.type';
import { logDebug, logError, logInfo } from '../utils/logger';
import { getCurrentEvent } from './events.service';

import type { EventLive } from '../domain/event-lives';
import type { LiveFixturesByTeam } from '../domain/live-fixtures';

interface EventLiveWithTeam extends EventLive {
  teamId: TeamId;
}

/**
 * Build playing map from LiveFixture cache
 * Returns: Map<teamId, againstTeamId> for teams with Playing or Finished fixtures
 */
function buildPlayingMap(liveFixtures: LiveFixturesByTeam | null): Map<TeamId, TeamId> {
  const playingMap = new Map<TeamId, TeamId>();

  if (!liveFixtures) {
    return playingMap;
  }

  for (const [teamIdStr, statusMap] of Object.entries(liveFixtures)) {
    const teamId = Number.parseInt(teamIdStr, 10);
    if (Number.isNaN(teamId)) continue;

    // Get Playing and Finished fixtures
    const playing = statusMap.Playing || [];
    const finished = statusMap.Finished || [];
    const allFixtures = [...playing, ...finished];

    if (allFixtures.length === 0) continue;
    if (playingMap.has(teamId)) continue;

    // Use first fixture to get against team
    const firstFixture = allFixtures[0];
    const againstId = firstFixture.againstId;

    playingMap.set(teamId, againstId);
    playingMap.set(againstId, teamId);
  }

  return playingMap;
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
 * Calculate bonus points for a team based on BPS ranking
 * Returns: Map<elementId, bonus> (3 for top, 2 for second, 1 for third, handling ties)
 */
function calculateBonusPoints(
  teamId: TeamId,
  eventLives: EventLiveWithTeam[],
): Map<number, number> {
  const bonusMap = new Map<number, number>();

  // Filter to only players from this team and sort by BPS descending
  const teamLives = eventLives
    .filter((el) => el.teamId === teamId)
    .filter((el) => (el.bps ?? 0) > 0)
    .sort((a, b) => (b.bps ?? 0) - (a.bps ?? 0));

  if (teamLives.length === 0) {
    return bonusMap;
  }

  let count = 0;
  let bonusValue = 3;

  // Top BPS gets 3 points
  const first = teamLives[0];
  const highestBps = first.bps ?? 0;
  bonusMap.set(first.elementId, bonusValue);
  count += 1;

  // Handle ties for top BPS
  const firstTies = teamLives
    .slice(1)
    .filter((el) => el.elementId !== first.elementId && (el.bps ?? 0) === highestBps);
  for (const tied of firstTies) {
    bonusMap.set(tied.elementId, bonusValue);
    count += 1;
  }

  if (count >= 3) {
    return bonusMap;
  }

  // Second highest BPS gets 2 points
  if (count < 2 && teamLives.length > count) {
    bonusValue = 2;
    const second = teamLives[count];
    const runnerUpBps = second.bps ?? 0;
    bonusMap.set(second.elementId, bonusValue);
    count += 1;

    // Handle ties for second BPS
    const secondTies = teamLives
      .slice(count)
      .filter((el) => el.elementId !== second.elementId && (el.bps ?? 0) === runnerUpBps);
    for (const tied of secondTies) {
      bonusMap.set(tied.elementId, bonusValue);
      count += 1;
    }

    if (count >= 3) {
      return bonusMap;
    }
  }

  // Third highest BPS gets 1 point
  if (teamLives.length > count) {
    bonusValue = 1;
    const third = teamLives[count];
    const secondRunnerUpBps = third.bps ?? 0;
    bonusMap.set(third.elementId, bonusValue);
    count += 1;

    // Handle ties for third BPS
    const thirdTies = teamLives
      .slice(count)
      .filter((el) => el.elementId !== third.elementId && (el.bps ?? 0) === secondRunnerUpBps);
    for (const tied of thirdTies) {
      bonusMap.set(tied.elementId, bonusValue);
    }
  }

  return bonusMap;
}

/**
 * LiveBonus: cache-only sync for bonus point calculations based on BPS rankings.
 *
 * Logic:
 * 1. Get playing fixtures from LiveFixture cache (teams with Playing/Finished fixtures)
 * 2. Get event_live data with teamId (join with players)
 * 3. Filter: skip if minutes <= 0, skip if team not playing, skip teams with bonus > 0
 * 4. Group event lives by team and calculate bonus points (top 3 BPS get 3/2/1 points)
 * 5. Cache: LiveBonus:{season}:{eventId} -> hash teamId -> {elementId: bonus} JSON
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

    // 1. Get playing fixtures map
    const liveFixtures = await liveFixturesCache.get(resolvedEventId);
    const playingMap = buildPlayingMap(liveFixtures);

    if (playingMap.size === 0) {
      logDebug('No playing fixtures found, skipping live bonus cache', {
        eventId: resolvedEventId,
      });
      await liveBonusCache.clear(resolvedEventId);
      return { eventId: resolvedEventId, teamCount: 0 };
    }

    // 2. Get event lives with teamId
    const eventLives = await loadEventLivesWithTeam(resolvedEventId);

    // 3. Filter and group event lives by team
    // Track teams that already have bonus assigned by FPL (we'll use those values directly)
    const teamsWithBonusAssigned = new Set<TeamId>();
    const teamEventLiveMap = new Map<TeamId, EventLiveWithTeam[]>();
    // Track bonus values already assigned by FPL (elementId -> bonus)
    const fplAssignedBonus = new Map<number, number>();

    for (const eventLive of eventLives) {
      // Skip if minutes <= 0
      if ((eventLive.minutes ?? 0) <= 0) {
        continue;
      }

      const teamId = eventLive.teamId;
      if (!playingMap.has(teamId)) {
        continue;
      }

      const againstId = playingMap.get(teamId)!;

      // If bonus > 0, FPL has already assigned it - track it and mark teams
      if ((eventLive.bonus ?? 0) > 0) {
        const bonus = eventLive.bonus ?? 0;
        fplAssignedBonus.set(eventLive.elementId, bonus);
        // Mark both teams as having bonus already assigned
        teamsWithBonusAssigned.add(teamId);
        teamsWithBonusAssigned.add(againstId);
        // Still add to teamEventLiveMap for reference, but we'll use FPL values instead of calculating
      }

      // Add to home team's list
      const homeList = teamEventLiveMap.get(teamId) || [];
      homeList.push(eventLive);
      teamEventLiveMap.set(teamId, homeList);

      // Add to away team's list
      const awayList = teamEventLiveMap.get(againstId) || [];
      awayList.push(eventLive);
      teamEventLiveMap.set(againstId, awayList);
    }

    // 4. Build bonus cache: use FPL-assigned values if available, otherwise calculate from BPS
    const byTeam: Record<string, Record<string, number>> = {};

    for (const [teamId, teamLives] of teamEventLiveMap.entries()) {
      const bonusObj: Record<string, number> = {};

      if (teamsWithBonusAssigned.has(teamId)) {
        // Use FPL-assigned bonus values for players from this team
        for (const eventLive of teamLives) {
          if (eventLive.teamId === teamId && (eventLive.bonus ?? 0) > 0) {
            bonusObj[eventLive.elementId.toString()] = eventLive.bonus ?? 0;
          }
        }
      } else {
        // Calculate bonus points based on BPS ranking
        const bonusMap = calculateBonusPoints(teamId, teamLives);
        for (const [elementId, bonus] of bonusMap.entries()) {
          bonusObj[elementId.toString()] = bonus;
        }
      }

      // Only add to cache if there are bonus points
      if (Object.keys(bonusObj).length > 0) {
        byTeam[teamId.toString()] = bonusObj;
      }
    }

    // 5. Cache the results
    await liveBonusCache.set(resolvedEventId, byTeam);

    const teamCount = Object.keys(byTeam).length;
    logInfo('Live bonus cache sync completed', { eventId: resolvedEventId, teamCount });
    return { eventId: resolvedEventId, teamCount };
  } catch (error) {
    logError('Live bonus cache sync failed', error, { eventId });
    throw error;
  }
}
