import type { PlayerStat, RawPlayerStat } from '../domain/player-stats';
import { validatePlayerStat, validateRawPlayerStat } from '../domain/player-stats';
import type { RawFPLElement } from '../types';
import type { EventId } from '../types/base.type';
import { ELEMENT_TYPE_MAP } from '../types/base.type';
import { logError, logInfo } from '../utils/logger';

// ================================
// Data Transformation Functions
// ================================

/**
 * Transform FPL API element to PlayerStat for a specific event
 * Includes validation and error handling
 */
export function transformPlayerStat(
  rawElement: RawFPLElement,
  eventId: EventId,
  teamsMap: Map<number, { name: string; shortName: string }>,
): PlayerStat {
  try {
    // Get team info from map
    const teamInfo = teamsMap.get(rawElement.team);
    if (!teamInfo) {
      throw new Error(`Team not found for ID: ${rawElement.team}`);
    }

    // Transform to domain model
    const playerStat: PlayerStat = {
      eventId,
      elementId: rawElement.id,
      webName: rawElement.web_name,
      elementType: rawElement.element_type as 1 | 2 | 3 | 4,
      elementTypeName: ELEMENT_TYPE_MAP[rawElement.element_type as 1 | 2 | 3 | 4],
      teamId: rawElement.team,
      teamName: teamInfo.name,
      teamShortName: teamInfo.shortName,
      value: rawElement.now_cost,
      totalPoints: rawElement.total_points,
      form: rawElement.form || null,
      influence: rawElement.influence || null,
      creativity: rawElement.creativity || null,
      threat: rawElement.threat || null,
      ictIndex: rawElement.ict_index || null,
      expectedGoals: rawElement.expected_goals || null,
      expectedAssists: rawElement.expected_assists || null,
      expectedGoalInvolvements: rawElement.expected_goal_involvements || null,
      expectedGoalsConceded: rawElement.expected_goals_conceded || null,
      minutes: rawElement.minutes,
      goalsScored: rawElement.goals_scored,
      assists: rawElement.assists,
      cleanSheets: rawElement.clean_sheets,
      goalsConceded: rawElement.goals_conceded,
      ownGoals: rawElement.own_goals,
      penaltiesSaved: rawElement.penalties_saved,
      yellowCards: rawElement.yellow_cards,
      redCards: rawElement.red_cards,
      saves: rawElement.saves,
      bonus: rawElement.bonus,
      bps: rawElement.bps,
      starts: null, // Not available in FPL API bootstrap-static
      influenceRank: null, // Ranking data not available in bootstrap-static
      influenceRankType: null,
      creativityRank: null,
      creativityRankType: null,
      threatRank: null,
      threatRankType: null,
      ictIndexRank: null,
      ictIndexRankType: null,
      mngWin: null, // Manager data not available in bootstrap-static
      mngDraw: null,
      mngLoss: null,
      mngUnderdogWin: null,
      mngUnderdogDraw: null,
      mngCleanSheets: null,
      mngGoalsScored: null,
    };

    // Validate the transformed player stat
    return validatePlayerStat(playerStat);
  } catch (error) {
    logError('Failed to transform player stat', error, { rawElement, eventId });
    throw new Error(
      `Failed to transform player stat data: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Transform raw player stat data (without computed fields)
 */
export function transformRawPlayerStat(rawElement: RawFPLElement, eventId: EventId): RawPlayerStat {
  try {
    const rawPlayerStat: RawPlayerStat = {
      eventId,
      elementId: rawElement.id,
      elementType: rawElement.element_type as 1 | 2 | 3 | 4,
      totalPoints: rawElement.total_points,
      form: rawElement.form || null,
      influence: rawElement.influence || null,
      creativity: rawElement.creativity || null,
      threat: rawElement.threat || null,
      ictIndex: rawElement.ict_index || null,
      expectedGoals: rawElement.expected_goals || null,
      expectedAssists: rawElement.expected_assists || null,
      expectedGoalInvolvements: rawElement.expected_goal_involvements || null,
      expectedGoalsConceded: rawElement.expected_goals_conceded || null,
      minutes: rawElement.minutes,
      goalsScored: rawElement.goals_scored,
      assists: rawElement.assists,
      cleanSheets: rawElement.clean_sheets,
      goalsConceded: rawElement.goals_conceded,
      ownGoals: rawElement.own_goals,
      penaltiesSaved: rawElement.penalties_saved,
      yellowCards: rawElement.yellow_cards,
      redCards: rawElement.red_cards,
      saves: rawElement.saves,
      bonus: rawElement.bonus,
      bps: rawElement.bps,
      starts: null,
      influenceRank: null,
      influenceRankType: null,
      creativityRank: null,
      creativityRankType: null,
      threatRank: null,
      threatRankType: null,
      ictIndexRank: null,
      ictIndexRankType: null,
      mngWin: null,
      mngDraw: null,
      mngLoss: null,
      mngUnderdogWin: null,
      mngUnderdogDraw: null,
      mngCleanSheets: null,
      mngGoalsScored: null,
    };

    return validateRawPlayerStat(rawPlayerStat);
  } catch (error) {
    logError('Failed to transform raw player stat', error, { rawElement, eventId });
    throw new Error(
      `Failed to transform raw player stat data: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Transform array of player stats with error handling for individual items
 * Returns only successfully transformed player stats and logs errors for failed ones
 */
export function transformPlayerStats(
  rawElements: RawFPLElement[],
  eventId: EventId,
  teamsMap: Map<number, { name: string; shortName: string }>,
): PlayerStat[] {
  const transformedPlayerStats: PlayerStat[] = [];
  const errors: Array<{ index: number; error: Error }> = [];

  for (let i = 0; i < rawElements.length; i++) {
    try {
      const transformedPlayerStat = transformPlayerStat(rawElements[i], eventId, teamsMap);
      transformedPlayerStats.push(transformedPlayerStat);
    } catch (error) {
      errors.push({
        index: i,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  if (errors.length > 0) {
    logError('Some player stats failed to transform', new Error('Transform errors'), {
      totalCount: rawElements.length,
      successCount: transformedPlayerStats.length,
      errorCount: errors.length,
      eventId,
      errors: errors.map((e) => ({ index: e.index, message: e.error.message })),
    });
  }

  logInfo('Player stats transformation completed', {
    totalCount: rawElements.length,
    successCount: transformedPlayerStats.length,
    errorCount: errors.length,
    eventId,
  });

  return transformedPlayerStats;
}

/**
 * Transform player stats with strict validation (throws on any error)
 * Use this when you need all player stats to be valid or fail completely
 */
export function transformPlayerStatsStrict(
  rawElements: RawFPLElement[],
  eventId: EventId,
  teamsMap: Map<number, { name: string; shortName: string }>,
): PlayerStat[] {
  return rawElements.map((rawElement, index) => {
    try {
      return transformPlayerStat(rawElement, eventId, teamsMap);
    } catch (error) {
      throw new Error(
        `Failed to transform player stat at index ${index}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      );
    }
  });
}

/**
 * Transform single player stat without throwing errors
 * Returns null if transformation fails
 */
export function safeTransformPlayerStat(
  rawElement: RawFPLElement,
  eventId: EventId,
  teamsMap: Map<number, { name: string; shortName: string }>,
): PlayerStat | null {
  try {
    return transformPlayerStat(rawElement, eventId, teamsMap);
  } catch (error) {
    logError('Safe transform player stat failed', error, { rawElement, eventId });
    return null;
  }
}

// ================================
// Helper Functions
// ================================

/**
 * Create teams map from array of team data for efficient lookups during transformation
 */
export function createTeamsMap(
  teams: Array<{ id: number; name: string; shortName: string }>,
): Map<number, { name: string; shortName: string }> {
  const teamsMap = new Map<number, { name: string; shortName: string }>();

  for (const team of teams) {
    teamsMap.set(team.id, {
      name: team.name,
      shortName: team.shortName,
    });
  }

  return teamsMap;
}

/**
 * Transform current gameweek player stats from FPL bootstrap response
 */
export function transformCurrentGameweekPlayerStats(fplBootstrapResponse: {
  elements: RawFPLElement[];
  events: Array<{ id: number; is_current: boolean }>;
  teams: Array<{ id: number; name: string; short_name: string }>;
}): PlayerStat[] {
  const currentEvent = fplBootstrapResponse.events.find((event) => event.is_current);
  if (!currentEvent) {
    throw new Error('No current event found in FPL bootstrap response');
  }

  const teamsMap = createTeamsMap(
    fplBootstrapResponse.teams.map((team) => ({
      id: team.id,
      name: team.name,
      shortName: team.short_name,
    })),
  );

  return transformPlayerStats(fplBootstrapResponse.elements, currentEvent.id, teamsMap);
}

/**
 * Extract unique player IDs from transformed player stats
 */
export function extractPlayerIds(playerStats: PlayerStat[]): number[] {
  return [...new Set(playerStats.map((stat) => stat.elementId))];
}

/**
 * Group player stats by position type
 */
export function groupPlayerStatsByPosition(
  playerStats: PlayerStat[],
): Record<string, PlayerStat[]> {
  const grouped: Record<string, PlayerStat[]> = {
    GKP: [],
    DEF: [],
    MID: [],
    FWD: [],
  };

  for (const stat of playerStats) {
    grouped[stat.elementTypeName].push(stat);
  }

  return grouped;
}

/**
 * Group player stats by team
 */
export function groupPlayerStatsByTeam(playerStats: PlayerStat[]): Record<number, PlayerStat[]> {
  const grouped: Record<number, PlayerStat[]> = {};

  for (const stat of playerStats) {
    if (!grouped[stat.teamId]) {
      grouped[stat.teamId] = [];
    }
    grouped[stat.teamId].push(stat);
  }

  return grouped;
}
