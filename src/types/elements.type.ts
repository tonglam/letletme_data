import { ElementStatus } from './base.type';

// ============ Types ============
/**
 * API Response types (snake_case)
 */
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