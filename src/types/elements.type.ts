import { z } from 'zod';
import { ElementStatus } from './base.type';

// ============ Types ============
// API response types representing raw data from external API
export const ElementResponseSchema = z.object({
  id: z.number(),
  can_transact: z.boolean(),
  can_select: z.boolean(),
  chance_of_playing_next_round: z.number().nullable(),
  chance_of_playing_this_round: z.number().nullable(),
  code: z.number(),
  cost_change_event: z.number(),
  cost_change_event_fall: z.number(),
  cost_change_start: z.number(),
  cost_change_start_fall: z.number(),
  dreamteam_count: z.number(),
  element_type: z.number(),
  ep_next: z.string().nullable(),
  ep_this: z.string().nullable(),
  event_points: z.number(),
  first_name: z.string(),
  form: z.string().nullable(),
  in_dreamteam: z.boolean(),
  news: z.string(),
  news_added: z.string().nullable(),
  now_cost: z.number(),
  photo: z.string(),
  points_per_game: z.string(),
  removed: z.boolean(),
  second_name: z.string(),
  selected_by_percent: z.string(),
  special: z.boolean(),
  squad_number: z.number().nullable(),
  status: z.nativeEnum(ElementStatus),
  team: z.number(),
  team_code: z.number(),
  total_points: z.number(),
  transfers_in: z.number(),
  transfers_in_event: z.number(),
  transfers_out: z.number(),
  transfers_out_event: z.number(),
  value_form: z.string(),
  value_season: z.string(),
  web_name: z.string(),
  region: z.string().nullable(),
  team_join_date: z.string().nullable(),
  minutes: z.number(),
  goals_scored: z.number(),
  assists: z.number(),
  clean_sheets: z.number(),
  goals_conceded: z.number(),
  own_goals: z.number(),
  penalties_saved: z.number(),
  penalties_missed: z.number(),
  yellow_cards: z.number(),
  red_cards: z.number(),
  saves: z.number(),
  bonus: z.number(),
  bps: z.number(),
  influence: z.string(),
  creativity: z.string(),
  threat: z.string(),
  ict_index: z.string(),
  starts: z.number(),
  expected_goals: z.string(),
  expected_assists: z.string(),
  expected_goal_involvements: z.string(),
  expected_goals_conceded: z.string(),
  influence_rank: z.number().nullable(),
  influence_rank_type: z.number().nullable(),
  creativity_rank: z.number().nullable(),
  creativity_rank_type: z.number().nullable(),
  threat_rank: z.number().nullable(),
  threat_rank_type: z.number().nullable(),
  ict_index_rank: z.number().nullable(),
  ict_index_rank_type: z.number().nullable(),
  corners_and_indirect_freekicks_order: z.number().nullable(),
  corners_and_indirect_freekicks_text: z.string(),
  direct_freekicks_order: z.number().nullable(),
  direct_freekicks_text: z.string(),
  penalties_order: z.number().nullable(),
});

export interface ElementResponse {
  readonly id: number;
  readonly can_transact: boolean;
  readonly can_select: boolean;
  readonly chance_of_playing_next_round: number | null;
  readonly chance_of_playing_this_round: number | null;
  readonly code: number;
  readonly cost_change_event: number;
  readonly cost_change_event_fall: number;
  readonly cost_change_start: number;
  readonly cost_change_start_fall: number;
  readonly dreamteam_count: number;
  readonly element_type: number;
  readonly ep_next: string | null;
  readonly ep_this: string | null;
  readonly event_points: number;
  readonly first_name: string;
  readonly form: string | null;
  readonly in_dreamteam: boolean;
  readonly news: string;
  readonly news_added: string | null;
  readonly now_cost: number;
  readonly photo: string;
  readonly points_per_game: string;
  readonly removed: boolean;
  readonly second_name: string;
  readonly selected_by_percent: string;
  readonly special: boolean;
  readonly squad_number: number | null;
  readonly status: ElementStatus;
  readonly team: number;
  readonly team_code: number;
  readonly total_points: number;
  readonly transfers_in: number;
  readonly transfers_in_event: number;
  readonly transfers_out: number;
  readonly transfers_out_event: number;
  readonly value_form: string;
  readonly value_season: string;
  readonly web_name: string;
  readonly region: string | null;
  readonly team_join_date: string | null;
  readonly minutes: number;
  readonly goals_scored: number;
  readonly assists: number;
  readonly clean_sheets: number;
  readonly goals_conceded: number;
  readonly own_goals: number;
  readonly penalties_saved: number;
  readonly penalties_missed: number;
  readonly yellow_cards: number;
  readonly red_cards: number;
  readonly saves: number;
  readonly bonus: number;
  readonly bps: number;
  readonly influence: string;
  readonly creativity: string;
  readonly threat: string;
  readonly ict_index: string;
  readonly starts: number;
  readonly expected_goals: string;
  readonly expected_assists: string;
  readonly expected_goal_involvements: string;
  readonly expected_goals_conceded: string;
  readonly influence_rank: number | null;
  readonly influence_rank_type: number | null;
  readonly creativity_rank: number | null;
  readonly creativity_rank_type: number | null;
  readonly threat_rank: number | null;
  readonly threat_rank_type: number | null;
  readonly ict_index_rank: number | null;
  readonly ict_index_rank_type: number | null;
  readonly corners_and_indirect_freekicks_order: number | null;
  readonly corners_and_indirect_freekicks_text: string;
  readonly direct_freekicks_order: number | null;
  readonly direct_freekicks_text: string;
  readonly penalties_order: number | null;
}

export type ElementsResponse = readonly ElementResponse[];
