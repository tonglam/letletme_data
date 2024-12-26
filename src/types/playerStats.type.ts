import { Either, left, right } from 'fp-ts/Either';
import { z } from 'zod';

// ============ Schemas ============
/**
 * API Response Schema - Validates external API data (snake_case)
 */
export const PlayerStatResponseSchema = z.object({
  element: z.number(),
  event: z.number(),
  team: z.number(),

  // Performance metrics
  form: z.number().nullable(),
  influence: z.number().nullable(),
  creativity: z.number().nullable(),
  threat: z.number().nullable(),
  ict_index: z.number().nullable(),
  expected_goals: z.number().nullable(),
  expected_assists: z.number().nullable(),
  expected_goal_involvements: z.number().nullable(),
  expected_goals_conceded: z.number().nullable(),

  // Match statistics
  minutes: z.number().nullable(),
  goals_scored: z.number().nullable(),
  assists: z.number().nullable(),
  clean_sheets: z.number().nullable(),
  goals_conceded: z.number().nullable(),
  own_goals: z.number().nullable(),
  penalties_saved: z.number().nullable(),

  // Additional statistics
  yellow_cards: z.number().nullable().default(0),
  red_cards: z.number().nullable().default(0),
  saves: z.number().nullable().default(0),
  bonus: z.number().nullable().default(0),
  bps: z.number().nullable().default(0),
  starts: z.number().nullable().default(0),

  // Rank statistics
  influence_rank: z.number().nullable(),
  influence_rank_type: z.number().nullable(),
  creativity_rank: z.number().nullable(),
  creativity_rank_type: z.number().nullable(),
  threat_rank: z.number().nullable(),
  threat_rank_type: z.number().nullable(),
  ict_index_rank: z.number().nullable(),
  ict_index_rank_type: z.number().nullable(),

  // Per 90 statistics
  expected_goals_per_90: z.number().nullable(),
  saves_per_90: z.number().nullable(),
  expected_assists_per_90: z.number().nullable(),
  expected_goal_involvements_per_90: z.number().nullable(),
  expected_goals_conceded_per_90: z.number().nullable(),
  goals_conceded_per_90: z.number().nullable(),
  starts_per_90: z.number().nullable(),
  clean_sheets_per_90: z.number().nullable(),

  // Set piece info
  corners_and_indirect_freekicks_order: z.number().nullable(),
  corners_and_indirect_freekicks_text: z.string().nullable(),
  direct_freekicks_order: z.number().nullable(),
  direct_freekicks_text: z.string().nullable(),
  penalties_order: z.number().nullable(),
  penalties_text: z.string().nullable(),
});

/**
 * Domain Schema - Internal application model (camelCase)
 */
export const PlayerStatSchema = z.object({
  elementId: z.number(),
  eventId: z.number(),
  teamId: z.number(),

  // Performance metrics
  form: z.number().nullable(),
  influence: z.number().nullable(),
  creativity: z.number().nullable(),
  threat: z.number().nullable(),
  ictIndex: z.number().nullable(),
  expectedGoals: z.number().nullable(),
  expectedAssists: z.number().nullable(),
  expectedGoalInvolvements: z.number().nullable(),
  expectedGoalsConceded: z.number().nullable(),

  // Match statistics
  minutes: z.number().nullable(),
  goalsScored: z.number().nullable(),
  assists: z.number().nullable(),
  cleanSheets: z.number().nullable(),
  goalsConceded: z.number().nullable(),
  ownGoals: z.number().nullable(),
  penaltiesSaved: z.number().nullable(),

  // Additional statistics
  yellowCards: z.number().nullable().default(0),
  redCards: z.number().nullable().default(0),
  saves: z.number().nullable().default(0),
  bonus: z.number().nullable().default(0),
  bps: z.number().nullable().default(0),
  starts: z.number().nullable().default(0),

  // Rank statistics
  influenceRank: z.number().nullable(),
  influenceRankType: z.number().nullable(),
  creativityRank: z.number().nullable(),
  creativityRankType: z.number().nullable(),
  threatRank: z.number().nullable(),
  threatRankType: z.number().nullable(),
  ictIndexRank: z.number().nullable(),
  ictIndexRankType: z.number().nullable(),

  // Per 90 statistics
  expectedGoalsPer90: z.number().nullable(),
  savesPer90: z.number().nullable(),
  expectedAssistsPer90: z.number().nullable(),
  expectedGoalInvolvementsPer90: z.number().nullable(),
  expectedGoalsConcededPer90: z.number().nullable(),
  goalsConcededPer90: z.number().nullable(),
  startsPer90: z.number().nullable(),
  cleanSheetsPer90: z.number().nullable(),

  // Set piece info
  cornersAndIndirectFreekicksOrder: z.number().nullable(),
  cornersAndIndirectFreekicksText: z.string().nullable(),
  directFreekicksOrder: z.number().nullable(),
  directFreekicksText: z.string().nullable(),
  penaltiesOrder: z.number().nullable(),
  penaltiesText: z.string().nullable(),
});

