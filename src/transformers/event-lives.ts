import type { EventLive } from '../domain/event-lives';
import type { RawFPLEventLiveElement } from '../types';

/**
 * Transform a single FPL Event Live Element to domain EventLive
 */
export function transformEventLive(eventId: number, rawElement: RawFPLEventLiveElement): EventLive {
  const stats = rawElement.stats;

  return {
    eventId,
    elementId: rawElement.id,
    minutes: stats.minutes,
    goalsScored: stats.goals_scored,
    assists: stats.assists,
    cleanSheets: stats.clean_sheets,
    goalsConceded: stats.goals_conceded,
    ownGoals: stats.own_goals,
    penaltiesSaved: stats.penalties_saved,
    penaltiesMissed: stats.penalties_missed,
    yellowCards: stats.yellow_cards,
    redCards: stats.red_cards,
    saves: stats.saves,
    bonus: stats.bonus,
    bps: stats.bps,
    starts: stats.starts > 0,
    expectedGoals: stats.expected_goals,
    expectedAssists: stats.expected_assists,
    expectedGoalInvolvements: stats.expected_goal_involvements,
    expectedGoalsConceded: stats.expected_goals_conceded,
    inDreamTeam: stats.in_dreamteam,
    totalPoints: stats.total_points,
    createdAt: null,
  };
}

/**
 * Transform array of FPL Event Live Elements to domain EventLives
 */
export function transformEventLives(
  eventId: number,
  rawElements: RawFPLEventLiveElement[],
): EventLive[] {
  return rawElements.map((element) => transformEventLive(eventId, element));
}
