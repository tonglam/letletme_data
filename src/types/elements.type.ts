import { z } from 'zod';
import { ElementStatus } from './base.type';

// ============ Types ============
// API response types representing raw data from external API
export const ElementResponseSchema = z
  .object({
    // Core fields needed for players.type.ts
    id: z.number(),
    code: z.number(),
    element_type: z.number(),
    first_name: z.string().nullable(),
    second_name: z.string().nullable(),
    web_name: z.string(),
    team: z.number(),
    now_cost: z.number(),
    cost_change_start: z.number(),

    // Fields needed for player-stats.type.ts
    minutes: z.number().default(0),
    goals_scored: z.number().default(0),
    assists: z.number().default(0),
    clean_sheets: z.number().default(0),
    goals_conceded: z.number().default(0),
    own_goals: z.number().default(0),
    penalties_saved: z.number().default(0),
    yellow_cards: z.number().default(0),
    red_cards: z.number().default(0),
    saves: z.number().default(0),
    bonus: z.number().default(0),
    bps: z.number().default(0),
    form: z.string().nullable(),
    influence: z.string().nullable(),
    creativity: z.string().nullable(),
    threat: z.string().nullable(),
    ict_index: z.string().nullable(),
    starts: z.number().default(0),
    expected_goals: z.string().nullable(),
    expected_assists: z.string().nullable(),
    expected_goal_involvements: z.string().nullable(),
    expected_goals_conceded: z.string().nullable(),
    influence_rank: z.number().nullable(),
    influence_rank_type: z.number().nullable(),
    creativity_rank: z.number().nullable(),
    creativity_rank_type: z.number().nullable(),
    threat_rank: z.number().nullable(),
    threat_rank_type: z.number().nullable(),
    ict_index_rank: z.number().nullable(),
    ict_index_rank_type: z.number().nullable(),

    // Other fields from API that we might use
    status: z.nativeEnum(ElementStatus),
    event_points: z.number().default(0),
    team_code: z.number(),
    total_points: z.number().default(0),
    transfers_in: z.number().default(0),
    transfers_out: z.number().default(0),
  })
  .passthrough();

/**
 * Type for element response data from the FPL API
 * Inferred from schema to allow additional fields
 */
export type ElementResponse = z.infer<typeof ElementResponseSchema>;

/**
 * Array of element responses
 */
export type ElementsResponse = readonly ElementResponse[];