export const PlayerStatsSchema = z.array(PlayerStatSchema);
export const PlayerStatsResponseSchema = z.array(PlayerStatResponseSchema);

// ============ Types ============
/**
 * API Response types (snake_case)
 */
export type PlayerStatResponse = z.infer<typeof PlayerStatResponseSchema>;
export type PlayerStatsResponse = z.infer<typeof PlayerStatsResponseSchema>;

/**
 * Domain types (camelCase)
 */
export type PlayerStat = z.infer<typeof PlayerStatSchema>;
export type PlayerStats = z.infer<typeof PlayerStatsSchema>;

// ============ Type Transformers ============
/**
 * Transform and validate PlayerStatResponse to PlayerStat
 */
export const toDomainPlayerStat = (raw: PlayerStatResponse): Either<string, PlayerStat> => {
  try {
    const result = PlayerStatSchema.safeParse({
      elementId: raw.element,
      eventId: raw.event,
      teamId: raw.team,

      // Performance metrics
      form: raw.form,
      influence: raw.influence,
      creativity: raw.creativity,
      threat: raw.threat,
      ictIndex: raw.ict_index,
      expectedGoals: raw.expected_goals,
      expectedAssists: raw.expected_assists,
      expectedGoalInvolvements: raw.expected_goal_involvements,
      expectedGoalsConceded: raw.expected_goals_conceded,

      // Match statistics
      minutes: raw.minutes,
      goalsScored: raw.goals_scored,
      assists: raw.assists,
      cleanSheets: raw.clean_sheets,
      goalsConceded: raw.goals_conceded,
      ownGoals: raw.own_goals,
      penaltiesSaved: raw.penalties_saved,

      // Additional statistics
      yellowCards: raw.yellow_cards,
      redCards: raw.red_cards,
      saves: raw.saves,
      bonus: raw.bonus,
      bps: raw.bps,
      starts: raw.starts,

      // Rank statistics
      influenceRank: raw.influence_rank,
      influenceRankType: raw.influence_rank_type,
      creativityRank: raw.creativity_rank,
      creativityRankType: raw.creativity_rank_type,
      threatRank: raw.threat_rank,
      threatRankType: raw.threat_rank_type,
      ictIndexRank: raw.ict_index_rank,
      ictIndexRankType: raw.ict_index_rank_type,

      // Per 90 statistics
      expectedGoalsPer90: raw.expected_goals_per_90,
      savesPer90: raw.saves_per_90,
      expectedAssistsPer90: raw.expected_assists_per_90,
      expectedGoalInvolvementsPer90: raw.expected_goal_involvements_per_90,
      expectedGoalsConcededPer90: raw.expected_goals_conceded_per_90,
      goalsConcededPer90: raw.goals_conceded_per_90,
      startsPer90: raw.starts_per_90,
      cleanSheetsPer90: raw.clean_sheets_per_90,

      // Set piece info
      cornersAndIndirectFreekicksOrder: raw.corners_and_indirect_freekicks_order,
      cornersAndIndirectFreekicksText: raw.corners_and_indirect_freekicks_text,
      directFreekicksOrder: raw.direct_freekicks_order,
      directFreekicksText: raw.direct_freekicks_text,
      penaltiesOrder: raw.penalties_order,
      penaltiesText: raw.penalties_text,
    });

    return result.success
      ? right(result.data)
      : left(`Invalid player stat domain model: ${result.error.message}`);
  } catch (error) {
    return left(
      `Failed to transform player stat data: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

/**
 * Transform array of PlayerStatResponse to PlayerStats
 */
export const toDomainPlayerStats = (
  responses: PlayerStatsResponse,
): Either<string, PlayerStats> => {
  try {
    const stats = responses.map((response) => {
      const result = toDomainPlayerStat(response);
      if (result._tag === 'Left') {
        throw new Error(result.left);
      }
      return result.right;
    });
    return right(stats);
  } catch (error) {
    return left(
      `Failed to transform player stats data: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
